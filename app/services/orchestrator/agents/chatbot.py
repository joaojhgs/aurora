from datetime import datetime

from langchain_core.tools import StructuredTool
from pydantic import create_model

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()
from app.shared.messaging.models.db_models import RAGSearchQuery
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.helpers.getUseHardwareAcceleration import getUseHardwareAcceleration
from app.messaging import DBTopics, MessageBus, ToolingTopics
from app.messaging.priority_helpers import get_interactive_priority
from app.services.orchestrator.state import State
from app.shared.messaging.models.tooling_models import GetToolsQuery

"""
The chatbot agent is the main agent coordinator in the graph.
"""

# Init LLM
llm = None

# Get the configured LLM provider
provider = config_api.get("general.llm.provider", "openai")

if provider == "openai":
    from langchain_openai import ChatOpenAI

    openai_options = config_api.get_section("general.llm.third_party.openai.options")
    if openai_options and openai_options.get("model"):
        try:
            llm = ChatOpenAI(**openai_options)
            log_info(f"Initialized OpenAI LLM with model: {openai_options['model']}")
        except Exception as e:
            log_warning(f"Failed to initialize OpenAI LLM: {e}. LLM will be None.")
            llm = None

elif provider == "huggingface_endpoint":
    hf_endpoint_options = config_api.get_section("general.llm.third_party.huggingface_endpoint.options")

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
    hf_pipeline_options = config_api.get_section("llm.local.huggingface_pipeline.options")

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
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp

    # Import handler to register it on the directory of chat formats
    from app.services.orchestrator.chat_llama_cpp_fn_handler import *  # noqa: F401,F403

    llama_options = config_api.get_section("llm.local.llama_cpp.options")
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
    # Check if llm is initialized
    if llm is None:
        raise ValueError("The language model (llm) is not initialized.")

    # Vector search for the history of memories via bus
    try:
        result = await bus.request(
            DBTopics.RAG_SEARCH,
            RAGSearchQuery(namespace=("main", "memories"), query=state["messages"][-1].content, limit=3),
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
        ToolingTopics.GET_TOOLS,
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
