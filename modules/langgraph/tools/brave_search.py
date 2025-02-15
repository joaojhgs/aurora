from langchain_community.tools import BraveSearch
import os

search_brave_tool = BraveSearch.from_api_key(api_key=os.environ['BRAVE_API_KEY'], search_kwargs={"count": 3})