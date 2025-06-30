from app.config.config_manager import config_manager


def getUseHardwareAcceleration(config_key: str):
    """Get hardware acceleration configuration from config manager"""
    use_acceleration = config_manager.get("hardware_acceleration" + config_key, False)
    return "cuda" if use_acceleration else "cpu"
