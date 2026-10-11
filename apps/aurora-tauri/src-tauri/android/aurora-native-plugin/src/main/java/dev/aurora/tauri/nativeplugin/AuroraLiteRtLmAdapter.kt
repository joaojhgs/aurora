package dev.aurora.tauri.nativeplugin

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ToolCall
import com.google.ai.edge.litertlm.tool
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.util.concurrent.CancellationException

/**
 * Small, engine-local adapter for the existing JSON completion contract.
 *
 * AuroraNativePlugin exposes this only through the existing Rust-owned
 * inference host. The caller passes the verified app-private file selected by
 * the trusted catalog; this class never downloads or chooses model files.
 *
 * Call [load], [complete], and [close] from a background executor. LiteRT-LM
 * initializes native state and performs generation synchronously on this API.
 */
internal class AuroraLiteRtLmAdapter : Closeable {
    companion object {
        const val LIBRARY_VERSION = "0.18.0"
        private const val MAX_REQUEST_BYTES = 128 * 1024
        private const val MAX_MESSAGES = 64
        private const val MAX_TOOLS = 32
        private const val MAX_OUTPUT_TOKENS = 1024
        private const val DEFAULT_OUTPUT_TOKENS = 512
        private const val DEFAULT_TEMPERATURE = 0.2
        private const val MAX_TEMPERATURE = 2.0
        private val TOOL_NAME_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
    }

    private val lock = Any()
    private var engine: Engine? = null
    private var loadedModelId: String? = null
    private var activeConversation: Conversation? = null
    private var generating = false
    private var cancelRequested = false

    /** Load a previously verified `.litertlm` file from host-owned storage. */
    fun load(modelId: String, modelFile: File, cacheDirectory: File) = synchronized(lock) {
        require(modelId.isNotBlank()) { "The selected offline model is unavailable." }
        require(modelFile.isFile && modelFile.extension == "litertlm") {
            "The selected offline model is unavailable."
        }
        check(engine == null) { "A LiteRT-LM model is already loaded." }

        val next = Engine(
            EngineConfig(
                modelPath = modelFile.canonicalPath,
                backend = Backend.CPU(),
                cacheDir = cacheDirectory.canonicalPath,
            ),
        )
        try {
            next.initialize()
            engine = next
            loadedModelId = modelId
        } catch (error: Throwable) {
            next.close()
            throw error
        }
    }

