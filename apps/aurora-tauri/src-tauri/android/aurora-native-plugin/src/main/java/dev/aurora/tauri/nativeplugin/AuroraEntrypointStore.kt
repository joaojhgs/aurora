package dev.aurora.tauri.nativeplugin

import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

object AuroraEntrypointStore {
    private var lastPayload: JSONObject? = null

    fun record(intent: Intent?, source: String): JSONObject {
        val payload = JSONObject()
        payload.put("source", source)
        payload.put("action", intent?.action)
        payload.put("type", intent?.type)
        payload.put("scheme", intent?.data?.scheme)
        payload.put("host", intent?.data?.host)
        payload.put("path", intent?.data?.path)
        payload.put("categories", JSONArray(intent?.categories?.toList()?.sorted() ?: emptyList<String>()))
        payload.put("extras", redactedExtraKeys(intent))
        payload.put("secretsRedacted", true)
        lastPayload = payload
        return payload
    }

    fun lastPayload(): JSONObject {
        return lastPayload ?: JSONObject()
            .put("source", "none")
            .put("action", JSONObject.NULL)
            .put("type", JSONObject.NULL)
            .put("scheme", JSONObject.NULL)
            .put("host", JSONObject.NULL)
            .put("path", JSONObject.NULL)
            .put("categories", JSONArray())
            .put("extras", JSONArray())
            .put("secretsRedacted", true)
    }

    private fun redactedExtraKeys(intent: Intent?): JSONArray {
        val extras = intent?.extras ?: return JSONArray()
        return JSONArray(extras.keySet().sorted())
    }
}
