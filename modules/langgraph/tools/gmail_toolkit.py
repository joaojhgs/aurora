from langchain_google_community import GmailToolkit
from langchain_google_community.gmail.utils import (
    build_resource_service,
    get_gmail_credentials,
)
import os

credentials = get_gmail_credentials(
    token_file=os.environ['GMAIL_TOKEN_FILE'],
    scopes=["https://mail.google.com/"],
    client_secrets_file=os.getenv('GMAIL_CREDENTIALS_FILE'),
)

api_resource = build_resource_service(credentials=credentials)

toolkit = GmailToolkit()

gmail_tools = toolkit.get_tools()