    /**
     * Complete one bounded JSON request and return the existing command shape.
     * This pinned chat model has no tool capability; the Rust host rejects
     * tool-bearing requests before they reach this adapter.
     */
    fun complete(request: JSONObject): JSONObject {
        val activeEngine = synchronized(lock) {
            check(!generating) { "Another offline answer is still running." }
            val current = engine
            check(current != null && request.optString("modelId") == loadedModelId) {
                "The selected offline model is unavailable."
            }
            generating = true
            cancelRequested = false
            current
        }
        return try {
            check(request.toString().toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES) {
                "The offline request is too large."
            }
            val modelId = request.getString("modelId")
            check(modelId == synchronized(lock) { loadedModelId }) {
                "The selected offline model is unavailable."
            }
            val messages = request.getJSONArray("messages")
            require(messages.length() in 1..MAX_MESSAGES) { "The offline request is invalid." }

            val history = mutableListOf<Message>()
            val instructions = mutableListOf<String>()
            for (index in 0 until messages.length() - 1) {
                parseMessage(messages.getJSONObject(index), instructions, history)
            }
            val lastMessageJson = messages.getJSONObject(messages.length() - 1)
            require(lastMessageJson.getString("role") != "system") { "The offline request is invalid." }
            val lastMessage = parseMessage(lastMessageJson, instructions, history)
            history.removeAt(history.lastIndex)
            val tools = parseTools(request.optJSONArray("tools") ?: JSONArray())
            val options = request.optJSONObject("options") ?: JSONObject()
            val temperature = options.optDouble("temperature", DEFAULT_TEMPERATURE)
                .coerceIn(0.0, MAX_TEMPERATURE)
            val maxOutputTokens = options.optInt("maxTokens", DEFAULT_OUTPUT_TOKENS)
                .coerceIn(1, MAX_OUTPUT_TOKENS)

            val conversationConfig = ConversationConfig(
                systemInstruction = instructions.takeIf { it.isNotEmpty() }
                    ?.joinToString("\n")
                    ?.let { Contents.of(it) },
                initialMessages = history,
                tools = tools,
                samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = temperature),
                automaticToolCalling = false,
                maxOutputToken = maxOutputTokens,
            )
            activeEngine.createConversation(conversationConfig).use { conversation ->
                synchronized(lock) {
                    activeConversation = conversation
                    if (cancelRequested) throw CancellationException("Offline answer cancelled.")
                }
                try {
                    val response = conversation.sendMessage(lastMessage)
                    check(response.toolCalls.isEmpty()) {
                        "This offline model does not support approved actions."
                    }
                    JSONObject().put("type", "message").put("content", response.toString())
                } finally {
                    synchronized(lock) {
                        if (activeConversation === conversation) activeConversation = null
                    }
                }
            }
        } finally {
            synchronized(lock) {
                activeConversation = null
                generating = false
                cancelRequested = false
            }
        }
    }

    /** Cancel the active LiteRT conversation using its native stop API. */
    fun cancel(): Boolean = synchronized(lock) {
        if (!generating) return false
        cancelRequested = true
        activeConversation?.cancelProcess()
        true
    }

    /** This adapter creates a fresh conversation for each host completion. */
    fun reset(): Boolean = synchronized(lock) {
        check(!generating) { "Another offline answer is still running." }
        true
    }

    override fun close() = synchronized(lock) {
        check(!generating) { "An offline answer is still running." }
        engine?.close()
        engine = null
        loadedModelId = null
    }

    private fun parseMessage(
        message: JSONObject,
        instructions: MutableList<String>,
        history: MutableList<Message>,
    ): Message {
        val role = message.getString("role")
        require(role != "system" || history.isEmpty()) { "The offline request is invalid." }
        val content = message.optString("content")
        return when (role) {
            "system" -> {
                instructions += content
                Message.system(content)
            }
            "user" -> Message.user(content)
            "assistant" -> {
                val calls = message.optJSONArray("tool_calls")
                    ?.let(::parsePriorToolCalls)
                    .orEmpty()
                Message.model(Contents.of(content), toolCalls = calls)
            }
            "tool" -> {
                val name = message.optString("name")
                require(name.isNotBlank()) { "The offline request is invalid." }
                Message.tool(Contents.of(Content.ToolResponse(name, content)))
            }
            else -> throw IllegalArgumentException("The offline request is invalid.")
        }.also { parsed ->
            if (role != "system") history += parsed
        }
    }

    private fun parsePriorToolCalls(calls: JSONArray): List<ToolCall> =
        (0 until calls.length()).map { index ->
            val call = calls.getJSONObject(index)
            val function = call.optJSONObject("function") ?: call
            val rawArguments = function.opt("arguments")
            val arguments = when (rawArguments) {
                is JSONObject -> rawArguments
                is String -> try {
                    JSONObject(rawArguments)
                } catch (_: org.json.JSONException) {
                    throw IllegalArgumentException("The offline request is invalid.")
                }
                else -> throw IllegalArgumentException("The offline request is invalid.")
            }
            ToolCall(
                name = function.getString("name"),
                arguments = jsonObjectToMap(arguments),
            )
        }

    private fun parseTools(declarations: JSONArray) = run {
        require(declarations.length() <= MAX_TOOLS) { "The offline request is invalid." }
        val names = mutableSetOf<String>()
        (0 until declarations.length()).map { index ->
            val declaration = declarations.getJSONObject(index)
            val function = declaration.optJSONObject("function")
                ?: throw IllegalArgumentException("The offline tool declaration is invalid.")
            val name = function.getString("name")
            require(name.matches(TOOL_NAME_PATTERN)) { "The offline tool declaration is invalid." }
            require(names.add(name)) { "The offline tool declaration is invalid." }
            val description = function.optString("description")
            val parameters = function.optJSONObject("parameters") ?: JSONObject()
            tool(object : OpenApiTool {
                override fun getToolDescriptionJsonString(): String = JSONObject()
                    .put("name", name)
                    .put("description", description)
                    .put("parameters", parameters)
                    .toString()

                override fun execute(paramsJsonString: String): String =
                    error("LiteRT-LM automatic tool execution must remain disabled.")
            })
        }
    }

    private fun jsonObjectToMap(value: JSONObject): Map<String, Any?> =
        value.keys().asSequence().associateWith { key ->
            jsonValueToKotlin(value.get(key))
        }

    private fun jsonValueToKotlin(value: Any): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> jsonObjectToMap(value)
        is JSONArray -> (0 until value.length()).map { index ->
            jsonValueToKotlin(value.get(index))
        }
        else -> value
    }
}
