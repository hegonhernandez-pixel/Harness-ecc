"""Translate provider-neutral history into each provider's wire protocol."""

from __future__ import annotations

import json
from typing import Any

from llm.core.types import Message, Role


def openai_messages(messages: list[Message]) -> list[dict[str, Any]]:
    result = []
    for message in messages:
        item = message.to_dict()
        if message.role == Role.TOOL:
            item.pop("name", None)
        if message.tool_calls:
            item["tool_calls"] = [
                {"id": call.id, "type": "function", "function": {
                    "name": call.name, "arguments": json.dumps(call.arguments),
                }}
                for call in message.tool_calls
            ]
        result.append(item)
    return result


def anthropic_messages(messages: list[Message]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    pending_results: list[dict[str, Any]] = []
    for message in messages:
        if message.role == Role.SYSTEM:
            continue
        if message.role == Role.TOOL:
            pending_results.append({
                "type": "tool_result", "tool_use_id": message.tool_call_id,
                "content": message.content,
            })
            continue
        if pending_results:
            result.append({"role": "user", "content": pending_results})
            pending_results = []
        if message.tool_calls:
            blocks: list[dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            blocks.extend({"type": "tool_use", "id": call.id, "name": call.name,
                           "input": call.arguments} for call in message.tool_calls)
            result.append({"role": message.role.value, "content": blocks})
        else:
            result.append({"role": message.role.value, "content": message.content})
    if pending_results:
        result.append({"role": "user", "content": pending_results})
    return result


def ollama_messages(messages: list[Message]) -> list[dict[str, Any]]:
    result = []
    names: dict[str, str] = {}
    for message in messages:
        item: dict[str, Any] = {"role": message.role.value, "content": message.content}
        if message.tool_calls:
            names.update({call.id: call.name for call in message.tool_calls})
            item["tool_calls"] = [
                {"function": {"name": call.name, "arguments": call.arguments}}
                for call in message.tool_calls
            ]
        if message.role == Role.TOOL:
            name = message.name or names.get(message.tool_call_id or "")
            if name:
                item["tool_name"] = name
        result.append(item)
    return result
