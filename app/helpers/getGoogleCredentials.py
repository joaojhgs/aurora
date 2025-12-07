from langchain_google_community.calendar.utils import (
    get_google_credentials,
)

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()

scopes = []

# Require access to all activated google plugins at once

if config_api.get("plugins.gmail.activate"):
    scopes.append("https://mail.google.com/")

if config_api.get("plugins.gcalendar.activate"):
    scopes.append("https://www.googleapis.com/auth/calendar")

google_credentials = get_google_credentials(
    token_file=None,
    scopes=scopes,
    client_secrets_file=config_api.get("plugins.google.credentials_file"),
)
