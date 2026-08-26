package dev.aurora.tauri.nativeplugin

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

private const val LOCAL_DATA_SECURE_PREFS = "aurora_secure_storage"
private const val LOCAL_DATA_KEY_PREFIX = "aurora_local_data_envelope_v1_"
private const val LOCAL_DATA_CURRENT_VERSION_PREFIX = "aurora_local_data_envelope_current_v1_"
private const val LOCAL_DATA_ALGORITHM = "AES-GCM-256"
private const val LOCAL_DATA_KEY_PURPOSE = "local-structured-data"
private const val LOCAL_DATA_KEYSTORE = "AndroidKeyStore"
private const val LOCAL_DATA_TRANSFORMATION = "AES/GCM/NoPadding"
private const val LOCAL_DATA_TAG_BITS = 128
private const val LOCAL_DATA_MAX_ID_BYTES = 256
private val LOCAL_DATA_ID_PATTERN = Regex("[A-Za-z0-9_.:@/\\-]+")

internal data class AuroraNativeLocalDataScope(
    val profileId: String,
    val localNodeId: String,
)

internal object AuroraNativeLocalDataContext {
    fun activeScope(context: Context): AuroraNativeLocalDataScope? {
        val raw = context.getSharedPreferences("aurora_thin_profile", Context.MODE_PRIVATE)
            .getString("aurora.session.android-thin-connection-profile.v1", null)
            ?: return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val activeProfileId = root.optString("activeProfileId", "").takeIf { it.isNotBlank() }
        val profile = activeProfileId?.let { profileId ->
            root.optJSONObject("profiles")?.optJSONObject(profileId)
                ?: root.optJSONArray("profiles")?.let { profiles ->
                    (0 until profiles.length())
                        .mapNotNull { index -> profiles.optJSONObject(index) }
                        .firstOrNull { item -> item.optString("id") == profileId }
                }
        } ?: root.optJSONObject("activeProfile")
            ?: root.optJSONObject("profile")
            ?: return null
        val profileId = profile.optString("id", activeProfileId.orEmpty()).trim()
        val localNodeId = profile.optJSONObject("localNode")
            ?.optString("stablePeerId", "")
            ?.trim()
            .orEmpty()
        if (profileId.isEmpty() || localNodeId.isEmpty()) return null
        return runCatching {
            validateId("profileId", profileId)
            validateId("localNodeId", localNodeId)
            AuroraNativeLocalDataScope(profileId, localNodeId)
        }.getOrNull()
    }

    fun newConversationId(): String = "voice-${UUID.randomUUID()}"

    fun newMessageId(role: String): String = "voice-$role-${UUID.randomUUID()}"
}

internal object AuroraLocalDataEnvelopeCrypto {
    fun encrypt(
        context: Context,
        keyPurpose: String,
        profileId: String,
        localNodeId: String,
        plaintext: ByteArray,
        aad: ByteArray,
    ): JSONObject {
        validateScope(keyPurpose, profileId, localNodeId)
        val keyVersion = currentKeyVersion(context, profileId, localNodeId, keyPurpose)
        val keyId = keyId(profileId, localNodeId, keyPurpose, keyVersion)
        val cipher = Cipher.getInstance(LOCAL_DATA_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key(context, keyId))
        cipher.updateAAD(aad)
        val ciphertextAndTag = cipher.doFinal(plaintext)
        return JSONObject()
            .put("version", 1)
            .put("algorithm", LOCAL_DATA_ALGORITHM)
            .put("keyId", keyId)
            .put("nonceB64Url", base64UrlEncode(cipher.iv))
            .put("ciphertextAndTagB64Url", base64UrlEncode(ciphertextAndTag))
            .put("createdAtMs", System.currentTimeMillis().coerceAtLeast(0L))
    }

