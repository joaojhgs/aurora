#!/usr/bin/env python3
"""
Aurora Configuration Manager Script
===================================

Helper script to update Aurora configuration based on setup choices.
Used by setup.sh to maintain consistent configuration.
"""

import argparse
import base64
import hashlib
import json
import os
import sys

from app.services.config.config_manager import ConfigManager

# Add the root directory to path to import app modules
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, root_dir)

_DEFAULT_PASSPHRASE = "aurora-default-invite-key"


def _derive_invite_key(passphrase: str) -> bytes:
    """Derive a 32-byte AES key from a passphrase using Scrypt."""
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    salt = hashlib.sha256(b"aurora-room-invite").digest()
    kdf = Scrypt(salt=salt, length=32, n=2**16, r=8, p=1)
    return kdf.derive(passphrase.encode())


def _seal_invite(key: bytes, data: dict) -> str:
    """AEAD-seal a dict and return base64url string."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    pt = json.dumps(data, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(nonce, pt, None)
    return base64.urlsafe_b64encode(nonce + ct).decode()


def _open_invite(key: bytes, token: str) -> dict:
    """AEAD-open a base64url token and return the dict."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = base64.urlsafe_b64decode(token)
    nonce, ct = raw[:12], raw[12:]
    pt = AESGCM(key).decrypt(nonce, ct, None)
    return json.loads(pt.decode())


def update_provider_config(provider_type, llm_backend=None, gpu_backend=None):
    """Update LLM provider configuration"""
    config = ConfigManager()

    print(f"🔧 Updating configuration for {provider_type} provider...")

    # Set provider type
    config.set("llm.provider", provider_type, save=False)

    if provider_type == "openai":
        # Default OpenAI configuration
        print("  ✅ Configured for OpenAI")

    elif provider_type == "huggingface_endpoint":
        # Prompt user for HuggingFace endpoint details
        print("  📋 HuggingFace endpoint selected - configure manually in config.json")

    elif provider_type == "huggingface_pipeline":
        # Set up local HuggingFace pipeline
        config.set("llm.provider", "huggingface_pipeline", save=False)

        if gpu_backend:
            # Configure device based on GPU backend
            if gpu_backend in ["cuda", "rocm"]:
                config.set("llm.local.huggingface_pipeline.options.device", "auto", save=False)
                config.set("llm.local.huggingface_pipeline.options.torch_dtype", "auto", save=False)
            else:
                config.set("llm.local.huggingface_pipeline.options.device", "cpu", save=False)
                config.set(
                    "llm.local.huggingface_pipeline.options.torch_dtype", "float32", save=False
                )

        print(
            f"  ✅ Configured HuggingFace pipeline with device: {config.get('llm.local.huggingface_pipeline.options.device')}"
        )

    elif provider_type == "llama_cpp":
        # Set up llama-cpp-python configuration
        config.set("llm.provider", "llama_cpp", save=False)

        if gpu_backend:
            # Configure GPU layers based on backend
            if gpu_backend in ["cuda", "rocm", "metal"]:
                config.set(
                    "llm.local.llama_cpp.options.n_gpu_layers", 35, save=False
                )  # Use most GPU layers
            else:
                config.set("llm.local.llama_cpp.options.n_gpu_layers", 0, save=False)  # CPU only

        print(
            f"  ✅ Configured llama-cpp with GPU layers: {config.get('llm.local.llama_cpp.options.n_gpu_layers')}"
        )

    # Save all changes
    config.save_config()
    print("  💾 Configuration saved")


def update_feature_config(feature_level):
    """Update configuration based on feature level"""
    config = ConfigManager()

    print(f"🎛️ Updating feature configuration for {feature_level} level...")

    if feature_level == "full" or feature_level == "dev":
        # Enable UI for full and dev installations
        config.set("ui.activate", True, save=False)
        print("  ✅ UI enabled")

        # Enable local embeddings
        config.set("embeddings.use_local", True, save=False)
        print("  ✅ Local embeddings enabled")

    if feature_level == "dev":
        # Enable debug mode for development
        config.set("ui.debug", True, save=False)
        print("  ✅ Debug mode enabled")

    # Save all changes
    config.save_config()
    print("  💾 Feature configuration saved")


def update_hardware_config(gpu_backend, tts_gpu=False, stt_gpu=False):
    """Update hardware acceleration configuration"""
    config = ConfigManager()

    print("⚡ Updating hardware acceleration configuration...")

    # Update hardware acceleration settings with all required fields
    if gpu_backend in ["cuda", "rocm"]:
        config.set("hardware_acceleration.llm", True, save=False)
        print(f"  ✅ LLM GPU acceleration enabled ({gpu_backend})")
    else:
        config.set("hardware_acceleration.llm", False, save=False)
        print("  ✅ LLM using CPU")

    config.set("hardware_acceleration.tts", tts_gpu, save=False)
    config.set("hardware_acceleration.stt", stt_gpu, save=False)

    # Ensure all required hardware acceleration fields exist
    config.set("hardware_acceleration.ocr_bg", False, save=False)
    config.set("hardware_acceleration.ocr_curr", False, save=False)

    # Save all changes
    config.save_config()
    print("  💾 Hardware configuration saved")


