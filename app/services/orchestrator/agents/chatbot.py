import os
from datetime import datetime

from langchain_core.tools import StructuredTool
from pydantic import create_model

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.helpers.getUseHardwareAcceleration import getUseHardwareAcceleration
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.state import State
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.messaging.models.db_models import RAGSearchQuery
from app.shared.messaging.models.tooling_models import GetToolsQuery

config_api = ConfigAPI()

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM (lazy initialization)
llm = None
_llm_initialized = False


async def _initialize_llm() -> None:
    """Initialize the LLM based on configuration.

    This is called lazily on first use to ensure ConfigService is ready.
    """
    global llm, _llm_initialized

    if _llm_initialized:
        log_debug("LLM already initialized, skipping initialization")
        return

    _llm_initialized = True
    log_info("Starting LLM initialization...")

    # Get the configured LLM provider (use async version since we're in async context)
    try:
        provider = await config_api.aget("general.llm.provider", "openai")
        log_info(f"LLM provider from config: {provider}")
    except Exception as e:
        log_error(f"Failed to get LLM provider from config: {e}", exc_info=True)
        provider = "openai"  # Fallback to default
        log_warning(f"Using default provider: {provider}")

    if provider == "openai":
        from langchain_openai import ChatOpenAI

        log_info("Initializing OpenAI LLM...")
        openai_options = {}
        try:
            # Get OpenAI config - navigate through the config structure
            # Try getting the full config first to see structure
            full_config = await config_api.aget_config()
            log_debug(f"Full config top-level keys: {list(full_config.keys()) if full_config else 'None'}")

            # Get general section
            general_config_raw = await config_api.aget_config("general")
            config_type_msg = (
                f"Retrieved general config type: {type(general_config_raw)}, "
                f"keys: {list(general_config_raw.keys()) if isinstance(general_config_raw, dict) else 'Not a dict'}"
            )
            log_info(config_type_msg)
            log_debug(f"General config content: {general_config_raw}")

            # Extract config if it's wrapped in a 'config' key (response wrapper)
            if isinstance(general_config_raw, dict) and "config" in general_config_raw:
                general_config = general_config_raw["config"]
                extracted_msg = (
                    f"Extracted config from wrapper: {type(general_config)}, "
                    f"keys: {list(general_config.keys()) if isinstance(general_config, dict) else 'Not a dict'}"
                )
                log_info(extracted_msg)
            else:
                general_config = general_config_raw

            if not isinstance(general_config, dict):
                log_error(f"Expected dict but got {type(general_config)}: {general_config}")
                llm = None
            else:
                general_llm = general_config.get("llm", {})
                log_info(f"General LLM config: {general_llm}")
                log_debug(f"General LLM config keys: {list(general_llm.keys()) if general_llm else 'None'}")

                third_party = general_llm.get("third_party", {}) if isinstance(general_llm, dict) else {}
                log_info(f"Third party config: {third_party}")
                log_debug(f"Third party config keys: {list(third_party.keys()) if third_party else 'None'}")

                openai_config = third_party.get("openai", {}) if isinstance(third_party, dict) else {}
                log_info(f"OpenAI config: {openai_config}")
                log_debug(f"OpenAI config keys: {list(openai_config.keys()) if openai_config else 'None'}")

                if isinstance(openai_config, dict):
                    openai_options = openai_config.get("options", {})
                    log_info(f"OpenAI options retrieved: {openai_options}")
                    options_type_msg = (
                        f"OpenAI options type: {type(openai_options)}, "
                        f"keys: {list(openai_options.keys()) if isinstance(openai_options, dict) else 'Not a dict'}"
                    )
                    log_info(options_type_msg)
                else:
                    log_error(f"OpenAI config is not a dict! Type: {type(openai_config)}, Value: {openai_config}")
                    openai_options = {}

            if openai_options and openai_options.get("model"):
                model_name = openai_options.get("model")
                log_info(f"Attempting to initialize OpenAI LLM with model: {model_name}")

                # Check for API key
                api_key = os.getenv("OPENAI_API_KEY")
                if not api_key:
                    log_error("OPENAI_API_KEY environment variable is not set!")
                    log_error("OpenAI LLM requires OPENAI_API_KEY to be set in environment variables")
                    llm = None
                else:
                    log_debug(f"OPENAI_API_KEY found (length: {len(api_key)} chars)")
                    try:
                        # Log options without sensitive data
                        safe_options = {k: v for k, v in openai_options.items() if k != "api_key"}
                        log_debug(f"OpenAI initialization options: {safe_options}")

                        llm = ChatOpenAI(**openai_options)
                        log_info(f"Successfully initialized OpenAI LLM with model: {model_name}")
                    except Exception as e:
                        log_error(f"Failed to initialize OpenAI LLM: {e}", exc_info=True)
                        log_error(f"Error type: {type(e).__name__}")
                        llm = None
            else:
                log_error("OpenAI options not found or model not specified in config")
                log_error(f"OpenAI options: {openai_options}")
                llm = None
        except Exception as e:
            log_error(f"Error fetching OpenAI config: {e}", exc_info=True)
            llm = None

    elif provider == "huggingface_endpoint":
        log_info("Initializing HuggingFace Endpoint LLM...")
        try:
            llm_config = await config_api.aget_config("general")
            log_debug(f"Retrieved general config: {list(llm_config.keys()) if llm_config else 'None'}")
            general_llm = llm_config.get("llm", {}) if llm_config else {}
            third_party = general_llm.get("third_party", {})
            hf_endpoint_config = third_party.get("huggingface_endpoint", {})
            hf_endpoint_options = hf_endpoint_config.get("options", {}) if hf_endpoint_config else {}
            log_info(f"HuggingFace Endpoint options retrieved: {list(hf_endpoint_options.keys()) if hf_endpoint_options else 'None'}")
        except Exception as e:
            log_error(f"Error fetching HuggingFace Endpoint config: {e}", exc_info=True)
            hf_endpoint_options = {}

        if hf_endpoint_options and hf_endpoint_options.get("endpoint_url") and hf_endpoint_options.get("access_token"):
            try:
                from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint
            except ImportError:
                log_error(
                    "langchain-huggingface is required for HuggingFace endpoint but not installed. "
                    "Install with: pip install -e .[service-orchestrator-huggingface-endpoint] "
                    "Or build Docker image with: ORCHESTRATOR_LLM_MODE=huggingface-endpoint docker-compose build orchestrator-service"
                )
                llm = None
            else:
                try:
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
                except Exception as e:
                    log_error(f"Failed to initialize HuggingFace Endpoint: {e}")
                    llm = None

    elif provider == "huggingface_pipeline":
        log_info("Initializing HuggingFace Pipeline LLM...")
        try:
            llm_config = await config_api.aget_config("llm")
            log_debug(f"Retrieved llm config: {list(llm_config.keys()) if llm_config else 'None'}")
            local_config = llm_config.get("local", {}) if llm_config else {}
            hf_pipeline_config = local_config.get("huggingface_pipeline", {})
            hf_pipeline_options = hf_pipeline_config.get("options", {}) if hf_pipeline_config else {}
            log_info(f"HuggingFace Pipeline options retrieved: {list(hf_pipeline_options.keys()) if hf_pipeline_options else 'None'}")
        except Exception as e:
            log_error(f"Error fetching HuggingFace Pipeline config: {e}", exc_info=True)
            hf_pipeline_options = {}

        # Check environment variable first
        model_id = os.getenv("AURORA_HUGGINGFACE_MODEL_ID")
        if model_id is None and hf_pipeline_options:
            model_id = hf_pipeline_options.get("model")

        if model_id:
            try:
                from langchain_huggingface import ChatHuggingFace, HuggingFacePipeline
            except ImportError as e:
                log_error(
                    f"Missing dependencies for HuggingFace Pipeline: {e}. "
                    "Install with: pip install -e .[service-orchestrator-huggingface-local] "
                    "Or build Docker image with: ORCHESTRATOR_LLM_MODE=huggingface-local docker-compose build orchestrator-service"
                )
                llm = None
            else:
                try:
                    # Get device configuration from hardware acceleration settings
                    use_hardware_acceleration = getUseHardwareAcceleration("llm")
                    device_value = 0 if use_hardware_acceleration == "cuda" else -1  # 0 for GPU, -1 for CPU

                    # Prepare options for HuggingFacePipeline
                    pipeline_options = hf_pipeline_options.copy() if hf_pipeline_options else {}
                    # model_id already set from env var or config above

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
                except Exception as e:
                    log_error(f"Failed to initialize HuggingFace Pipeline: {e}")
                    llm = None

    elif provider == "llama_cpp":
        log_info("Initializing Llama.cpp LLM...")
        try:
            # Import handler to register it on the directory of chat formats
            # Note: import * must be at module level, so we do a regular import here
            import app.services.orchestrator.chat_llama_cpp_fn_handler  # noqa: F401
            from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp
        except ImportError as e:
            log_error(
                f"Missing dependencies for Llama.cpp: {e}. "
                "Install with: pip install -e .[service-orchestrator-llama-cpp] "
                "Or for CUDA: pip install -e .[service-orchestrator-llama-cpp-cuda] "
                "Or build Docker image with: ORCHESTRATOR_LLM_MODE=llama-cpp docker-compose build orchestrator-service"
            )
            llm = None
        else:
            # Check environment variable first
            model_path = os.getenv("AURORA_LLAMA_CPP_MODEL_PATH")
            log_debug(f"AURORA_LLAMA_CPP_MODEL_PATH env var: {model_path if model_path else 'Not set'}")

            # Fall back to config if env var not set
            if model_path is None:
                try:
                    llm_config = await config_api.aget_config("llm")
                    log_debug(f"Retrieved llm config: {list(llm_config.keys()) if llm_config else 'None'}")
                    local_config = llm_config.get("local", {}) if llm_config else {}
                    llama_config = local_config.get("llama_cpp", {})
                    llama_options = llama_config.get("options", {}) if llama_config else {}
                    model_path = llama_options.get("model_path") if llama_options else None
                    log_info(f"Llama.cpp model path from config: {model_path if model_path else 'Not found'}")
                except Exception as e:
                    log_error(f"Error fetching Llama.cpp config: {e}", exc_info=True)
                    model_path = None

            if model_path:
                # Prepare options for ChatLlamaCpp (ensure disable_streaming is set)
                try:
                    llm_config = await config_api.aget_config("llm")
                    local_config = llm_config.get("local", {}) if llm_config else {}
                    llama_config = local_config.get("llama_cpp", {})
                    llama_options = llama_config.get("options", {}) if llama_config else {}
                    llama_init_options = llama_options.copy()
                    llama_init_options["model_path"] = model_path  # Use env var or config value
                    llama_init_options["disable_streaming"] = True

                    log_info(f"Attempting to initialize Llama.cpp LLM with model: {model_path}")
                    log_debug(f"Llama.cpp initialization options: {list(llama_init_options.keys())}")

                    llm = ChatLlamaCpp(**llama_init_options)
                    log_info(f"Successfully initialized Llama.cpp LLM with model: {model_path}")
                except Exception as e:
                    log_error(f"Failed to initialize Llama.cpp LLM: {e}", exc_info=True)
                    llm = None
            else:
                log_error("Llama.cpp model path not configured")
                log_error("Please set AURORA_LLAMA_CPP_MODEL_PATH environment variable or configure model_path in config")
                llm = None

    # Final check to ensure LLM is initialized
    if llm is not None:
        log_info(f"✅ LLM successfully initialized with provider: {provider}")
    else:
        log_error(f"❌ Failed to initialize LLM with provider: {provider}")
        log_error("Please check:")
        log_error("  1. Configuration file has correct LLM settings")
        log_error("  2. Required environment variables are set (e.g., OPENAI_API_KEY)")
        log_error("  3. Required dependencies are installed")
        log_error("  4. ConfigService is running and accessible")


