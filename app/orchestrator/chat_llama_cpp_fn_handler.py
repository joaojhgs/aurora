from __future__ import annotations

import json
import traceback
from collections.abc import Iterator
from typing import (
    Literal,
    cast,
)

import jinja2
from jinja2.sandbox import ImmutableSandboxedEnvironment
from llama_cpp_cuda import llama
from llama_cpp_cuda import llama_grammar as llama_grammar
from llama_cpp_cuda import llama_types as llama_types
from llama_cpp_cuda.llama_chat_format import (
    _convert_completion_to_chat,
    _convert_completion_to_chat_function,
    _convert_text_completion_logprobs_to_chat,
    _grammar_for_response_format,
    register_chat_completion_handler,
)


@register_chat_completion_handler("function-calling")
def function_calling_handler(
    llama: llama.Llama,
    messages: list[llama_types.ChatCompletionRequestMessage],
    functions: list[llama_types.ChatCompletionFunction] | None = None,
    function_call: llama_types.ChatCompletionRequestFunctionCall | None = None,
    tools: list[llama_types.ChatCompletionTool] | None = None,
    tool_choice: llama_types.ChatCompletionToolChoiceOption | None = None,
    temperature: float = 0.2,
    top_p: float = 0.95,
    top_k: int = 40,
    min_p: float = 0.05,
    typical_p: float = 1.0,
    stream: bool = False,
    stop: str | list[str] | None = [],
    response_format: llama_types.ChatCompletionRequestResponseFormat | None = None,
    max_tokens: int | None = None,
    presence_penalty: float = 0.0,
    frequency_penalty: float = 0.0,
    repeat_penalty: float = 1.1,
    tfs_z: float = 1.0,
    mirostat_mode: int = 0,
    mirostat_tau: float = 5.0,
    mirostat_eta: float = 0.1,
    model: str | None = None,
    logits_processor: llama.LogitsProcessorList | None = None,
    grammar: llama.LlamaGrammar | None = None,
    logprobs: bool | None = None,
    top_logprobs: int | None = None,
    **kwargs,  # type: ignore
) -> llama_types.CreateChatCompletionResponse | Iterator[llama_types.CreateChatCompletionStreamResponse]:
    function_calling_template = (
        "{% for message in messages %}"
        "<|im_start|>{{ message.role }}\n"
        # System message
        "{% if message.role == 'system' %}"
        "{{ message.content }}"
        "{% if tool_calls %}"
        "\n\nYou have access to the following functions:\n"
        "{% for tool in tools %}"
        "\nfunctions.{{ tool.function.name }}:\n"
        "{{ tool.function.parameters | tojson }}"
        "\n{% endfor %}"
        "\n\nYou can respond to users messages with either a single message or one or more function calls."
        "\n\nTo respond with a message begin the message with 'message:', use the following format:"
        "\n\nmessage:"
        "\n<message>"
        "\n\nTo respond with one or more function calls begin the message with 'functions.<function_name>:', use the following format:"
        "\n\nfunctions.<function_name>:"
        '\n{ "arg1": "value1", "arg2": "value2" }'
        "\nfunctions.<function_name>:"
        '\n{ "arg1": "value1", "arg2": "value2" }'
        "{% endif %}"
        "<|im_end|>\n"
        "{% endif %}"
        # User message
        "{% if message.role == 'user' %}"
        "{{ message.content }}"
        "<|im_end|>\n"
        "{% endif %}"
        # Assistant message
        "{% if message.role == 'assistant' %}"
        # Regular message
        "{% if message.content and message.content | length > 0 %}"
        "{% if tool_calls %}"
        "message:\n"
        "{% endif %}"
        "{{ message.content }}"
        "<|im_end|>\n"
        "{% endif %}"
        # Function calls
        "{% if 'tool_calls' in message %}"
        "{% for tool_call in message.tool_calls %}"
        "functions.{{ tool_call.function.name }}:\n"
        "{{ tool_call.function.arguments }}"
        "{% endfor %}"
        "<|im_end|>\n"
        "{% endif %}"
        "{% endif %}"
        # Tool message
        "{% if message.role == 'tool' %}"
        "{{ message.content }}"
        "<|im_end|>\n"
        "{% endif %}"
        "{% endfor %}"
        "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}"
    )
    template_renderer = ImmutableSandboxedEnvironment(
        autoescape=jinja2.select_autoescape(["html", "xml"]),
        undefined=jinja2.StrictUndefined,
    ).from_string(function_calling_template)

    # Convert legacy functions to tools
    if functions is not None:
        tools = [
            {
                "type": "function",
                "function": function,
            }
            for function in functions
        ]

    # Convert legacy function_call to tool_choice
    if function_call is not None:
        if isinstance(function_call, str) and (function_call == "none" or function_call == "auto"):
            tool_choice = function_call
        if isinstance(function_call, dict) and "name" in function_call:
            tool_choice = {
                "type": "function",
                "function": {
                    "name": function_call["name"],
                },
            }

    stop = [stop, "<|im_end|>"] if isinstance(stop, str) else stop + ["<|im_end|>"] if stop else ["<|im_end|>"]

    # Case 1: No tool choice by user
    if tool_choice is None or (isinstance(tool_choice, str) and tool_choice == "none") or tools is None or len(tools) == 0:
        prompt = template_renderer.render(
            messages=messages,
            tools=[],
            tool_calls=None,
            add_generation_prompt=True,
        )

        if response_format is not None and response_format["type"] == "json_object":
            grammar = _grammar_for_response_format(response_format)

        return _convert_completion_to_chat(
            llama.create_completion(
                prompt=prompt,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                min_p=min_p,
                typical_p=typical_p,
                stream=stream,
                stop=stop,
                max_tokens=max_tokens,
                presence_penalty=presence_penalty,
                frequency_penalty=frequency_penalty,
                repeat_penalty=repeat_penalty,
                tfs_z=tfs_z,
                mirostat_mode=mirostat_mode,
                mirostat_tau=mirostat_tau,
                mirostat_eta=mirostat_eta,
                model=model,
                logits_processor=logits_processor,
                grammar=grammar,
                logprobs=top_logprobs if logprobs else None,
            ),
            stream=stream,
        )

    # Case 2: Tool choice by user
    if isinstance(tool_choice, dict):
        tool_name = tool_choice["function"]["name"]
        tool = next((tool for tool in tools if tool["function"]["name"] == tool_name), None)
        if tool is None:
            raise ValueError(f"Tool with name '{tool_name}' not found in tools")
        prompt = template_renderer.render(
            messages=messages,
            tools=tools,
            tool_calls=True,
            add_generation_prompt=True,
        )
        prompt += f"functions.{tool_name}:\n"
        try:
            grammar = llama_grammar.LlamaGrammar.from_json_schema(json.dumps(tool["function"]["parameters"]), verbose=llama.verbose)
        except Exception as e:
            grammar = llama_grammar.LlamaGrammar.from_string(llama_grammar.JSON_GBNF, verbose=llama.verbose)
            if llama.verbose:
                print("Failed to parse function body as JSON schema, falling back to default grammar")
                print(e)
        completion_or_chunks = llama.create_completion(
            prompt=prompt,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            min_p=min_p,
            typical_p=typical_p,
            stream=stream,
            stop=stop,
            max_tokens=max_tokens,
            presence_penalty=presence_penalty,
            frequency_penalty=frequency_penalty,
            repeat_penalty=repeat_penalty,
            tfs_z=tfs_z,
            mirostat_mode=mirostat_mode,
            mirostat_tau=mirostat_tau,
            mirostat_eta=mirostat_eta,
            model=model,
            logits_processor=logits_processor,
            grammar=grammar,
        )
        return _convert_completion_to_chat_function(tool_name, completion_or_chunks, stream)

    # Case 3: Automatic tool choice
    assert isinstance(tool_choice, str) and tool_choice == "auto"
    function_names = " | ".join([f'''"functions.{tool['function']['name']}:"''' for tool in tools])
    initial_gbnf_tool_grammar = """root   ::= functions | "message:"\n""" f"""functions ::= {function_names}\n"""
    follow_up_gbnf_tool_grammar = """root   ::= functions | message\n""" """message ::= "message:"\n""" f"""functions ::= {function_names}\n"""
    prompt = template_renderer.render(
        messages=messages,
        tools=tools,
        tool_calls=True,
        add_generation_prompt=True,
    )

    print("[DEBUG] ===== RECEIVED MESSAGES =====")
    for i, message in enumerate(messages):
        print(f"[DEBUG] Message {i}, role: {message.get('role')}")
        if "content" in message and message["content"]:
            print(f"[DEBUG] Content: {message['content'][:100]}...")
        if "tool_calls" in message:
            print(f"[DEBUG] Tool calls: {message['tool_calls']}")
    print("[DEBUG] ===== END MESSAGES =====")

    print("[DEBUG] Tool choice auto prompt:", prompt)

    completion_or_chunks = llama.create_completion(
        prompt=prompt,
        temperature=0,
        top_p=top_p,
        top_k=top_k,
        min_p=min_p,
        typical_p=typical_p,
        stream=False,
        stop=[":"],
        max_tokens=None,
        presence_penalty=presence_penalty,
        frequency_penalty=frequency_penalty,
        repeat_penalty=repeat_penalty,
        tfs_z=tfs_z,
        mirostat_mode=mirostat_mode,
        mirostat_tau=mirostat_tau,
        mirostat_eta=mirostat_eta,
        model=model,
        logits_processor=logits_processor,
        grammar=llama_grammar.LlamaGrammar.from_string(initial_gbnf_tool_grammar, verbose=llama.verbose),
    )
    completion: llama_types.CreateCompletionResponse = completion_or_chunks  # type: ignore
    text = completion["choices"][0]["text"]
    print(f"[DEBUG] Initial choice text: '{text}'")
    if "message" in text:
        print("[DEBUG] Model chose to respond with message")
        completion_result = llama.create_completion(
            prompt=prompt + "message:\n",
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            min_p=min_p,
            typical_p=typical_p,
            stream=stream,
            stop=["<|im_end|>"],
            logprobs=top_logprobs if logprobs else None,
            max_tokens=None,
            presence_penalty=presence_penalty,
            frequency_penalty=frequency_penalty,
            repeat_penalty=repeat_penalty,
            tfs_z=tfs_z,
            mirostat_mode=mirostat_mode,
            mirostat_tau=mirostat_tau,
            mirostat_eta=mirostat_eta,
            model=model,
            logits_processor=logits_processor,
            # grammar=llama_grammar.LlamaGrammar.from_string(
            #     follow_up_gbnf_tool_grammar, verbose=llama.verbose
            # ),
        )

        if not stream:
            print(f"[DEBUG] Message completion: {completion_result['choices'][0]['text']}")

        return _convert_completion_to_chat(
            completion_result,
            stream=stream,
        )

    # One or more function calls
    tool_name = text[len("functions.") :]
    tool = next((tool for tool in tools if tool["function"]["name"] == tool_name), None)
    print(f"[DEBUG] Selected tool_name: '{tool_name}', Found tool: {tool is not None}")

    if not stream:
        completions: list[llama_types.CreateCompletionResponse] = []
        completions_tool_name: list[str] = []
        while tool is not None:
            print(f"[DEBUG] Processing tool: {tool_name}")
            prompt += f"functions.{tool_name}:\n"
            try:
                grammar = llama_grammar.LlamaGrammar.from_json_schema(json.dumps(tool["function"]["parameters"]), verbose=llama.verbose)
            except Exception as e:
                grammar = llama_grammar.LlamaGrammar.from_string(llama_grammar.JSON_GBNF, verbose=llama.verbose)
                if llama.verbose:
                    print("Failed to parse function body as JSON schema, falling back to default grammar")
                    print(e)
            completion_or_chunks = llama.create_completion(
                prompt=prompt,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                min_p=min_p,
                typical_p=typical_p,
                stream=False,
                stop=stop,
                max_tokens=None,
                presence_penalty=presence_penalty,
                frequency_penalty=frequency_penalty,
                repeat_penalty=repeat_penalty,
                tfs_z=tfs_z,
                mirostat_mode=mirostat_mode,
                mirostat_tau=mirostat_tau,
                mirostat_eta=mirostat_eta,
                model=model,
                logits_processor=logits_processor,
                grammar=grammar,
            )
            completion_or_chunks = cast(llama_types.CreateCompletionResponse, completion_or_chunks)
            completions.append(completion_or_chunks)
            completions_tool_name.append(tool_name)

            print(f"[DEBUG] Tool completion: {completion_or_chunks['choices'][0]['text'][:100]}...")

            prompt += completion_or_chunks["choices"][0]["text"]
            prompt += "\n"

            print(f"[DEBUG] Checking for additional tool calls with prompt: {prompt[-100:]}")
            response = llama.create_completion(
                prompt=prompt,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                min_p=min_p,
                typical_p=typical_p,
                stream=False,
                stop=stop,
                max_tokens=None,
                presence_penalty=presence_penalty,
                frequency_penalty=frequency_penalty,
                repeat_penalty=repeat_penalty,
                tfs_z=tfs_z,
                mirostat_mode=mirostat_mode,
                mirostat_tau=mirostat_tau,
                mirostat_eta=mirostat_eta,
                model=model,
                logits_processor=logits_processor,
                grammar=llama_grammar.LlamaGrammar.from_string(follow_up_gbnf_tool_grammar, verbose=llama.verbose),
            )
            response = cast(llama_types.CreateCompletionResponse, response)

            print(f"[DEBUG] Follow-up response: {response['choices'][0]['text']}")

            try:
                text_response = response["choices"][0]["text"]
                print(f"[DEBUG] Full follow-up text: '{text_response}'")
                if text_response.startswith("functions."):
                    tool_name = text_response[len("functions.") :]
                    print(f"[DEBUG] Next tool_name extracted: '{tool_name}'")
                    tool = next((tool for tool in tools if tool["function"]["name"] == tool_name), None)
                    print(f"[DEBUG] Found next tool: {tool is not None}")
                elif text_response.startswith("message:"):
                    print("[DEBUG] Model switched to message response, ending tool calls")
                    tool = None
                elif text_response == "<|im_end|>" or not text_response:
                    print("[DEBUG] Model completed response or returned empty, ending tool calls")
                    tool = None
                else:
                    print(f"[DEBUG] Unexpected response format: '{text_response}'")
                    tool = None
            except Exception as e:
                print(f"[DEBUG] Error parsing next tool: {e}")
                traceback.print_exc()
                tool = None

        # Merge completions
        function_call_dict: (
            dict[str, str]
            | dict[
                Literal["function_call"],
                llama_types.ChatCompletionRequestAssistantMessageFunctionCall,
            ]
        ) = (
            {
                "function_call": {
                    "name": tool_name,
                    "arguments": completions[0]["choices"][0]["text"],
                }
            }
            if len(completions) == 1
            else {}
        )

        print(f"[DEBUG] Completed tool calls. Number of completions: {len(completions)}")
        print(f"[DEBUG] Tool names used: {completions_tool_name}")

        response_dict = {
            "id": "chat" + completion["id"],
            "object": "chat.completion",
            "created": completion["created"],
            "model": completion["model"],
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "index": 0,
                    "logprobs": _convert_text_completion_logprobs_to_chat(completion["choices"][0]["logprobs"]),
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_" + f"_{i}_" + tool_name + "_" + completion["id"],
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": completion["choices"][0]["text"],
                                },
                            }
                            for i, (tool_name, completion) in enumerate(zip(completions_tool_name, completions))
                        ],
                        **function_call_dict,
                    },
                }
            ],
            "usage": {
                "completion_tokens": sum((completion["usage"]["completion_tokens"] if "usage" in completion else 0) for completion in completions),
                "prompt_tokens": sum(completion["usage"]["prompt_tokens"] if "usage" in completion else 0 for completion in completions),
                "total_tokens": sum(completion["usage"]["total_tokens"] if "usage" in completion else 0 for completion in completions),
            },
        }

        print(f"[DEBUG] Returning final response with {len(response_dict['choices'][0]['message'].get('tool_calls', []))} tool calls")
        return response_dict

    raise ValueError("Automatic streaming tool choice is not supported")
