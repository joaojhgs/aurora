from langchain_google_community import GmailToolkit

# Credentials must be loaded first via async_get_google_credentials() (see tools_manager).
toolkit = GmailToolkit()

gmail_tools = toolkit.get_tools()
