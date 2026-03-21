import asyncio

from langchain_google_community.calendar.utils import (
    get_google_credentials,
)

from app.shared.config.interface import ConfigAPI

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


async def _async_get_scopes() -> list:
    """Get scopes asynchronously from config service."""
    scopes = []

    if await config_api.aget("plugins.gmail.activate", False):
        scopes.append("https://mail.google.com/")

    if await config_api.aget("plugins.gcalendar.activate", False):
        scopes.append("https://www.googleapis.com/auth/calendar")

    return scopes


async def async_get_google_credentials():
    """Get Google credentials asynchronously with proper config loading.

    Uses await config_api.aget() to properly access config in async context.
    Thread-safe via asyncio.Lock (created lazily so import does not require a running loop).

    Also updates the module-level ``google_credentials`` alias so synchronous code that
    imported it sees the same object after the first successful load.
    """
    global _google_credentials, _credentials_lock, google_credentials
    if _credentials_lock is None:
        _credentials_lock = asyncio.Lock()
    async with _credentials_lock:
        if _google_credentials is None:
            scopes = await _async_get_scopes()
            credentials_file = await config_api.aget("plugins.google.credentials_file", None)
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
