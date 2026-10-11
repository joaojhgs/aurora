#include "bridge.h"

#include "chat.h"
#include "llama.h"
#include "json.h"
#include "json-schema-to-grammar.h"
#include "log.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <vector>

namespace {
constexpr size_t kMaxRequestBytes = 128 * 1024;
constexpr size_t kMaxResponseBytes = 256 * 1024;
constexpr size_t kMaxPromptTokens = 8192;
constexpr uint32_t kMaxOutputTokens = 1024;
constexpr size_t kMaxMessageCount = 64;
constexpr size_t kMaxToolCount = 32;

void quiet_log(enum ggml_log_level, const char *, void *) {}

void set_error(char ** out, const char * message) {
    if (out == nullptr) {
        return;
    }
    const auto size = std::strlen(message) + 1;
    auto * value = static_cast<char *>(std::malloc(size));
    if (value != nullptr) {
        std::memcpy(value, message, size);
        *out = value;
    }
}

char * copy_string(const std::string & value) {
    if (value.size() > kMaxResponseBytes) {
        return nullptr;
    }
    auto * output = static_cast<char *>(std::malloc(value.size() + 1));
    if (output == nullptr) {
        return nullptr;
    }
    std::memcpy(output, value.data(), value.size());
    output[value.size()] = '\0';
    return output;
}

bool valid_request(const common_json & request) {
    if (!request.is_object() || !request.contains("messages") || !request.at("messages").is_array()) {
        return false;
    }
    if (request.at("messages").size() == 0 || request.at("messages").size() > kMaxMessageCount) {
        return false;
    }
    if (request.contains("tools") && (!request.at("tools").is_array() || request.at("tools").size() > kMaxToolCount)) {
        return false;
    }
    return true;
}

common_json completion_schema(const common_json & tools, bool force_tools) {
    common_json response_types = common_json::array();
    if (!force_tools) {
        response_types.push_back({
            {"type", "object"},
            {"properties", {{"type", {{"const", "message"}}}, {"content", {{"type", "string"}}}}},
            {"required", common_json::array({"type", "content"})},
            {"additionalProperties", false},
        });
    }
    if (tools.is_array() && !tools.empty()) {
        common_json tool_shapes = common_json::array();
        for (const auto & tool : tools) {
            const auto & function = tool.at("function");
            auto parameters = function.value("parameters", common_json::object());
            if (!parameters.is_object()) {
                parameters = {{"type", "object"}};
            }
            tool_shapes.push_back({
                {"type", "object"},
                {"properties", {
                    {"name", {{"const", function.at("name")}}},
                    {"arguments", parameters},
                }},
                {"required", common_json::array({"name", "arguments"})},
                {"additionalProperties", false},
            });
        }
        response_types.push_back({
            {"type", "object"},
            {"properties", {
                {"type", {{"const", "tool_calls"}}},
                {"content", {{"const", ""}}},
                {"toolCalls", {
                    {"type", "array"},
                    {"minItems", 1},
                    {"maxItems", 1},
                    {"items", {{"oneOf", tool_shapes}}},
                }},
            }},
            {"required", common_json::array({"type", "content", "toolCalls"})},
            {"additionalProperties", false},
        });
    }
    return {
        {"oneOf", response_types},
    };
}

struct BackendInit {
    BackendInit() {
        llama_log_set(quiet_log, nullptr);
        common_log_set_verbosity_thold(-1);
        llama_backend_init();
    }
};

std::once_flag backend_once;
} // namespace

struct aurora_llama_cancel {
    std::atomic<bool> requested{false};
};

struct aurora_llama_engine {
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    common_chat_templates_ptr templates;
    uint32_t context_tokens = 0;

    ~aurora_llama_engine() {
        templates.reset();
        if (context != nullptr) {
            llama_free(context);
        }
        if (model != nullptr) {
            llama_model_free(model);
        }
    }
};

extern "C" void aurora_llama_backend_init(void) {
    std::call_once(backend_once, [] { static BackendInit backend; (void) backend; });
}

