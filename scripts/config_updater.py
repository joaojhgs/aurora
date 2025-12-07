#!/usr/bin/env python3
"""
Aurora Configuration Manager Script
===================================

Helper script to update Aurora configuration based on setup choices.
Used by setup.sh to maintain consistent configuration.
"""

import argparse
import os
import sys

from app.config.config_manager import ConfigManager

# Add the root directory to path to import app modules
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, root_dir)


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
                config.set("llm.local.huggingface_pipeline.options.torch_dtype", "float32", save=False)

        print(f"  ✅ Configured HuggingFace pipeline with device: {config.get('llm.local.huggingface_pipeline.options.device')}")

    elif provider_type == "llama_cpp":
        # Set up llama-cpp-python configuration
        config.set("llm.provider", "llama_cpp", save=False)

        if gpu_backend:
            # Configure GPU layers based on backend
            if gpu_backend in ["cuda", "rocm", "metal"]:
                config.set("llm.local.llama_cpp.options.n_gpu_layers", 35, save=False)  # Use most GPU layers
            else:
                config.set("llm.local.llama_cpp.options.n_gpu_layers", 0, save=False)  # CPU only

        print(f"  ✅ Configured llama-cpp with GPU layers: {config.get('llm.local.llama_cpp.options.n_gpu_layers')}")

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
    parser.add_argument("--feature-level", choices=["core", "full", "dev"], help="Feature level to configure")
    parser.add_argument("--setup-keys", action="store_true", help="Show API key setup instructions")
    parser.add_argument("--tts-gpu", action="store_true", help="Enable GPU acceleration for TTS")
    parser.add_argument("--stt-gpu", action="store_true", help="Enable GPU acceleration for STT")

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

        if not any([args.provider, args.feature_level, args.backend, args.setup_keys]):
            parser.print_help()

    except Exception as e:
        print(f"❌ Error updating configuration: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
