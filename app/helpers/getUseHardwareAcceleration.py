import os


def get_use_hardware_acceleration(config_key: str):
    """Get hardware acceleration configuration from environment variables.

    Checks environment variable AURORA_HARDWARE_ACCELERATION_{KEY} (uppercase).
    Falls back to checking if CUDA is available if env var not set.

    Args:
        config_key: Configuration key (e.g., "tts", "stt")

    Returns:
        "cuda" if acceleration is enabled, "cpu" otherwise
    """
    # Check environment variable first (e.g., AURORA_HARDWARE_ACCELERATION_TTS)
    env_key = f"AURORA_HARDWARE_ACCELERATION_{config_key.upper()}"
    env_value = os.getenv(env_key)

    if env_value is not None:
        # Explicitly set via env var
        return "cuda" if env_value.lower() in ("true", "1", "yes", "on") else "cpu"

    # Fallback: check general hardware acceleration env var
    general_env = os.getenv("AURORA_HARDWARE_ACCELERATION")
    if general_env is not None:
        return "cuda" if general_env.lower() in ("true", "1", "yes", "on") else "cpu"

    # Default to CPU if not specified
    return "cpu"
