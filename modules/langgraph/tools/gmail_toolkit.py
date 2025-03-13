from langchain_google_community import GmailToolkit
from langchain_google_community.gmail.utils import (
    build_resource_service,
)
from modules.helpers.getGoogleCredentials import google_credentials

api_resource = build_resource_service(credentials=google_credentials)

toolkit = GmailToolkit()

gmail_tools = toolkit.get_tools()