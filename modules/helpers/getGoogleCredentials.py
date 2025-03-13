from langchain_google_community.calendar.utils import (
    get_google_credentials,
)
import os

scopes = []

# Require access to all activated google plugins at once

if(os.getenv('GMAIL_ACTIVATE_PLUGIN')):
    scopes.append("https://mail.google.com/")

if(os.getenv('GCALENDAR_ACTIVATE_PLUGIN')):
    scopes.append("https://www.googleapis.com/auth/calendar")

print()

google_credentials = get_google_credentials(
    token_file=None,
    scopes=scopes,
    client_secrets_file=os.getenv('GOOGLE_CREDENTIALS_FILE'),
)