def setup_api_keys():
    """Prompt user to set up API keys for third-party providers"""
    config = ConfigManager()

    provider = config.get("llm.provider")

    if provider == "openai":
        print("\n🔑 OpenAI API Key Setup")
        print("=" * 40)
        print("To use OpenAI, you need an API key from: https://platform.openai.com/api-keys")
        print("Set your API key in the environment variable: OPENAI_API_KEY")
        print("Or add it to your .env file: OPENAI_API_KEY=your_key_here")

    elif provider == "huggingface_endpoint":
        print("\n🔑 HuggingFace Endpoint Setup")
        print("=" * 40)
        print("Configure your HuggingFace endpoint details in config.json:")
        print("- endpoint_url: Your HuggingFace endpoint URL")
        print("- model: The model name/ID")
        print("- access_token: Your HuggingFace access token")


def export_room_invite(passphrase=None):
    """Generate an invite code from this device's room config."""
    from datetime import datetime, timezone

    config = ConfigManager()

    room = config.get("gateway.webrtc.room", "")
    password = config.get("gateway.webrtc.password", "")

    if not room or room == "default":
        print("❌ Room not configured yet. Start Aurora once to auto-generate.")
        sys.exit(1)

    payload = {
        "v": 1,
        "app_id": config.get("gateway.webrtc.app_id", "aurora"),
        "room": room,
        "password": password,
        "brokers": config.get("gateway.signaling_mqtt.brokers", []),
        "topic_root": config.get("gateway.signaling_mqtt.topic_root", "aurora"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    key = _derive_invite_key(passphrase or _DEFAULT_PASSPHRASE)
    code = _seal_invite(key, payload)

    print("=" * 60)
    print("AURORA ROOM INVITE CODE")
    print("=" * 60)
    print(code)
    print("=" * 60)
    print("Share this code with other devices.")
    if not passphrase:
        print("Tip: Use --passphrase for additional security.")


def import_room_invite(invite_code, passphrase=None):
    """Decode an invite code and update config.json."""
    key = _derive_invite_key(passphrase or _DEFAULT_PASSPHRASE)

    try:
        payload = _open_invite(key, invite_code)
    except Exception:
        print("❌ Failed to decrypt invite code. Wrong passphrase?")
        sys.exit(1)

    if payload.get("v") != 1:
        print(f"❌ Unsupported invite version: {payload.get('v')}")
        sys.exit(1)

    config = ConfigManager()

    config.set("gateway.webrtc.app_id", payload["app_id"], save=False)
    config.set("gateway.webrtc.room", payload["room"], save=False)
    config.set("gateway.webrtc.password", payload["password"], save=False)
    config.set("gateway.signaling_mqtt.brokers", payload["brokers"], save=False)
    config.set("gateway.signaling_mqtt.topic_root", payload["topic_root"], save=False)

    config.save_config()

    print(f"✅ Config updated with room '{payload['room']}' from invite code")
    print(f"   Brokers: {payload['brokers']}")
    print(f"   Created: {payload['created_at']}")
    print("  💾 Configuration saved")


def show_room_info():
    """Print current room configuration."""
    config = ConfigManager()

    room = config.get("gateway.webrtc.room", "(not set)")
    password = config.get("gateway.webrtc.password", "")
    app_id = config.get("gateway.webrtc.app_id", "aurora")
    brokers = config.get("gateway.signaling_mqtt.brokers", [])
    topic_root = config.get("gateway.signaling_mqtt.topic_root", "aurora")

    print("🔗 Aurora Room Configuration:")
    print(f"  App ID:     {app_id}")
    print(f"  Room:       {room}")
    print(f"  Password:   {'(set)' if password else '(empty)'}")
    print(f"  Brokers:    {brokers}")
    print(f"  Topic Root: {topic_root}")


def main():
    parser = argparse.ArgumentParser(description="Update Aurora configuration")
    parser.add_argument(
        "--provider",
        choices=["openai", "huggingface_endpoint", "huggingface_pipeline", "llama_cpp"],
        help="LLM provider type",
    )
    parser.add_argument(
        "--backend",
        choices=["cpu", "cuda", "rocm", "metal", "vulkan", "sycl", "rpc"],
        help="Hardware backend for local models",
    )
    parser.add_argument(
        "--feature-level", choices=["core", "full", "dev"], help="Feature level to configure"
    )
    parser.add_argument("--setup-keys", action="store_true", help="Show API key setup instructions")
    parser.add_argument("--tts-gpu", action="store_true", help="Enable GPU acceleration for TTS")
    parser.add_argument("--stt-gpu", action="store_true", help="Enable GPU acceleration for STT")

    # Room invite commands (Enhancement D)
    parser.add_argument(
        "--room-export",
        action="store_true",
        help="Generate a room invite code for multi-device setup",
    )
    parser.add_argument(
        "--room-import",
        metavar="CODE",
        help="Apply a room invite code to this device's config",
    )
    parser.add_argument(
        "--room-info",
        action="store_true",
        help="Show current room configuration",
    )
    parser.add_argument(
        "--passphrase",
        "-p",
        help="Encryption passphrase for room invite codes (optional)",
    )

    args = parser.parse_args()

    try:
        if args.provider:
            update_provider_config(args.provider, args.backend, args.backend)

        if args.feature_level:
            update_feature_config(args.feature_level)

        if args.backend:
            update_hardware_config(args.backend, args.tts_gpu, args.stt_gpu)

        if args.setup_keys:
            setup_api_keys()

        if args.room_export:
            export_room_invite(args.passphrase)

        if args.room_import:
            import_room_invite(args.room_import, args.passphrase)

        if args.room_info:
            show_room_info()

        if not any([
            args.provider, args.feature_level, args.backend, args.setup_keys,
            args.room_export, args.room_import, args.room_info,
        ]):
            parser.print_help()

    except Exception as e:
        print(f"❌ Error updating configuration: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
