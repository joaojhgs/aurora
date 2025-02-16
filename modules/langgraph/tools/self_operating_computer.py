from langchain_core.tools import tool
from modules.self_operating_computer.operate.operate import main as operate
from threading import Thread


@tool
def self_operating_computer_tool(
    objective: str,
):
    """
    This tool allow the LLM to pass forward the user request to another agent called "self-operating-computer", which sole purpose it to control the computer and achieve it's objective
    The LLM should use this tool whenever it deems the user is asking for something that can be achieved by controlling the computer
    The input should be the user query turned into an "objective
    """
    # Start the self-operating-computer agent in a new thread
    thread = Thread(target=operate, args=("o1-with-ocr", objective, False, False))
    thread.start()
    
    return "O agente de controle do computador foi iniciado, a tarefa começará em breve"