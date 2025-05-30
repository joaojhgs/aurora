from langchain_google_community import CalendarToolkit
from langchain_google_community.calendar.utils import (
    build_resource_service,
)
from app.helpers.getGoogleCredentials import google_credentials


api_resource = build_resource_service(credentials=google_credentials)

toolkit = CalendarToolkit()

gcalendar_tools = toolkit.get_tools()