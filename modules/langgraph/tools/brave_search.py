from langchain_community.tools import BraveSearch
import os

def init_brave_search_tool(): return BraveSearch.from_api_key(api_key=os.environ['BRAVE_API_KEY'], search_kwargs={"count": 3})