"""Strict llama.cpp backend resolution for CPU and CUDA installations."""

from __future__ import annotations

import importlib
from types import ModuleType


def load_llama_cpp_backend() -> ModuleType:
    """Load the available llama.cpp distribution without masking broken installs."""

    try:
        return importlib.import_module("llama_cpp")
    except ModuleNotFoundError as error:
        if error.name != "llama_cpp":
            raise

    try:
        return importlib.import_module("llama_cpp_cuda")
    except ModuleNotFoundError as error:
        if error.name != "llama_cpp_cuda":
            raise
        raise ImportError(
            "Could not import llama-cpp-python. Install the CPU or CUDA llama.cpp package."
        ) from error
