"""Wire-contract and scheduling regressions found in the technical audit."""

import asyncio
import json
import threading
from io import BytesIO
from types import SimpleNamespace

import pytest

from llm.core.types import LLMInput, LLMOutput, Message, Role, ToolCall, ToolDefinition
from llm.providers import get_provider
from llm.providers.astraflow import AstraflowCNProvider, AstraflowProvider
from llm.providers.atlas import AtlasProvider
from llm.providers.claude import ClaudeProvider
from llm.providers.ollama import OllamaProvider
from llm.providers.openai import OpenAIProvider
from llm.tools import ReActAgent, ToolExecutor, ToolRegistry


def history():
    return [
        Message(Role.SYSTEM, "Be helpful"),
        Message(Role.USER, "Search twice"),
        Message(Role.ASSISTANT, "Searching", tool_calls=[
            ToolCall("one", "search", {"query": "café"}),
            ToolCall("two", "search", {"query": "second"}),
        ]),
        Message(Role.TOOL, "first result", name="search", tool_call_id="one"),
        Message(Role.TOOL, "second result", name="search", tool_call_id="two"),
    ]


@pytest.mark.parametrize("provider_class", [OpenAIProvider, AtlasProvider, AstraflowProvider, AstraflowCNProvider])
def test_openai_compatible_history(provider_class):
    captured = {}

    def create(**params):
        captured.update(params)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None),
                                                       finish_reason="stop")], model="test", usage=None)

    provider = provider_class(api_key="test")
    provider.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    messages = history()
    provider.generate(LLMInput(messages=messages))
    calls = captured["messages"][2]["tool_calls"]
    assert calls[0]["type"] == "function"
    assert json.loads(calls[0]["function"]["arguments"]) == {"query": "café"}
    assert captured["messages"][3] == {"role": "tool", "content": "first result", "tool_call_id": "one"}
    assert messages[2].tool_calls[0].arguments == {"query": "café"}


def test_claude_groups_parallel_tool_results():
    captured = {}

    def create(**params):
        captured.update(params)
        return SimpleNamespace(content=[], model="test", usage=SimpleNamespace(input_tokens=1, output_tokens=1),
                               stop_reason="end_turn")

    provider = ClaudeProvider(api_key="test")
    provider.client = SimpleNamespace(messages=SimpleNamespace(create=create))
    provider.generate(LLMInput(messages=history()))
    assert captured["messages"] == [
        {"role": "user", "content": "Search twice"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Searching"},
            {"type": "tool_use", "id": "one", "name": "search", "input": {"query": "café"}},
            {"type": "tool_use", "id": "two", "name": "search", "input": {"query": "second"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "one", "content": "first result"},
            {"type": "tool_result", "tool_use_id": "two", "content": "second result"},
        ]},
    ]


def test_ollama_sends_tools_and_object_arguments(monkeypatch):
    captured = {}

    def urlopen(request, timeout):
        captured.update(json.loads(request.data))
        return BytesIO(b'{"message":{"content":"done"}}')

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    provider = OllamaProvider()
    provider.generate(LLMInput(messages=history(), tools=[ToolDefinition("search", "Search", {"type": "object"})]))
    assert captured["tools"] == [{"type": "function", "function": {
        "name": "search", "description": "Search", "parameters": {"type": "object"}}}]
    assert captured["messages"][2]["tool_calls"][0] == {"function": {"name": "search", "arguments": {"query": "café"}}}
    assert captured["messages"][3] == {"role": "tool", "content": "first result", "tool_name": "search"}


@pytest.mark.parametrize("provider_name", ["openai", "claude", "ollama", "atlas", "astraflow", "astraflow_cn"])
def test_selected_model_is_provider_default(monkeypatch, tmp_path, provider_name):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LLM_PROVIDER", provider_name)
    monkeypatch.setenv("LLM_MODEL", "selected-model")
    assert get_provider().get_default_model() == "selected-model"
    assert get_provider(default_model="explicit-model").get_default_model() == "explicit-model"


