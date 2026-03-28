"""
LinkedIn authentication using the unofficial linkedin-api library.
No browser / Selenium required — uses LinkedIn's internal Voyager API.
Cookies are cached on disk so re-authentication only happens when the session expires.
"""
import logging
from linkedin_api import Linkedin

logger = logging.getLogger(__name__)

# Module-level cache so we don't recreate the client on every request
_client_cache: dict[str, Linkedin] = {}


def create_linkedin_client(email: str, password: str) -> Linkedin:
    """
    Return an authenticated Linkedin API client.
    Reuses a cached client if one exists for this email; otherwise creates a new one.
    """
    cache_key = email.lower().strip()
    if cache_key in _client_cache:
        logger.debug("Reusing cached LinkedIn client for %s", email)
        return _client_cache[cache_key]

    logger.info("Authenticating LinkedIn client for %s ...", email)
    try:
        client = Linkedin(email, password, authenticate=True)
        _client_cache[cache_key] = client
        logger.info("LinkedIn authentication OK")
        return client
    except Exception as exc:
        raise RuntimeError(
            f"LinkedIn login failed — check credentials or try again later: {exc}"
        ) from exc
