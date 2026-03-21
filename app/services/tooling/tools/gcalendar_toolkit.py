from langchain_google_community import CalendarToolkit

# Credentials must be loaded first via async_get_google_credentials() (see tools_manager).
toolkit = CalendarToolkit()

gcalendar_tools = toolkit.get_tools()
