"""Shared base model for typed service contract inputs and outputs."""

from pydantic import BaseModel


class IOModel(BaseModel):
    """Base class for input and output models in service contracts."""
