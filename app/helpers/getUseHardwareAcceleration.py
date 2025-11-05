from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()


def getUseHardwareAcceleration(config_key: str):
    """Get hardware acceleration configuration from config manager"""
    use_acceleration = config_api.get("general.hardware_acceleration." + config_key, False)
    return "cuda" if use_acceleration else "cpu"
