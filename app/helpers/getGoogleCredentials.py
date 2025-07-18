from langchain_google_community.calendar.utils import (
    get_google_credentials,
)

from app.config.config_manager import config_manager

scopes = []

# Require access to all activated google plugins at once

if config_manager.get("plugins.gmail.activate"):
    scopes.append("https://mail.google.com/")

if config_manager.get("plugins.gcalendar.activate"):
    scopes.append("https://www.googleapis.com/auth/calendar")

google_credentials = get_google_credentials(
    token_file=None,
    scopes=scopes,
    client_secrets_file=config_manager.get("plugins.google.credentials_file"),
)