    fun decrypt(
        context: Context,
        profileId: String,
        localNodeId: String,
        envelope: JSONObject,
        aad: ByteArray,
    ): ByteArray {
        validateEnvelope(envelope)
        validateBinding(profileId, localNodeId, envelope.getString("keyId"))
        val cipher = Cipher.getInstance(LOCAL_DATA_TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(context, envelope.getString("keyId")),
            GCMParameterSpec(LOCAL_DATA_TAG_BITS, base64UrlDecode(envelope.getString("nonceB64Url"))),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(base64UrlDecode(envelope.getString("ciphertextAndTagB64Url")))
    }

    fun rotate(
        context: Context,
        keyPurpose: String,
        profileId: String,
        localNodeId: String,
    ): Pair<String, String> {
        validateScope(keyPurpose, profileId, localNodeId)
        val previousVersion = currentKeyVersion(context, profileId, localNodeId, keyPurpose)
        val previousKeyId = keyId(profileId, localNodeId, keyPurpose, previousVersion)
        val newVersion = previousVersion + 1
        val newKeyId = keyId(profileId, localNodeId, keyPurpose, newVersion)
        key(context, newKeyId)
        context.getSharedPreferences(LOCAL_DATA_SECURE_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(currentVersionKey(profileId, localNodeId, keyPurpose), newVersion)
            .apply()
        return previousKeyId to newKeyId
    }

    fun encryptMessageText(
        context: Context,
        scope: AuroraNativeLocalDataScope,
        messageId: String,
        text: String,
    ): JSONObject = encrypt(
        context = context,
        keyPurpose = LOCAL_DATA_KEY_PURPOSE,
        profileId = scope.profileId,
        localNodeId = scope.localNodeId,
        plaintext = text.toByteArray(Charsets.UTF_8),
        aad = messageContentAad(scope, messageId),
    )

    private fun messageContentAad(scope: AuroraNativeLocalDataScope, messageId: String): ByteArray {
        validateId("messageId", messageId)
        val aad = "{\"envelopeVersion\":1,\"field\":\"content_envelope_json\",\"localNodeId\":" +
            JSONObject.quote(scope.localNodeId) +
            ",\"profileId\":" + JSONObject.quote(scope.profileId) +
            ",\"recordId\":" + JSONObject.quote(messageId) +
            ",\"table\":\"aurora_messages\"}"
        return aad.toByteArray(Charsets.UTF_8)
    }

    private fun key(context: Context, keyId: String): SecretKey {
        validateKeyId(keyId)
        val alias = LOCAL_DATA_KEY_PREFIX + sha256Hex(keyId.toByteArray(Charsets.UTF_8))
        val keyStore = KeyStore.getInstance(LOCAL_DATA_KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, LOCAL_DATA_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun currentKeyVersion(
        context: Context,
        profileId: String,
        localNodeId: String,
        purpose: String,
    ): Int = context.getSharedPreferences(LOCAL_DATA_SECURE_PREFS, Context.MODE_PRIVATE)
        .getInt(currentVersionKey(profileId, localNodeId, purpose), 1)

    private fun currentVersionKey(profileId: String, localNodeId: String, purpose: String): String =
        LOCAL_DATA_CURRENT_VERSION_PREFIX +
            sha256Hex("$profileId\u0000$localNodeId\u0000$purpose".toByteArray(Charsets.UTF_8))

    private fun keyId(profileId: String, localNodeId: String, purpose: String, version: Int): String =
        "aurora.local-data-envelope.v1.${sha256Hex(profileId.toByteArray(Charsets.UTF_8))}." +
            "${sha256Hex(localNodeId.toByteArray(Charsets.UTF_8))}.$purpose.k$version"

    private fun validateScope(purpose: String, profileId: String, localNodeId: String) {
        require(purpose == LOCAL_DATA_KEY_PURPOSE) { "local_data_key_purpose_unsupported" }
        validateId("profileId", profileId)
        validateId("localNodeId", localNodeId)
    }

    private fun validateEnvelope(envelope: JSONObject) {
        require(envelope.optInt("version", 0) == 1) { "local_data_envelope_invalid" }
        require(envelope.optString("algorithm") == LOCAL_DATA_ALGORITHM) { "local_data_envelope_invalid" }
        validateKeyId(envelope.optString("keyId"))
        require(base64UrlDecode(envelope.optString("nonceB64Url")).size == 12) { "local_data_envelope_invalid" }
        require(base64UrlDecode(envelope.optString("ciphertextAndTagB64Url")).size >= 16) { "local_data_envelope_invalid" }
        require(envelope.optLong("createdAtMs", -1L) >= 0L) { "local_data_envelope_invalid" }
    }

    private fun validateBinding(profileId: String, localNodeId: String, keyId: String) {
        validateId("profileId", profileId)
        validateId("localNodeId", localNodeId)
        val expectedPrefix = "aurora.local-data-envelope.v1." +
            "${sha256Hex(profileId.toByteArray(Charsets.UTF_8))}." +
            "${sha256Hex(localNodeId.toByteArray(Charsets.UTF_8))}.$LOCAL_DATA_KEY_PURPOSE.k"
        require(keyId.startsWith(expectedPrefix)) { "local_data_envelope_scope_mismatch" }
        validateKeyId(keyId)
    }

    private fun validateKeyId(keyId: String) {
        require(keyId.length in 1..LOCAL_DATA_MAX_ID_BYTES && LOCAL_DATA_ID_PATTERN.matches(keyId)) {
            "local_data_envelope_key_invalid"
        }
    }

    private fun base64UrlEncode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun base64UrlDecode(value: String): ByteArray {
        require(value.isNotEmpty() && !value.contains('=')) { "local_data_base64url_invalid" }
        val decoded = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        require(base64UrlEncode(decoded) == value) { "local_data_base64url_invalid" }
        return decoded
    }

    private fun sha256Hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
}

internal fun validateId(label: String, value: String) {
    require(
        value.isNotEmpty() &&
            value.toByteArray(Charsets.UTF_8).size <= LOCAL_DATA_MAX_ID_BYTES &&
            LOCAL_DATA_ID_PATTERN.matches(value),
    ) { "local_data_${label}_invalid" }
}
