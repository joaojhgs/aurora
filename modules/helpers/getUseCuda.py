import os

def getUseCuda(str):
    env = os.environ[str]
    return "cuda" if env.lower() == "true" else "cpu"