def test_saved_model_and_mismatched_provider(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    tmp_path.joinpath(".llm.env").write_text("LLM_PROVIDER=ollama\nLLM_MODEL=saved-model\n")
    assert get_provider().get_default_model() == "saved-model"
    assert get_provider("openai").get_default_model() == "gpt-4o-mini"
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    assert get_provider().get_default_model() == "gpt-4o-mini"


@pytest.mark.parametrize("target", ["provider", "tool"])
async def test_sync_work_does_not_block_loop(target):
    loop_thread = threading.get_ident()
    registry = ToolRegistry()

    def sync_work():
        assert threading.get_ident() != loop_thread
        return "done"

    registry.register(ToolDefinition("work", "", {}), sync_work)
    if target == "tool":
        output = await ToolExecutor(registry).execute_async(ToolCall("one", "work", {}))
        assert not output.is_error
    else:
        provider = SimpleNamespace(generate=lambda request: LLMOutput(content=sync_work()))
        output = await ReActAgent(provider, ToolExecutor(registry)).run(LLMInput(messages=[]))
    assert output.content == "done"


async def test_async_tool_stays_on_event_loop():
    loop = asyncio.get_running_loop()

    async def work():
        assert asyncio.get_running_loop() is loop
        return "done"

    registry = ToolRegistry()
    registry.register(ToolDefinition("work", "", {}), work)
    result = await ToolExecutor(registry).execute_async(ToolCall("one", "work", {}))
    assert result.content == "done"


async def test_ollama_react_round_trip_without_remote_call_ids(monkeypatch):
    payloads = []

    def urlopen(request, timeout):
        payloads.append(json.loads(request.data))
        if len(payloads) == 1:
            return BytesIO(json.dumps({"message": {"content": "", "tool_calls": [
                {"function": {"name": "first", "arguments": {}}},
                {"function": {"name": "second", "arguments": {}}},
            ]}}).encode())
        assert payloads[-1]["messages"][-2:] == [
            {"role": "tool", "content": "one", "tool_name": "first"},
            {"role": "tool", "content": "two", "tool_name": "second"},
        ]
        return BytesIO(b'{"message":{"content":"done"}}')

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    registry = ToolRegistry()
    registry.register(ToolDefinition("first", "", {}), lambda: "one")
    registry.register(ToolDefinition("second", "", {}), lambda: "two")
    result = await ReActAgent(OllamaProvider(), ToolExecutor(registry)).run(
        LLMInput(messages=[Message(Role.USER, "Do both")], tools=registry.list_tools()))
    assert result.content == "done"
    assert len(payloads) == 2


@pytest.mark.parametrize("provider_class", [OpenAIProvider, ClaudeProvider])
def test_explicit_request_model_overrides_selected_default(provider_class):
    captured = {}

    def create(**params):
        captured.update(params)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None),
                                                       finish_reason="stop")],
                               content=[], model=params["model"],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1, prompt_tokens=1,
                                                     completion_tokens=1, total_tokens=2), stop_reason="end_turn")

    provider = provider_class(api_key="test", default_model="selected")
    provider.client = SimpleNamespace(messages=SimpleNamespace(create=create),
                                     chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    provider.generate(LLMInput(messages=[Message(Role.USER, "hi")]))
    assert captured["model"] == "selected"
    provider.generate(LLMInput(messages=[Message(Role.USER, "hi")], model="explicit"))
    assert captured["model"] == "explicit"


async def test_cancellation_propagates_from_async_tool():
    async def work():
        raise asyncio.CancelledError

    registry = ToolRegistry()
    registry.register(ToolDefinition("work", "", {}), work)
    with pytest.raises(asyncio.CancelledError):
        await ToolExecutor(registry).execute_async(ToolCall("one", "work", {}))


async def test_async_callable_object_and_sync_awaitable_result():
    loop = asyncio.get_running_loop()

    class AsyncTool:
        async def __call__(self):
            assert asyncio.get_running_loop() is loop
            return "done"

    async def result():
        return "done"

    registry = ToolRegistry()
    registry.register(ToolDefinition("object", "", {}), AsyncTool())
    registry.register(ToolDefinition("factory", "", {}), lambda: result())
    for name in ("object", "factory"):
        output = await ToolExecutor(registry).execute_async(ToolCall("one", name, {}))
        assert output.content == "done"