extern "C" int32_t aurora_llama_engine_create(
    const char * model_path,
    uint32_t context_tokens,
    uint32_t threads,
    aurora_llama_engine ** engine_out,
    char ** error_out) {
    if (engine_out != nullptr) {
        *engine_out = nullptr;
    }
    if (error_out != nullptr) {
        *error_out = nullptr;
    }
    if (model_path == nullptr || engine_out == nullptr || context_tokens == 0 || context_tokens > kMaxPromptTokens) {
        set_error(error_out, "invalid model configuration");
        return 1;
    }
    try {
        aurora_llama_backend_init();
        auto engine = std::make_unique<aurora_llama_engine>();
        auto model_params = llama_model_default_params();
        model_params.n_gpu_layers = 0;
        engine->model = llama_model_load_from_file(model_path, model_params);
        if (engine->model == nullptr) {
            set_error(error_out, "model load failed");
            return 2;
        }
        auto context_params = llama_context_default_params();
        context_params.n_ctx = context_tokens;
        context_params.n_batch = std::min<uint32_t>(context_tokens, 512);
        context_params.n_ubatch = std::min<uint32_t>(context_params.n_batch, 256);
        context_params.n_seq_max = 1;
        const int32_t thread_count = static_cast<int32_t>(std::clamp<uint32_t>(threads == 0 ? 2 : threads, 1, 8));
        context_params.n_threads = thread_count;
        context_params.n_threads_batch = thread_count;
        engine->context = llama_init_from_model(engine->model, context_params);
        if (engine->context == nullptr) {
            set_error(error_out, "model context unavailable");
            return 3;
        }
        engine->templates = common_chat_templates_init(engine->model, "");
        if (!engine->templates) {
            set_error(error_out, "model chat template unavailable");
            return 4;
        }
        engine->context_tokens = context_tokens;
        *engine_out = engine.release();
        return 0;
    } catch (...) {
        set_error(error_out, "model initialization failed");
        return 5;
    }
}

extern "C" void aurora_llama_engine_destroy(aurora_llama_engine * engine) {
    delete engine;
}

extern "C" int32_t aurora_llama_engine_reset(aurora_llama_engine * engine) {
    if (engine == nullptr || engine->context == nullptr) {
        return 1;
    }
    llama_memory_clear(llama_get_memory(engine->context), true);
    return 0;
}

extern "C" aurora_llama_cancel * aurora_llama_cancel_create(void) {
    return new (std::nothrow) aurora_llama_cancel();
}

extern "C" void aurora_llama_cancel_request(aurora_llama_cancel * cancellation) {
    if (cancellation != nullptr) {
        cancellation->requested.store(true, std::memory_order_release);
    }
}

extern "C" int32_t aurora_llama_cancel_is_requested(const aurora_llama_cancel * cancellation) {
    return cancellation != nullptr && cancellation->requested.load(std::memory_order_acquire) ? 1 : 0;
}

extern "C" void aurora_llama_cancel_destroy(aurora_llama_cancel * cancellation) {
    delete cancellation;
}

