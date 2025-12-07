from typing import Annotated

from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


# New messages from both the user and the assistant are persisted in the state
class State(TypedDict):
    # Messages have the type "list". The `add_messages` function
    # in the annotation defines how this state key should be updated
    # (in this case, it appends messages to the list, rather than overwriting them)
    messages: Annotated[list, add_messages]
