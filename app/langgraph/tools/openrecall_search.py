from langchain_core.tools import tool

from modules.openrecall.openrecall.database import search_entries


@tool
def openrecall_search_tool(
    input: str,
):
    """
    Search in a vector database that stores prints of the user computer across timestamps alongside the OCR text from that print
    This tool should be used whenever the LLM deems the user is asking for something related to what he did in the past, allowing the LLM to have a better understanding of the user's context
    The LLM should fill the content input with the user query adapted for a semantic search in the database
    """

    results = search_entries(input, 3)
    filtered_results = [
        (app, title, text, timestamp) for app, title, text, timestamp, id, embedding in results
    ]
    return filtered_results
