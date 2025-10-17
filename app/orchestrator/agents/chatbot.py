import os

from langgraph.store.base import BaseStore

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.helpers.getUseHardwareAcceleration import getUseHardwareAcceleration
from app.orchestrator.state import State
# Import get_tools lazily to avoid premature initialization
# from app.orchestrator.tools.tools import get_tools

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM
llm = None

# Get the configured LLM provider
provider = config_manager.get("general.llm.provider", "openai")

if provider == "openai":
    from langchain_openai import ChatOpenAI

    openai_options = config_manager.get_section("general.llm.third_party.openai.options")
    if openai_options and openai_options.get("model"):
        llm = ChatOpenAI(**openai_options)
        log_info(f"Initialized OpenAI LLM with model: {openai_options['model']}")

elif provider == "huggingface_endpoint":
    hf_endpoint_options = config_manager.get_section("general.llm.third_party.huggingface_endpoint.options")

    if hf_endpoint_options and hf_endpoint_options.get("endpoint_url") and hf_endpoint_options.get("access_token"):
        try:
            from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint

            # Prepare options for HuggingFaceEndpoint (rename access_token to
            # huggingfacehub_api_token)
            endpoint_options = hf_endpoint_options.copy()
            if "access_token" in endpoint_options:
                endpoint_options["huggingfacehub_api_token"] = endpoint_options.pop("access_token")
            if "max_tokens" in endpoint_options:
                endpoint_options["max_new_tokens"] = endpoint_options.pop("max_tokens")

            # Create HuggingFace endpoint and chat interface
            hf_endpoint = HuggingFaceEndpoint(**endpoint_options)
            llm = ChatHuggingFace(llm=hf_endpoint)
            log_info(f"Initialized HuggingFace Endpoint LLM with URL: {hf_endpoint_options['endpoint_url']}")
        except ImportError:
            log_warning("langchain-huggingface not available. Install with: pip install langchain-huggingface")
        except Exception as e:
            log_error(f"Failed to initialize HuggingFace Endpoint: {e}")

elif provider == "huggingface_pipeline":
    hf_pipeline_options = config_manager.get_section("llm.local.huggingface_pipeline.options")

    if hf_pipeline_options and hf_pipeline_options.get("model"):
        try:
            from langchain_huggingface import ChatHuggingFace, HuggingFacePipeline

            # Get device configuration from hardware acceleration settings
            use_hardware_acceleration = getUseHardwareAcceleration("llm")
            device_value = 0 if use_hardware_acceleration == "cuda" else -1  # 0 for GPU, -1 for CPU

            # Prepare options for HuggingFacePipeline
            pipeline_options = hf_pipeline_options.copy()
            model_id = pipeline_options.pop("model")

            # Get nested kwargs with defaults
            pipeline_kwargs = pipeline_options.pop("pipeline_kwargs", {})
            model_kwargs = pipeline_options.pop("model_kwargs", {})

            # Move remaining options to model_kwargs if not in pipeline_kwargs
            for key, value in pipeline_options.items():
                if key not in [
                    "temperature",
                    "max_tokens",
                ]:  # These will be handled by ChatHuggingFace
                    model_kwargs[key] = value

            # Create HuggingFace pipeline
            pipeline = HuggingFacePipeline.from_model_id(
                model_id=model_id,
                task="text-generation",
                device=device_value,
                pipeline_kwargs=pipeline_kwargs,
                model_kwargs=model_kwargs,
            )

            log_info("HuggingFace Pipeline initialized successfully, initializing ChatHuggingFace...")
            llm = ChatHuggingFace(llm=pipeline, verbose=True, model_id=model_id)
            device_name = "GPU" if use_hardware_acceleration else "CPU"
            log_info(f"Initialized HuggingFace Pipeline LLM with model: {model_id} on device: {device_name}")

        except ImportError as e:
            log_error(f"Missing dependencies for HuggingFace Pipeline: {e}")
        except Exception as e:
            log_error(f"Failed to initialize HuggingFace Pipeline: {e}")
            llm = None

elif provider == "llama_cpp":
    from app.orchestrator.chat_llama_cpp import ChatLlamaCpp

    # Import handler to register it on the directory of chat formats
    from app.orchestrator.chat_llama_cpp_fn_handler import *  # noqa: F401,F403

    llama_options = config_manager.get_section("llm.local.llama_cpp.options")
    model_path = llama_options.get("model_path") if llama_options else None

    if model_path:
        # Prepare options for ChatLlamaCpp (ensure disable_streaming is set)
        llama_init_options = llama_options.copy()
        llama_init_options["disable_streaming"] = True

        llm = ChatLlamaCpp(**llama_init_options)
        log_info(f"Initialized Llama.cpp LLM with model: {model_path}")


# Final check to ensure LLM is initialized
if llm is not None:
    log_info(f"LLM successfully initialized with provider: {provider}")
else:
    log_error(f"Failed to initialize LLM with provider: {provider}")


# Def the chatbot node
def chatbot(state: State, store: BaseStore):
    # Check if llm is initialized
    if llm is None:
        raise ValueError("The language model (llm) is not initialized.")

    # Vector search for the history of memories

    items = store.search(("main", "memories"), query=state["messages"][-1].content, limit=3)
    memories = "\n".join(f"{item.value['text']} (score: {item.value['_search_score']})" for item in items)
    memories = f"## Similar memories\n{memories}" if memories else ""

    # RAG Search tools to bind for each chatbot call
    # Reduce the top_k parameter to reduce token usage
    # Be carefull to not reduce too much, the RAG is quite simplistic, it might miss relevant tools if top_k is too small
    # It might need adjusting depending on how much plugins you are using as
    # well, +plugins = +tools to load
    
    # Lazy import to avoid premature initialization
    from app.tooling.tools.tools import get_tools
    
    llm_with_tools = llm.bind_tools(get_tools(state["messages"][-1].content, 10), tool_choice="auto")
    print(state["messages"])
    return {
        "messages": [
            llm_with_tools.invoke(
                [
                    {
                        "role": "system",
                        "content": (
                            "You are a helpful voice assistant called Jarvis.\n"
                            "Be as concise as possible and provide the user with the most relevant information.\n"
                            "You are a voice assistant, so make all responses voice friendly, remove markdown and links.\n"
                            "Make sure to provide the user with the most relevant information and be concise."
                            "Alway respond in the language of the user"
                            "You can call tools to get information or execute actions.\n"
                            "Make sure to respond the user after finishing calling all necessary tools to gather data and/or execute actions"
                            "A tool can be called only once per message, so if you need to call a tool, make sure to call it only once.\n"
                            "The user should always get an answer at the end, summarize and adapt tool answers and respond to the user.\n"
                            f"{memories}"
                            f"\nCurrent time: {os.popen('date').read().strip()}"
                        ),
                    },
                    *state["messages"][-4:],
                ]
            )
        ]
    }
