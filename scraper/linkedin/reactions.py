"""
Scrape who reacted to a LinkedIn post via LinkedIn's internal Voyager API.
No browser / Selenium required.

Strategy
--------
- linkedin-api authenticates via HTTP (cookie-based, no browser).
- We extract the activity URN from the post URL.
- We call LinkedIn's /voyager/api/reactions endpoint through the
  authenticated session, paging until we hit the requested limit.
"""
import re
import logging
from urllib.parse import unquote

from .auth import create_linkedin_client

logger = logging.getLogger(__name__)

# Matches urn:li:activity:..., urn:li:ugcPost:..., urn:li:share:...
_URN_RE = re.compile(r"urn:li:(?:activity|ugcPost|share|article):\d+", re.I)
# Matches the numeric ID embedded in post slugs like "activity6803419522233446400"
_ACTIVITY_SLUG_RE = re.compile(r"activity(\d{10,})", re.I)


def _extract_urn(post_url: str) -> str:
    """
    Extract the LinkedIn URN from various post URL formats:
      - https://www.linkedin.com/feed/update/urn:li:activity:123456/
      - https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A123456/
      - https://www.linkedin.com/posts/user_slug-activity123456-xxxx/
    """
    for url in (post_url, unquote(post_url)):
        m = _URN_RE.search(url)
        if m:
            return m.group(0)

    m = _ACTIVITY_SLUG_RE.search(post_url)
    if m:
        return f"urn:li:activity:{m.group(1)}"

    raise ValueError(f"Cannot extract activity URN from LinkedIn URL: {post_url}")


def _urn_numeric_id(urn: str) -> str:
    """Return just the numeric part of a URN, e.g. '123456' from 'urn:li:activity:123456'."""
    return urn.rsplit(":", 1)[-1]


def _fetch_reactions_page(api, urn: str, start: int, count: int) -> list[dict]:
    """Fetch one page of raw reaction elements from the Voyager API."""
    try:
        # Uses the same endpoint as linkedin-api's get_post_reactions()
        res = api._fetch(
            "/voyagerSocialDashReactions",
            params={
                "decorationId": "com.linkedin.voyager.dash.deco.social.ReactionsByTypeWithProfileActions-13",
                "count": count,
                "q": "reactionType",
                "start": start,
                "threadUrn": urn,
            },
        )
        data: dict = res.json()
        return data.get("elements") or []
    except Exception as exc:
        logger.warning("Reaction page fetch failed (start=%d): %s", start, exc)
        return []


def _parse_reactor(elem: dict) -> dict | None:
    """
    Convert a raw Voyager reaction element into our standard reactor dict.
    Handles both the normalized JSON format and the miniProfile format.
    """
    actor = elem.get("actor") or {}

    # ── Name ──────────────────────────────────────────────────────────
    name = ""
    # Check structured name objects first
    for key in ("name", "title"):
        val = actor.get(key, "")
        if isinstance(val, dict):
            name = val.get("text", "")
        elif isinstance(val, str):
            name = val
        if name:
            break
    # Compose from firstName + lastName (miniProfile format)
    if not name:
        first = actor.get("firstName", "")
        last = actor.get("lastName", "")
        name = f"{first} {last}".strip()

    # ── Headline ───────────────────────────────────────────────────────
    headline = ""
    for key in ("description", "subtitle", "occupation", "headline"):
        val = actor.get(key, "")
        if isinstance(val, dict):
            headline = val.get("text", "")
        elif isinstance(val, str):
            headline = val
        if headline:
            break

    # ── Profile URL ────────────────────────────────────────────────────
    profile_url = ""
    nav = actor.get("navigationUrl", "") or actor.get("url", "")
    pub_id = actor.get("publicIdentifier", "")
    if "/in/" in nav:
        profile_url = nav.split("?")[0].rstrip("/")
        if not profile_url.startswith("http"):
            profile_url = "https://www.linkedin.com" + profile_url
    elif pub_id:
        profile_url = f"https://www.linkedin.com/in/{pub_id}"

    reaction_type = (elem.get("reactionType") or "").strip()

    if not name and not profile_url:
        return None

    return {
        "fullName": name.strip(),
        "headline": headline.strip(),
        "profileUrl": profile_url,
        "reactionType": reaction_type,
    }


def scrape_reactions(post_url: str, email: str, password: str, limit: int = 20) -> list[dict]:
    """
    Return up to *limit* reactor profiles from the given LinkedIn post URL.
    Uses LinkedIn's Voyager API — no browser required.

    Each dict: fullName, headline, profileUrl, reactionType.
    """
    api = create_linkedin_client(email, password)
    urn = _extract_urn(post_url)
    logger.info("Fetching reactions for %s (limit=%d)", urn, limit)

    results: list[dict] = []
    seen: set[str] = set()
    start = 0
    page_size = min(50, limit)

    while len(results) < limit:
        fetch_count = min(page_size, limit - len(results))
        elements = _fetch_reactions_page(api, urn, start, fetch_count)
        if not elements:
            break

        for elem in elements:
            reactor = _parse_reactor(elem)
            if not reactor:
                continue
            key = reactor["profileUrl"] or reactor["fullName"]
            if key in seen:
                continue
            seen.add(key)
            results.append(reactor)
            if len(results) >= limit:
                break

        if len(elements) < fetch_count:
            break  # No more pages
        start += fetch_count

    logger.info("Fetched %d reactor(s)", len(results))
    return results
