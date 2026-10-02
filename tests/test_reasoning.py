import json
import urllib.request
from io import BytesIO
from types import SimpleNamespace

import pytest

from llm.core.types import LLMInput, Message, Role
from llm.providers.astraflow import AstraflowProvider
from llm.providers.ollama import OllamaProvider
from llm.providers.openai import OpenAIProvider
from llm.providers.reasoning import strip_reasoning

# Answers that mention the tags without carrying reasoning. None of them may be
# changed, whatever the deployment's reasoning format.
LITERAL_ANSWERS = [
    "Wrap it in <think> and </think> tags.",
    "Close it with </think> and nothing else.",
    "</think> comes before <think> here.",
    '{"closing":"</think>","opening":"<think>"}',
    '{"note": "<think>x</think>"}',
]


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("<think>17 * 3 = 51.</think>51", "51"),
        ("\n<think>\nplan\n</think>\n\nanswer", "answer"),
        ('<think>build the object</think>{"answer": 51}', '{"answer": 51}'),
        ('<think>plan</think>{"closing":"</think>"}', '{"closing":"</think>"}'),
        ("plain answer", "plain answer"),
        ("", ""),
        ("<think>cut off by max_tokens", "<think>cut off by max_tokens"),
        # Close-only output is ambiguous without a declared format, so it stays.
        ("17 * 3 = 51.</think>51", "17 * 3 = 51.</think>51"),
    ],
)
def test_strip_reasoning_default(content, expected):
    assert strip_reasoning(content) == expected


@pytest.mark.parametrize("content", LITERAL_ANSWERS)
def test_strip_reasoning_default_preserves_literal_tags(content):
    assert strip_reasoning(content) == content


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("17 * 3 = 51.</think>51", "51"),
        ('build the object\n</think>\n{"answer": 51}', '{"answer": 51}'),
        ("<think>17 * 3 = 51.</think>51", "51"),
        ("plain answer", "plain answer"),
        ("Wrap it in <think> and </think> tags.", "Wrap it in <think> and </think> tags."),
        ("17 * 3 = 51.</think>", ""),
    ],
)
def test_strip_reasoning_prefilled(content, expected):
    assert strip_reasoning(content, prefilled=True) == expected


def _openai_provider(content, **kwargs):
    provider = OpenAIProvider(api_key="test", **kwargs)
    message = SimpleNamespace(content=content, tool_calls=None)
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason="stop")],
        model="spark-x2.5",
        usage=None,
    )
    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **params: response))
    )
    return provider


def _ask(provider, **kwargs):
    return provider.generate(LLMInput(messages=[Message(role=Role.USER, content="17*3?")], **kwargs))


def test_openai_provider_strips_balanced_reasoning():
    assert _ask(_openai_provider("<think>17 * 3 = 51.</think>51")).content == "51"


@pytest.mark.parametrize("content", LITERAL_ANSWERS)
def test_openai_provider_keeps_literal_tags(content):
    assert _ask(_openai_provider(content)).content == content


def test_openai_provider_close_only_needs_opt_in(monkeypatch):
    monkeypatch.delenv("OPENAI_PREFILLED_REASONING", raising=False)
    assert _ask(_openai_provider("17 * 3 = 51.</think>51")).content == "17 * 3 = 51.</think>51"
    assert _ask(_openai_provider("17 * 3 = 51.</think>51", prefilled_reasoning=True)).content == "51"

    monkeypatch.setenv("OPENAI_PREFILLED_REASONING", "true")
    assert _ask(_openai_provider("17 * 3 = 51.</think>51")).content == "51"


def test_hosted_provider_never_strips_close_only(monkeypatch):
    monkeypatch.setenv("OPENAI_PREFILLED_REASONING", "true")
    provider = AstraflowProvider(api_key="test")
    message = SimpleNamespace(content='{"closing":"</think>"}', tool_calls=None)
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason="stop")],
        model="deepseek-v3.2",
        usage=None,
    )
    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **params: response))
    )

    assert _ask(provider).content == '{"closing":"</think>"}'


def _fake_ollama(monkeypatch, content):
    sent = []

    def fake_urlopen(request, timeout):
        sent.append(json.loads(request.data))
        return BytesIO(json.dumps({"message": {"content": content}, "done_reason": "stop"}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return sent


@pytest.mark.parametrize("content", LITERAL_ANSWERS)
def test_ollama_provider_keeps_literal_tags(monkeypatch, content):
    monkeypatch.delenv("OLLAMA_PREFILLED_REASONING", raising=False)
    _fake_ollama(monkeypatch, content)

    assert _ask(OllamaProvider()).content == content


def test_ollama_provider_strips_prefilled_reasoning_when_declared(monkeypatch):
    monkeypatch.delenv("OLLAMA_PREFILLED_REASONING", raising=False)
    _fake_ollama(monkeypatch, "17 * 3 = 51.</think>51")
    assert _ask(OllamaProvider()).content == "17 * 3 = 51.</think>51"
    assert _ask(OllamaProvider(prefilled_reasoning=True)).content == "51"

    monkeypatch.setenv("OLLAMA_PREFILLED_REASONING", "1")
    assert _ask(OllamaProvider()).content == "51"


def test_ollama_stream_flag_still_strips_complete_message(monkeypatch):
    # The provider always requests a single complete message, even when the
    # caller asks for streaming, so stripping sees the whole reply. If chunked
    # streaming is added, this needs an incremental stripper instead.
    sent = _fake_ollama(monkeypatch, '<think>plan</think>{"closing":"</think>"}')

    output = _ask(OllamaProvider(), stream=True)

    assert sent[0]["stream"] is False
    assert output.content == '{"closing":"</think>"}'
