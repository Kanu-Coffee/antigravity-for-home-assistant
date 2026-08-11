"""Regression checks for the standalone v2 documentation contract runner."""

from __future__ import annotations

import importlib.util
import inspect
import subprocess
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "tests" / "test_v2_docs_contract.py"


def load_contract() -> ModuleType:
    spec = importlib.util.spec_from_file_location("v2_docs_contract_runner", CONTRACT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_direct_runner_pass_names_match_module_tests_exactly() -> None:
    module = load_contract()
    module_tests = {
        name: value
        for name, value in vars(module).items()
        if name.startswith("test_") and callable(value)
    }
    assert module_tests
    assert all(not inspect.signature(test).parameters for test in module_tests.values())

    completed = subprocess.run(
        [sys.executable, str(CONTRACT)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr

    pass_names = [
        line.removeprefix("PASS ")
        for line in completed.stdout.splitlines()
        if line.startswith("PASS ")
    ]
    assert pass_names == sorted(module_tests)


def test_direct_runner_rejects_test_callable_with_parameters() -> None:
    module = load_contract()

    def requires_argument(required: object) -> None:
        del required

    namespace = dict(vars(module))
    namespace["test_requires_argument"] = requires_argument
    try:
        module.direct_test_checks(namespace)
    except AssertionError as error:
        assert "zero-argument test_* callables: test_requires_argument" in str(error)
    else:
        raise AssertionError("direct runner accepted a test callable with parameters")