def _deserialize_tools(tool_schemas: list[dict]) -> list[StructuredTool]:
    """Deserialize tool schemas received from ToolingService via bus into LangChain StructuredTool objects.

    This function reconstructs LangChain tools from serialized data (name, description, argument descriptions)
    that was sent through the bus. The bus remains agnostic - it just transported the data.

    Args:
        tool_schemas: List of serialized tool schemas from ToolingService (name, description, args_schema)

    Returns:
        List of LangChain StructuredTool objects that can be bound to LLM
    """
    from pydantic import Field

    tools = []

    for schema in tool_schemas:
        try:
            tool_name = schema.get("name", "unknown_tool")
            tool_description = schema.get("description", "")
            args_schema_dict = schema.get("args_schema", {})

            # Create a Pydantic model from the JSON schema
            # If the schema has properties, create a model with those fields
            if args_schema_dict and isinstance(args_schema_dict, dict) and "properties" in args_schema_dict:
                properties = args_schema_dict["properties"]
                required_fields = args_schema_dict.get("required", [])

                # Build field definitions for create_model
                field_defs = {}
                if properties:  # Only iterate if properties is not empty
                    for field_name, field_info in properties.items():
                        field_type = _json_schema_type_to_python(field_info.get("type", "string"))
                        field_description = field_info.get("description", "")

                        # Check if field is required
                        if field_name in required_fields:
                            # Required field - use Ellipsis (...) with Field description if available
                            if field_description:
                                field_defs[field_name] = (field_type, Field(..., description=field_description))
                            else:
                                field_defs[field_name] = (field_type, ...)
                        else:
                            # Optional field - use Field with default None and description if available
                            if field_description:
                                field_defs[field_name] = (field_type, Field(default=None, description=field_description))
                            else:
                                field_defs[field_name] = (field_type, None)

                # Create the Pydantic model dynamically (empty field_defs creates empty model)
                ArgsModel = create_model(f"{tool_name}Args", **field_defs)
            else:
                # No arguments
                ArgsModel = create_model(f"{tool_name}Args")

            # Create a dummy function for the tool (execution happens via bus)
            def dummy_func(**kwargs):
                """This function is never called - tool execution happens via bus."""
                raise NotImplementedError(f"Tool {tool_name} should be executed via message bus, not directly")

            # Create the StructuredTool
            tool = StructuredTool(
                name=tool_name,
                description=tool_description,
                func=dummy_func,
                args_schema=ArgsModel,
            )

            tools.append(tool)

        except Exception as e:
            log_warning(f"Failed to deserialize tool schema: {e}")
            continue

    return tools


