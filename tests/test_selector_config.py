"""Exercise the selector-to-resolver configuration boundary without API calls."""

import os

import pytest

from llm.cli import selector
from llm.providers import get_provider


@pytest.mark.parametrize("persist", [False, True])
def test_interactive_selection_reaches_resolver(monkeypatch, tmp_path, persist):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    answers = iter(["invalid", "99", "3", "invalid", "0", "2"])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    # Register the environment values with monkeypatch before the selector writes them.
    monkeypatch.setenv("LLM_PROVIDER", "")
    monkeypatch.setenv("LLM_MODEL", "")
    assert selector.interactive_select(persist=persist) == ("ollama", "mistral")
    assert get_provider().get_default_model() == "mistral"
    assert tmp_path.joinpath(".llm.env").read_text() == "LLM_PROVIDER=ollama\nLLM_MODEL=mistral\n"
    assert os.environ["LLM_MODEL"] == ("mistral" if persist else "")


@pytest.mark.parametrize("stage", ["provider", "model"])
def test_cancel_selection_does_not_write_config(monkeypatch, tmp_path, stage):
    monkeypatch.chdir(tmp_path)
    answers = iter([""] if stage == "provider" else ["1", ""])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    assert selector.interactive_select() is None
    assert not tmp_path.joinpath(".llm.env").exists()


@pytest.mark.parametrize("select", [selector.select_provider, selector.select_model])
def test_empty_selection_list(select):
    assert select([]) is None


def test_custom_selector_and_main_exports(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    answers = iter(["1", "1"])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    assert selector.interactive_select([("ollama", "local")], {"ollama": [("custom", "custom")]}) == ("ollama", "custom")
    monkeypatch.setattr(selector, "interactive_select", lambda **kwargs: ("ollama", "custom"))
    selector.main()
    assert "export LLM_MODEL=custom" in capsys.readouterr().out


def test_main_cancel(monkeypatch, capsys):
    monkeypatch.setattr(selector, "interactive_select", lambda **kwargs: None)
    with pytest.raises(SystemExit) as result:
        selector.main()
    assert result.value.code == 0
    assert "Selection cancelled" in capsys.readouterr().out
