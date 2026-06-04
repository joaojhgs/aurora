"""Tests for Enhancement D — Room invite code management in config_updater.py."""

import json
import os
import sys

import cryptography.exceptions
import pytest

# Ensure scripts directory is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from scripts.config_updater import (
    _derive_invite_key,
    _open_invite,
    _seal_invite,
)


class TestSealOpenRoundtrip:
    """Test the low-level crypto helpers."""

    def test_seal_open_roundtrip(self):
        """Seal then open returns the original data."""
        key = _derive_invite_key("test-passphrase")
        data = {"v": 1, "room": "aurora-abc123", "password": "secret"}

        sealed = _seal_invite(key, data)
        assert isinstance(sealed, str)
        assert len(sealed) > 0

        opened = _open_invite(key, sealed)
        assert opened == data

    def test_wrong_passphrase_fails(self):
        """Opening with wrong passphrase raises an error."""
        key_a = _derive_invite_key("passphrase-a")
        key_b = _derive_invite_key("passphrase-b")
        data = {"v": 1, "room": "test-room"}

        sealed = _seal_invite(key_a, data)

        with pytest.raises(cryptography.exceptions.InvalidTag):
            _open_invite(key_b, sealed)

    def test_different_keys_produce_different_output(self):
        """Different passphrases produce different sealed output."""
        key_a = _derive_invite_key("passphrase-a")
        key_b = _derive_invite_key("passphrase-b")
        data = {"v": 1, "room": "test-room"}

        sealed_a = _seal_invite(key_a, data)
        sealed_b = _seal_invite(key_b, data)

        assert sealed_a != sealed_b


class TestExportImport:
    """Test the export/import workflow via config_updater functions."""

    def test_export_import_roundtrip(self, tmp_path, monkeypatch):
        """Export then import restores the room config."""
        from unittest.mock import MagicMock, patch

        # Mock ConfigManager for export
        export_config = MagicMock()
        export_config.get.side_effect = lambda key, default=None: {
            "services.gateway.webrtc.room": "aurora-test123",
            "services.gateway.webrtc.password": "super-secret",
            "services.gateway.webrtc.app_id": "aurora",
            "services.gateway.signaling_mqtt.brokers": ["wss://broker.emqx.io:8084/mqtt"],
            "services.gateway.signaling_mqtt.topic_root": "aurora",
        }.get(key, default)

        # Capture the invite code from export
        captured_output = []
        monkeypatch.setattr(
            "builtins.print", lambda *args: captured_output.append(" ".join(str(a) for a in args))
        )

        with patch("scripts.config_updater.ConfigManager", return_value=export_config):
            from scripts.config_updater import export_room_invite

            export_room_invite(passphrase="test123")

        # Extract the invite code (it's the line between the separator lines)
        code_lines = [
            line
            for line in captured_output
            if not line.startswith("=")
            and not line.startswith("Share")
            and not line.startswith("Tip")
            and not line.startswith("AURORA")
        ]
        invite_code = code_lines[0].strip() if code_lines else ""
        assert len(invite_code) > 0

        # Mock ConfigManager for import
        import_config = MagicMock()
        set_calls = {}

        def mock_set(key, value, save=False):
            set_calls[key] = value

        import_config.set = mock_set

        captured_output.clear()

        with patch("scripts.config_updater.ConfigManager", return_value=import_config):
            from scripts.config_updater import import_room_invite

            import_room_invite(invite_code, passphrase="test123")

        assert set_calls["services.gateway.webrtc.room"] == "aurora-test123"
        assert set_calls["services.gateway.webrtc.password"] == "super-secret"
        assert set_calls["services.gateway.signaling_mqtt.brokers"] == [
            "wss://broker.emqx.io:8084/mqtt"
        ]

    def test_export_fails_on_default_room(self, monkeypatch):
        """Export fails when room is still at default."""
        from unittest.mock import MagicMock, patch

        config = MagicMock()
        config.get.side_effect = lambda key, default=None: {
            "services.gateway.webrtc.room": "default",
            "services.gateway.webrtc.password": "",
        }.get(key, default)

        with patch("scripts.config_updater.ConfigManager", return_value=config):
            from scripts.config_updater import export_room_invite

            with pytest.raises(SystemExit):
                export_room_invite()

    def test_import_preserves_other_config(self, monkeypatch):
        """Import only changes gateway config keys, not other keys."""
        from unittest.mock import MagicMock, patch

        # Create a valid invite code first
        key = _derive_invite_key("default-passphrase")
        data = {
            "v": 1,
            "app_id": "aurora",
            "room": "aurora-imported",
            "password": "imported-pass",
            "brokers": ["wss://test:8084/mqtt"],
            "topic_root": "aurora",
            "created_at": "2025-01-01T00:00:00Z",
        }
        invite_code = _seal_invite(key, data)

        import_config = MagicMock()
        set_calls = {}

        def mock_set(key, value, save=False):
            set_calls[key] = value

        import_config.set = mock_set

        monkeypatch.setattr("builtins.print", lambda *args: None)

        with patch("scripts.config_updater.ConfigManager", return_value=import_config):
            from scripts.config_updater import import_room_invite

            import_room_invite(invite_code, passphrase="default-passphrase")

        # Only gateway keys should be set
        expected_keys = {
            "services.gateway.webrtc.app_id",
            "services.gateway.webrtc.room",
            "services.gateway.webrtc.password",
            "services.gateway.signaling_mqtt.brokers",
            "services.gateway.signaling_mqtt.topic_root",
        }
        assert set(set_calls.keys()) == expected_keys