extern "C" int32_t aurora_llama_complete(
    aurora_llama_engine * engine,
    const char * request_json,
    aurora_llama_cancel * cancellation,
    char ** response_json_out,
    char ** error_out) {
    if (response_json_out != nullptr) {
        *response_json_out = nullptr;
    }
    if (error_out != nullptr) {
        *error_out = nullptr;
    }
    if (engine == nullptr || engine->context == nullptr || request_json == nullptr || response_json_out == nullptr) {
        set_error(error_out, "invalid completion request");
        return 1;
    }
    struct DecodeCancellation {
        llama_context * context;
        DecodeCancellation(llama_context * ctx, aurora_llama_cancel * token) : context(ctx) {
            llama_set_abort_callback(context, [](void * data) {
                return aurora_llama_cancel_is_requested(static_cast<aurora_llama_cancel *>(data)) != 0;
            }, token);
        }
        ~DecodeCancellation() { llama_set_abort_callback(context, nullptr, nullptr); }
    } decode_cancellation(engine->context, cancellation);
    int32_t phase = 0;
    try {
        phase = 1;
        const size_t request_size = std::strlen(request_json);
        if (request_size == 0 || request_size > kMaxRequestBytes || aurora_llama_cancel_is_requested(cancellation)) {
            set_error(error_out, "completion request rejected");
            return 2;
        }
        const auto request = common_json::parse(request_json);
        if (!valid_request(request)) {
            set_error(error_out, "completion request rejected");
            return 3;
        }
        common_chat_templates_inputs chat_inputs;
        chat_inputs.messages = common_chat_msgs_parse_oaicompat(request.at("messages"));
        const auto tools = request.contains("tools")
            ? common_chat_tools_parse_oaicompat(request.at("tools"))
            : std::vector<common_chat_tool>{};
        const auto tool_wire = request.contains("tools") ? request.at("tools") : common_json::array();
        const auto options = request.contains("options") && request.at("options").is_object()
            ? request.at("options") : common_json::object();
        const bool force_tools = options.value("forceTools", false);
        if (force_tools && tools.empty()) {
            set_error(error_out, "local tool request rejected");
            return 3;
        }
        common_chat_msg instruction;
        instruction.role = "system";
        instruction.content = "Return exactly one JSON object, with no markdown or reasoning. For a concise answer use {\"type\":\"message\",\"content\":\"your answer\"}.";
        if (!tools.empty()) {
            instruction.content += " When a listed function is needed use {\"type\":\"tool_calls\",\"content\":\"\",\"toolCalls\":[{\"name\":\"function name\",\"arguments\":{}}]}. Function schemas follow: " + tool_wire.dump();
        }
        chat_inputs.messages.insert(chat_inputs.messages.begin(), std::move(instruction));
        const auto response_schema = completion_schema(tool_wire, force_tools);
        chat_inputs.json_schema = response_schema.dump();
        chat_inputs.use_jinja = true;
        chat_inputs.enable_thinking = false;
        chat_inputs.force_pure_content = true;
        chat_inputs.add_generation_prompt = true;
        llama_memory_clear(llama_get_memory(engine->context), true);
        phase = 2;
        const auto params = common_chat_templates_apply(engine->templates.get(), chat_inputs);
        const auto grammar = json_schema_to_grammar(response_schema, true);
        if (grammar.empty()) {
            set_error(error_out, "model cannot constrain the local response");
            return 4;
        }

        const auto * vocab = llama_model_get_vocab(engine->model);
        if (vocab == nullptr || params.prompt.empty() || params.prompt.size() > kMaxRequestBytes) {
            set_error(error_out, "local prompt is unavailable");
            return 5;
        }
        std::vector<llama_token> tokens(std::min<size_t>(params.prompt.size() + 8, kMaxPromptTokens));
        int32_t token_count = llama_tokenize(vocab, params.prompt.data(), static_cast<int32_t>(params.prompt.size()),
                                             tokens.data(), static_cast<int32_t>(tokens.size()), true, true);
        if (token_count < 0) {
            tokens.resize(static_cast<size_t>(-token_count));
            token_count = llama_tokenize(vocab, params.prompt.data(), static_cast<int32_t>(params.prompt.size()),
                                         tokens.data(), static_cast<int32_t>(tokens.size()), true, true);
        }
        if (token_count <= 0 || static_cast<size_t>(token_count) > kMaxPromptTokens ||
            static_cast<uint32_t>(token_count) >= engine->context_tokens) {
            set_error(error_out, "local prompt exceeds the available context");
            return 6;
        }
        tokens.resize(static_cast<size_t>(token_count));
        if (aurora_llama_cancel_is_requested(cancellation)) {
            set_error(error_out, "completion cancelled");
            return 7;
        }
        const uint32_t batch_limit = llama_n_batch(engine->context);
        if (batch_limit == 0) {
            set_error(error_out, "local context is unavailable");
            return 8;
        }
        for (size_t offset = 0; offset < tokens.size();) {
            if (aurora_llama_cancel_is_requested(cancellation)) {
                set_error(error_out, "completion cancelled");
                return 7;
            }
            const auto count = std::min<size_t>(batch_limit, tokens.size() - offset);
            auto batch = llama_batch_get_one(tokens.data() + offset, static_cast<int32_t>(count));
            const int32_t status = llama_decode(engine->context, batch);
            if (status != 0) {
                set_error(error_out, "prompt evaluation failed");
                return 9;
            }
            offset += count;
        }

        auto chain = llama_sampler_chain_init(llama_sampler_chain_default_params());
        if (chain == nullptr) {
            set_error(error_out, "local sampler unavailable");
            return 10;
        }
        {
            auto * grammar_sampler = llama_sampler_init_grammar(vocab, grammar.c_str(), "root");
            if (grammar_sampler == nullptr) {
                llama_sampler_free(chain);
                set_error(error_out, "local tool constraints unavailable");
                return 11;
            }
            llama_sampler_chain_add(chain, grammar_sampler);
        }
        const float temperature = options.value("temperature", 0.2f);
        if (temperature > 0.0f) {
            llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature));
            llama_sampler_chain_add(chain, llama_sampler_init_dist(0xA071A));
        } else {
            llama_sampler_chain_add(chain, llama_sampler_init_greedy());
        }
        const uint32_t requested_output = options.contains("maxTokens")
            ? options.value("maxTokens", kMaxOutputTokens)
            : kMaxOutputTokens;
        const uint32_t max_output = std::clamp<uint32_t>(requested_output, 1, kMaxOutputTokens);
        std::string generated;
        generated.reserve(4096);
        const auto stop_sequences = options.contains("stopSequences") && options.at("stopSequences").is_array()
            ? options.at("stopSequences") : common_json::array();
        bool ended = false;
        for (uint32_t index = 0; index < max_output; ++index) {
            if (aurora_llama_cancel_is_requested(cancellation)) {
                llama_sampler_free(chain);
                set_error(error_out, "completion cancelled");
                return 7;
            }
            const auto token = llama_sampler_sample(chain, engine->context, -1);
            if (llama_vocab_is_eog(vocab, token)) {
                ended = true;
                break;
            }
            char piece[256];
            const auto piece_size = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, false);
            if (piece_size < 0 || generated.size() + static_cast<size_t>(piece_size) > kMaxResponseBytes) {
                llama_sampler_free(chain);
                set_error(error_out, "local response exceeds the allowed size");
                return 12;
            }
            generated.append(piece, static_cast<size_t>(piece_size));
            bool stopped = false;
            for (const auto & stop : stop_sequences) {
                if (!stop.is_string()) continue;
                const auto value = stop.get<std::string>();
                if (!value.empty() && generated.size() >= value.size() &&
                    generated.compare(generated.size() - value.size(), value.size(), value) == 0) {
                    generated.resize(generated.size() - value.size());
                    stopped = true;
                    ended = true;
                    break;
                }
            }
            if (stopped) break;
            auto batch = llama_batch_get_one(const_cast<llama_token *>(&token), 1);
            if (llama_decode(engine->context, batch) != 0) {
                llama_sampler_free(chain);
                set_error(error_out, "token evaluation failed");
                return 13;
            }
        }
        llama_sampler_free(chain);
        if (!ended && generated.empty()) {
            set_error(error_out, "local answer is empty");
            return 14;
        }

        phase = 3;
        const auto output = common_json::parse(generated);
        if (!output.is_object() || !output.contains("type") || !output.at("type").is_string()) {
            set_error(error_out, "local response did not match its constraints");
            return 15;
        }
        if (output.at("type") == "message") {
            if (!output.contains("content") || !output.at("content").is_string()) {
                set_error(error_out, "local response did not match its constraints");
                return 15;
            }
        } else if (output.at("type") == "tool_calls") {
            if (tools.empty() || !output.contains("content") || !output.at("content").is_string() ||
                !output.contains("toolCalls") || !output.at("toolCalls").is_array() || output.at("toolCalls").size() != 1) {
                set_error(error_out, "local tool proposal rejected");
                return 15;
            }
            const auto & call = output.at("toolCalls").at(0);
            if (!call.is_object() || !call.contains("name") || !call.at("name").is_string() ||
                !call.contains("arguments") || !call.at("arguments").is_object()) {
                set_error(error_out, "local tool proposal rejected");
                return 15;
            }
            const auto name = call.at("name").get<std::string>();
            const bool known_tool = std::any_of(tools.begin(), tools.end(),
                [&name](const common_chat_tool & tool) { return tool.name == name; });
            if (!known_tool) {
                set_error(error_out, "local tool proposal rejected");
                return 15;
            }
        } else {
            set_error(error_out, "local response did not match its constraints");
            return 15;
        }
        auto response = output.dump();
        *response_json_out = copy_string(response);
        if (*response_json_out == nullptr) {
            set_error(error_out, "local response could not be prepared");
            return 16;
        }
        return 0;
    } catch (...) {
        set_error(error_out, "local inference failed");
        return 17 + phase;
    }
}

extern "C" void aurora_llama_free_string(char * value) {
    std::free(value);
}