def _json_schema_type_to_python(json_type: str) -> type:
    """Convert JSON schema type to Python type.

    Args:
        json_type: JSON schema type string

    Returns:
        Corresponding Python type
    """
    type_mapping = {
        "string": str,
        "number": float,
        "integer": int,
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    return type_mapping.get(json_type, str)


# Def the chatbot node
async def chatbot(state: State, bus: MessageBus):
    """Chatbot node for LangGraph.

    Args:
        state: Current graph state
        bus: MessageBus instance (injected as dependency)
    """
    # Initialize LLM lazily if not already done
    if not _llm_initialized:
        log_info("LLM not initialized yet, initializing now...")
        await _initialize_llm()
    else:
        log_debug("LLM already initialized, skipping initialization")

    # Check if llm is initialized
    if llm is None:
        error_msg = (
            "The language model (llm) is not initialized. "
            "Check configuration and ensure API keys are set. "
            "See logs above for detailed error information."
        )
        log_error(error_msg)
        raise ValueError(error_msg)

    # Vector search for the history of memories via bus
    try:
        result = await bus.request(
            DBMethods.RAG_SEARCH,
            RAGSearchQuery(namespace="main.memories", query=state["messages"][-1].content, limit=3),
            timeout=5.0,
            priority=get_interactive_priority(),
        )

        if result.ok and result.data and "items" in result.data:
            items_data = result.data["items"]
            memories = "\n".join(
                f"{item['value']['text']} (score: {item.get('search_score', 'N/A')})" for item in items_data if item.get("value", {}).get("text")
            )
            memories = f"## Similar memories\n{memories}" if memories else ""
        else:
            memories = ""
            if not result.ok:
                log_error(f"Failed to search memories via bus: {result.error}")
    except Exception as e:
        log_error(f"Error searching memories via bus: {e}")
        memories = ""

    # RAG Search tools to bind for each chatbot call
    # Reduce the top_k parameter to reduce token usage
    # Be careful to not reduce too much, the RAG is quite simplistic, it might miss relevant tools if top_k is too small
    # It might need adjusting depending on how much plugins you are using as
    # well, +plugins = +tools to load

    # Get tools via message bus (from ToolingService)

    # Request tools from ToolingService via bus
    result = await bus.request(
        ToolingMethods.GET_TOOLS,
        GetToolsQuery(query=state["messages"][-1].content, top_k=10),
        timeout=5.0,
        priority=get_interactive_priority(),
    )

    if not result.ok:
        log_error(f"Failed to get tools from ToolingService: {result.error}")
        tools = []
    else:
        # Deserialize tools from the response
        # result.data contains the GetToolsResponse fields
        if result.data is None:
            log_error("GetToolsResponse returned None data")
            tools = []
        elif isinstance(result.data, dict):
            # Extract tools from the response
            tool_schemas = result.data.get("tools", [])
            if not tool_schemas:
                log_warning("No tools returned from ToolingService")
            tools = _deserialize_tools(tool_schemas)
            log_debug(f"Loaded {len(tools)} tools for LLM binding")
        else:
            log_error(f"Unexpected result.data type: {type(result.data)}")
            tools = []

    llm_with_tools = llm.bind_tools(tools, tool_choice="auto") if tools else llm
    log_debug(f"Processing {len(state['messages'])} messages in chatbot node")
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
                            f"\nCurrent time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                        ),
                    },
                    *state["messages"][-4:],
                ]
            )
        ]
    }
