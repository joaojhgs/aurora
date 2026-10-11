#[cfg(feature = "native-llamacpp")]
use aurora_local_inference::{
    ChatMessage, CompletionOptions, CompletionRequest, CompletionResult, FunctionDefinition,
    FunctionTool, LocalInferenceConfig, LocalInferenceState, ModelCapabilities,
    TrustedModelDescriptor,
};
#[cfg(feature = "native-llamacpp")]
use serde_json::json;
#[cfg(feature = "native-llamacpp")]
use std::path::PathBuf;

#[cfg(feature = "native-llamacpp")]
const MODEL_ID: &str = "chat-qwen3-0b8";
#[cfg(feature = "native-llamacpp")]
const MODEL_FILE: &str = "Qwen3.5-0.8B-Q4_0.gguf";

#[cfg(feature = "native-llamacpp")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model_path = std::env::var_os("AURORA_LOCAL_INFERENCE_MODEL")
        .map(PathBuf::from)
        .ok_or("set AURORA_LOCAL_INFERENCE_MODEL to the verified local GGUF file")?;
    if model_path.file_name().and_then(|name| name.to_str()) != Some(MODEL_FILE) {
        return Err("model path does not name the pinned local catalog file".into());
    }
    let app_private_root = model_path
        .parent()
        .ok_or("model path has no parent directory")?
        .to_path_buf();
    let descriptor = TrustedModelDescriptor {
        model_id: MODEL_ID.to_owned(),
        display_label: "Offline answers".to_owned(),
        file_name: MODEL_FILE.to_owned(),
        byte_size: 563_036_064,
        sha256: "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf".to_owned(),
        source_url: "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/9447f74101aeb4e93621884dfa36ee8effb8831b/Qwen3.5-0.8B-Q4_0.gguf".to_owned(),
        context_tokens: 4096,
        max_output_tokens: 128,
        capabilities: ModelCapabilities { chat: true, tools: true },
    };
    let state = LocalInferenceState::new(LocalInferenceConfig {
        app_private_root,
        models: vec![descriptor],
    })?;
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    runtime.block_on(async move {
        let session_id = "per284-main-flow".to_owned();
        state
            .create_session(session_id.clone(), MODEL_ID.to_owned(), 1)
            .await?;
        let answer = state
            .complete(
                &session_id,
                "answer-1".to_owned(),
                CompletionRequest {
                    model_id: MODEL_ID.to_owned(),
                    session_id: session_id.clone(),
                    messages: vec![message(
                        "user",
                        "Answer in one short sentence: why do leaves change color?",
                    )],
                    tools: Vec::new(),
                    options: CompletionOptions {
                        max_tokens: Some(128),
                        temperature: Some(0.0),
                        ..CompletionOptions::default()
                    },
                },
                1,
            )
            .await?;
        if !matches!(&answer, CompletionResult::Message { content } if !content.trim().is_empty()) {
            return Err("plain answer did not return a message".into());
        }
        println!("{}", serde_json::to_string(&answer)?);
        let proposed = state
            .complete(
                &session_id,
                "tool-1".to_owned(),
                CompletionRequest {
                    model_id: MODEL_ID.to_owned(),
                    session_id: session_id.clone(),
                    messages: vec![message(
                        "user",
                        "Use the lookup function to find the color for chlorophyll.",
                    )],
                    tools: vec![FunctionTool {
                        r#type: "function".to_owned(),
                        function: FunctionDefinition {
                            name: "lookup_color".to_owned(),
                            description: "Return the typical color for a named pigment.".to_owned(),
                            parameters: json!({
                                "type": "object",
                                "properties": {"pigment": {"type": "string"}},
                                "required": ["pigment"],
                                "additionalProperties": false
                            }),
                        },
                    }],
                    options: CompletionOptions {
                        max_tokens: Some(128),
                        temperature: Some(0.0),
                        force_tools: Some(true),
                        ..CompletionOptions::default()
                    },
                },
                1,
            )
            .await?;
        if !matches!(proposed, CompletionResult::ToolCalls { .. }) {
            return Err("forced local tool proposal did not return tool calls".into());
        }
        println!("{}", serde_json::to_string(&proposed)?);
        state.destroy_session(&session_id).await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;
    Ok(())
}

#[cfg(feature = "native-llamacpp")]
fn message(role: &str, content: &str) -> ChatMessage {
    ChatMessage {
        role: role.to_owned(),
        content: content.to_owned(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        metadata: None,
    }
}

#[cfg(not(feature = "native-llamacpp"))]
fn main() {
    eprintln!("enable the native-llamacpp feature to run this example");
}
