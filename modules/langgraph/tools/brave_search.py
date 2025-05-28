from langchain_community.tools import BraveSearch
import os
from modules.config.config_manager import config_manager

search_brave_tool = BraveSearch.from_api_key(api_key=config_manager.get('plugins.brave_search.api_key'), search_kwargs={"count": 3})