"""
LinkedIn Scraper Microservice
=============================
FastAPI service exposing endpoints consumed by the Next.js pipeline.

Endpoints
---------
  GET  /health              — liveness probe
  POST /scrape/reactions    — scrape who reacted to a post (Selenium + Scrapy)
  POST /scrape/profiles     — deep-dive profile pages for job title / company
  POST /scrape/emails       — no-API email discovery for a list of profiles
  POST /scrape/full         — reactions + profiles + emails in one call (recommended)

Environment variables
---------------------
  LINKEDIN_EMAIL     — LinkedIn account e-mail
  LINKEDIN_PASSWORD  — LinkedIn account password
"""
import os
import logging

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv

# Load from .env.local in the parent directory
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))

from linkedin.reactions import scrape_reactions
from linkedin.profiles import scrape_profiles, scrape_emails_for_profiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="LinkedIn Scraper Service", version="2.0.0")

_EMAIL    = os.environ.get("LINKEDIN_EMAIL", "")
_PASSWORD = os.environ.get("LINKEDIN_PASSWORD", "")


# ── Request models ─────────────────────────────────────────────────────────────

class ReactionsRequest(BaseModel):
    post_url: str
    limit: int = 20


class ProfilesRequest(BaseModel):
    profile_urls: list[str]
    scrape_email: bool = False


class EmailsRequest(BaseModel):
    profiles: list[dict]   # Each dict must have: linkedinUrl, fullName, company, companyUrl


class FullScrapeRequest(BaseModel):
    post_url: str
    limit: int = 20
    scrape_profiles: bool = True   # deep-dive profiles for job title / company
    scrape_emails: bool = True     # run no-API email discovery


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "linkedin_configured": bool(_EMAIL and _PASSWORD)}


@app.post("/scrape/reactions")
async def reactions_endpoint(req: ReactionsRequest):
    """
    Scrape the reactors of a LinkedIn post.

    Returns: ``{ "items": [ { fullName, headline, profileUrl, reactionType }, ... ] }``
    """
    _require_credentials()
    try:
        items = scrape_reactions(req.post_url, _EMAIL, _PASSWORD, req.limit)
        return {"items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/scrape/profiles")
async def profiles_endpoint(req: ProfilesRequest):
    """
    Scrape job title, company, and optionally email from a list of profile pages.

    Returns: ``{ "items": [ { linkedinUrl, jobTitle, company, companyUrl, email? }, ... ] }``
    """
    _require_credentials()
    try:
        items = scrape_profiles(req.profile_urls, _EMAIL, _PASSWORD, req.scrape_email)
        return {"items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/scrape/emails")
async def emails_endpoint(req: EmailsRequest):
    """
    Run email discovery (no external APIs) on a list of already-scraped profiles.

    Each input profile dict should contain: linkedinUrl, fullName, company, companyUrl.
    Returns the same list with an ``email`` field added.
    """
    _require_credentials()
    try:
        enriched = scrape_emails_for_profiles(req.profiles, _EMAIL, _PASSWORD)
        return {"items": enriched}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/scrape/full")
async def full_scrape_endpoint(req: FullScrapeRequest):
    """
    All-in-one endpoint: reactions → profile deep-dive → email discovery.

    This is the recommended endpoint for the Next.js pipeline — one HTTP
    round-trip instead of three, keeping Vercel connection timeouts manageable.

    Returns:
    ```json
    {
      "reactors": [ { fullName, headline, profileUrl, reactionType } ],
      "profiles": [ { linkedinUrl, jobTitle, company, companyUrl, email, fullName } ]
    }
    ```
    The ``profiles`` list is keyed by ``linkedinUrl`` and is merged with
    ``reactors`` on the Next.js side.
    """
    _require_credentials()

    # ── Step 1: Scrape reactions ───────────────────────────────────────
    logger.info("Full scrape — reactions for: %s", req.post_url)
    try:
        reactors = scrape_reactions(req.post_url, _EMAIL, _PASSWORD, req.limit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Reactions failed: {exc}") from exc

    if not reactors:
        return {"reactors": [], "profiles": []}

    # ── Step 2: Profile deep-dive (optional) ──────────────────────────
    profile_data: list[dict] = []
    if req.scrape_profiles:
        urls = [r["profileUrl"] for r in reactors if r.get("profileUrl", "").startswith("http")]
        logger.info("Full scrape — profiles for %d URLs", len(urls))
        try:
            # scrape_email=False here; emails are done in the next step so we
            # can reuse the same browser session via scrape_emails_for_profiles
            profile_data = scrape_profiles(urls, _EMAIL, _PASSWORD, scrape_email=False)
        except Exception as exc:
            logger.warning("Profile scrape failed (non-fatal): %s", exc)
            profile_data = [
                {"linkedinUrl": u, "jobTitle": "", "company": "", "companyUrl": "", "email": "", "fullName": ""}
                for u in urls
            ]

    # ── Step 3: Email discovery (no external APIs) ─────────────────────
    if req.scrape_emails and profile_data:
        # Inject fullName from reactor data (profile scraper derives it from page title,
        # but reactor name is more reliable)
        reactor_by_url = {r["profileUrl"].split("?")[0].rstrip("/"): r for r in reactors}
        for p in profile_data:
            clean = p.get("linkedinUrl", "").split("?")[0].rstrip("/")
            reactor = reactor_by_url.get(clean, {})
            if not p.get("fullName") and reactor.get("fullName"):
                p["fullName"] = reactor["fullName"]

        logger.info("Full scrape — email discovery for %d profiles", len(profile_data))
        try:
            profile_data = scrape_emails_for_profiles(profile_data, _EMAIL, _PASSWORD)
        except Exception as exc:
            logger.warning("Email discovery failed (non-fatal): %s", exc)

    logger.info(
        "Full scrape complete — %d reactors, %d profiles",
        len(reactors), len(profile_data),
    )
    return {"reactors": reactors, "profiles": profile_data}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_credentials() -> None:
    if not _EMAIL or not _PASSWORD:
        raise HTTPException(
            status_code=500,
            detail=(
                "LINKEDIN_EMAIL and LINKEDIN_PASSWORD environment variables must be set. "
                "Add them to your .env file and restart the service."
            ),
        )
