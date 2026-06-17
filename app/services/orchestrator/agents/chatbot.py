import os
from datetime import datetime

from langchain_core.tools import StructuredTool
from pydantic import create_model

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.helpers.getUseHardwareAcceleration import get_use_hardware_acceleration
from app.messaging import MessageBus
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.state import State
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import (
    HuggingfaceEndpoint,
    HuggingfacePipeline,
    LlamaCpp,
    Llm,
    Local,
    Openai,
    Options as OpenaiOptions,
    Options1 as HuggingfaceEndpointOptions,
    Options2 as HuggingfacePipelineOptions,
    Options3 as LlamaCppOptions,
    Orchestrator as OrchestratorConfig,
    ThirdParty,
)
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.tooling import ToolingGetToolsRequest, ToolingMethods
from app.shared.messaging.models.db_models import RAGSearchQuery

config_api = ConfigAPI()


def _config_secret_plain(val):
    if val is None:
        return None
    if hasattr(val, "get_secret_value"):
        return val.get_secret_value()
    return val


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

    orchestrator_cfg = await config_api.aget(
        ConfigKeys.services.orchestrator,
        OrchestratorConfig,
        config_timeout=20.0,
    )
    llm_cfg = orchestrator_cfg.llm or Llm()

    try:
        provider = llm_cfg.provider or "openai"
        log_info(f"LLM provider from config: {provider}")
    except Exception as e:
        log_error(f"Failed to get LLM provider from config: {e}", exc_info=True)
        provider = "openai"
        log_warning(f"Using default provider: {provider}")

    if provider == "openai":
        from langchain_openai import ChatOpenAI

        log_info("Initializing OpenAI LLM...")
        try:
            third_party = llm_cfg.third_party or ThirdParty()
            openai_config = third_party.openai or Openai()
            openai_options = openai_config.options or OpenaiOptions()

            if openai_options.model:
                model_name = openai_options.model
                log_info(f"Attempting to initialize OpenAI LLM with model: {model_name}")

                key_from_cfg = _config_secret_plain(openai_options.api_key)
                api_key = (key_from_cfg or "").strip() or os.getenv("OPENAI_API_KEY")
                if not api_key:
                    log_error(
                        "OpenAI API key not set. Set services.orchestrator.llm.third_party.openai.options.api_key "
                        "in config.json or OPENAI_API_KEY in .env"
                    )
                    llm = None
                else:
                    log_debug(f"OpenAI API key found (length: {len(api_key)} chars)")
                    try:
                        # Grab all non-None fields from options dynamically using model_dump
                        opts = openai_options.model_dump(exclude_unset=True, exclude_none=True)
                        opts["api_key"] = api_key

                        safe_options = {k: v for k, v in opts.items() if k != "api_key"}
                        log_debug(f"OpenAI initialization options: {safe_options}")

                        llm = ChatOpenAI(**opts)
                        log_info(f"Successfully initialized OpenAI LLM with model: {model_name}")
                    except Exception as e:
                        log_error(f"Failed to initialize OpenAI LLM: {e}", exc_info=True)
                        log_error(f"Error type: {type(e).__name__}")
                        llm = None
            else:
                log_error("OpenAI options not found or model not specified in config")
                llm = None
        except Exception as e:
            log_error(f"Error fetching OpenAI config: {e}", exc_info=True)
            llm = None

    elif provider == "huggingface_endpoint":
        log_info("Initializing HuggingFace Endpoint LLM...")
        try:
            third_party = llm_cfg.third_party or ThirdParty()
            hf_endpoint_config = third_party.huggingface_endpoint or HuggingfaceEndpoint()
            hf_endpoint_options = hf_endpoint_config.options or HuggingfaceEndpointOptions()

            if hf_endpoint_options:
                log_info("HuggingFace Endpoint options retrieved")
        except Exception as e:
            log_error(f"Error fetching HuggingFace Endpoint config: {e}", exc_info=True)
            hf_endpoint_options = HuggingfaceEndpointOptions()

        hf_token = (_config_secret_plain(hf_endpoint_options.access_token) or "").strip()
        if hf_endpoint_options.endpoint_url and hf_token:
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
                    endpoint_options = hf_endpoint_options.model_dump(
                        exclude_unset=True, exclude_none=True
                    )
                    if "access_token" in endpoint_options:
                        raw_tok = endpoint_options.pop("access_token")
                        endpoint_options["huggingfacehub_api_token"] = (
                            _config_secret_plain(raw_tok) or ""
                        )
                    if "max_tokens" in endpoint_options:
                        endpoint_options["max_new_tokens"] = endpoint_options.pop("max_tokens")

                    # Create HuggingFace endpoint and chat interface
                    hf_endpoint = HuggingFaceEndpoint(**endpoint_options)
                    llm = ChatHuggingFace(llm=hf_endpoint)
                    log_info(
                        f"Initialized HuggingFace Endpoint LLM with URL: {endpoint_options.get('endpoint_url')}"
                    )
                except Exception as e:
                    log_error(f"Failed to initialize HuggingFace Endpoint: {e}")
                    llm = None

    elif provider == "huggingface_pipeline":
        log_info("Initializing HuggingFace Pipeline LLM...")
        try:
            local_config = llm_cfg.local or Local()
            hf_pipeline_config = local_config.huggingface_pipeline or HuggingfacePipeline()
            hf_pipeline_options = hf_pipeline_config.options or HuggingfacePipelineOptions()
        except Exception as e:
            log_error(f"Error fetching HuggingFace Pipeline config: {e}", exc_info=True)
            hf_pipeline_options = None

        # Check environment variable first
        model_id = os.getenv("AURORA_HUGGINGFACE_MODEL_ID")
        if model_id is None and hf_pipeline_options and hf_pipeline_options.model:
            model_id = hf_pipeline_options.model

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
                    use_hardware_acceleration = get_use_hardware_acceleration("llm")
                    device_value = (
                        0 if use_hardware_acceleration == "cuda" else -1
                    )  # 0 for GPU, -1 for CPU

                    pipeline_options = (
                        hf_pipeline_options.model_dump(exclude_unset=True, exclude_none=True)
                        if hf_pipeline_options
                        else {}
                    )
                    pipeline_kwargs = pipeline_options.pop("pipeline_kwargs", {})
                    model_kwargs = pipeline_options.pop("model_kwargs", {})

                    for key, value in pipeline_options.items():
                        if key not in ["temperature", "max_tokens", "model"]:
                            model_kwargs[key] = value

                    # Create HuggingFace pipeline
                    pipeline = HuggingFacePipeline.from_model_id(
                        model_id=model_id,
                        task="text-generation",
                        device=device_value,
                        pipeline_kwargs=pipeline_kwargs,
                        model_kwargs=model_kwargs,
                    )

                    log_info(
                        "HuggingFace Pipeline initialized successfully, initializing ChatHuggingFace..."
                    )
                    llm = ChatHuggingFace(llm=pipeline, verbose=True, model_id=model_id)
                    device_name = "GPU" if use_hardware_acceleration else "CPU"
                    log_info(
                        f"Initialized HuggingFace Pipeline LLM with model: {model_id} on device: {device_name}"
                    )
                except Exception as e:
                    log_error(f"Failed to initialize HuggingFace Pipeline: {e}")
                    llm = None

    elif provider == "llama_cpp":
        log_info("Initializing Llama.cpp LLM...")
        try:
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
            model_path = os.getenv("AURORA_LLAMA_CPP_MODEL_PATH")
            log_debug(
                f"AURORA_LLAMA_CPP_MODEL_PATH env var: {model_path if model_path else 'Not set'}"
            )

            if model_path is None:
                try:
                    local_config = llm_cfg.local or Local()
                    llama_config = local_config.llama_cpp or LlamaCpp()
                    llama_options = llama_config.options or LlamaCppOptions()
                    model_path = llama_options.model_path or None
                    log_info(
                        f"Llama.cpp model path from config: {model_path if model_path else 'Not found'}"
                    )
                except Exception as e:
                    log_error(f"Error fetching Llama.cpp config: {e}", exc_info=True)
                    model_path = None

            if model_path:
                from app.shared.path_utils import resolve_path

                resolved_model_path = resolve_path(model_path)

                try:
                    local_config = llm_cfg.local or Local()
                    llama_config = local_config.llama_cpp or LlamaCpp()
                    llama_options = llama_config.options or LlamaCppOptions()

                    llama_init_options = llama_options.model_dump(
                        exclude_unset=True, exclude_none=True
                    )
                    llama_init_options["model_path"] = str(resolved_model_path)
                    llama_init_options["disable_streaming"] = True

                    log_info(
                        f"Attempting to initialize Llama.cpp LLM with model: {resolved_model_path}"
                    )
                    llm = ChatLlamaCpp(**llama_init_options)
                    log_info(
                        f"Successfully initialized Llama.cpp LLM with model: {resolved_model_path}"
                    )
                except Exception as e:
                    log_error(f"Failed to initialize Llama.cpp LLM: {e}", exc_info=True)
                    llm = None
            else:
                log_error("Llama.cpp model path not configured")
                llm = None

    if llm is not None:
        log_info(f"✅ LLM successfully initialized with provider: {provider}")
    else:
        log_error(f"❌ Failed to initialize LLM with provider: {provider}")


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
            if (
                args_schema_dict
                and isinstance(args_schema_dict, dict)
                and "properties" in args_schema_dict
            ):
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
                                field_defs[field_name] = (
                                    field_type,
                                    Field(..., description=field_description),
                                )
                            else:
                                field_defs[field_name] = (field_type, ...)
                        else:
                            # Optional field - use Field with default None and description if available
                            if field_description:
                                field_defs[field_name] = (
                                    field_type,
                                    Field(default=None, description=field_description),
                                )
                            else:
                                field_defs[field_name] = (field_type, None)

                # Create the Pydantic model dynamically (empty field_defs creates empty model)
                args_model = create_model(f"{tool_name}Args", **field_defs)
            else:
                # No arguments
                args_model = create_model(f"{tool_name}Args")

            # Create a dummy function for the tool (execution happens via bus)
            # Use a factory function to properly capture tool_name and avoid B023
            def _create_dummy_func(name: str):
                def func(**kwargs):
                    raise NotImplementedError(
                        f"Tool {name} should be executed via message bus, not directly"
                    )

                return func

            dummy_func = _create_dummy_func(tool_name)

            # Create the StructuredTool
            tool = StructuredTool(
                name=tool_name,
                description=tool_description,
                func=dummy_func,
                args_schema=args_model,
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
                f"{item['value']['text']} (score: {item.get('search_score', 'N/A')})"
                for item in items_data
                if item.get("value", {}).get("text")
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
        ToolingGetToolsRequest(query=state["messages"][-1].content, top_k=10),
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
