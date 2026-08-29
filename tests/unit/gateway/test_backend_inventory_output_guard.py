"""Protect the checked security inventory from the generic inventory renderer."""

from __future__ import annotations

import sys

import pytest

from scripts.generate_backend_inventory import SECURITY_SURFACE_INVENTORY_PATH, main


def test_generic_backend_generator_rejects_security_inventory_output(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["generate_backend_inventory.py", "--output", str(SECURITY_SURFACE_INVENTORY_PATH)],
    )

    with pytest.raises(SystemExit) as error:
        main()

    assert error.value.code == 2
    assert "dedicated" in capsys.readouterr().err
