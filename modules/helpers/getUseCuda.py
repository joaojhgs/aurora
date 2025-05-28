from modules.config.config_manager import config_manager

def getUseCuda(config_key: str):
    """Get CUDA configuration from config manager"""
    use_cuda = config_manager.get(config_key, False)
    return "cuda" if use_cuda else "cpu"