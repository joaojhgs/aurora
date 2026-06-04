import asyncio

from langchain_google_community.calendar.utils import (
    get_google_credentials,
)

from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Gcalendar, Gmail, Google, Plugins, Tooling

config_api = ConfigAPI()

# Lazy-initialized credentials (lock created on first async use — safe event loop).
_google_credentials = None
_credentials_lock: asyncio.Lock | None = None


def _get_scopes_sync() -> list:
    """Get scopes synchronously using defaults.

    This is a fallback - prefer async_get_google_credentials() when possible.
    """
    scopes = []
    # Use defaults since we can't reliably get config at module level
    # These will be properly loaded when credentials are requested via async
    return scopes


async def async_get_google_credentials():
    """Get Google credentials asynchronously with proper config loading.

    Loads ``services.tooling`` as a ``Tooling`` model for Gmail/GCalendar scopes and Google client secrets path.
    Thread-safe via asyncio.Lock (created lazily so import does not require a running loop).

    Also updates the module-level ``google_credentials`` alias so synchronous code that
    imported it sees the same object after the first successful load.
    """
    global _google_credentials, _credentials_lock, google_credentials
    if _credentials_lock is None:
        _credentials_lock = asyncio.Lock()
    async with _credentials_lock:
        if _google_credentials is None:
            tooling = await config_api.aget(ConfigKeys.services.tooling, Tooling)
            plugins = tooling.plugins or Plugins()
            scopes = []
            if (plugins.gmail or Gmail()).activate:
                scopes.append("https://mail.google.com/")
            if (plugins.gcalendar or Gcalendar()).activate:
                scopes.append("https://www.googleapis.com/auth/calendar")

            google = plugins.google or Google()
            credentials_file = google.credentials_file
            if credentials_file is not None and hasattr(credentials_file, "get_secret_value"):
                credentials_file = credentials_file.get_secret_value()
            _google_credentials = get_google_credentials(
                token_file=None,
                scopes=scopes,
                client_secrets_file=credentials_file,
            )
            google_credentials = _google_credentials
        return _google_credentials


def get_cached_google_credentials():
    """Get cached Google credentials if available.

    Returns None if credentials haven't been initialized yet.
    Use async_get_google_credentials() for proper initialization.
    """
    return _google_credentials


# Backward compatibility: updated when async_get_google_credentials() completes
# Code should migrate to using async_get_google_credentials() instead
google_credentials = None
