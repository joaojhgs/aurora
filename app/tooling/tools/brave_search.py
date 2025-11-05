from langchain_community.tools import BraveSearch

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()

search_brave_tool = BraveSearch.from_api_key(api_key=config_api.get("plugins.brave_search.api_key"), search_kwargs={"count": 3})
