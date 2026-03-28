"""
Scrape job title, company, and email from LinkedIn profiles using the
linkedin-api library (no browser / Selenium required).

Strategy
--------
- api.get_profile(public_id) returns structured profile data including
  full name, headline, and current experience (job title + company).
- api.get_profile_contact_info(public_id) returns email if the person
  has made it publicly visible on LinkedIn.
- If no LinkedIn email, fall back to the no-browser email discovery
  pipeline in emails.py (company website → pattern + DNS MX).
"""
import re
import time
import logging

from .auth import create_linkedin_client
from .emails import discover_email_no_browser

logger = logging.getLogger(__name__)

_IN_RE = re.compile(r"/in/([^/?#]+)", re.I)


def _public_id_from_url(url: str) -> str:
    """Extract the vanity slug from a LinkedIn /in/ profile URL."""
    m = _IN_RE.search(url)
    return m.group(1) if m else ""


def _scrape_one_profile(api, url: str, scrape_email: bool) -> dict:
    clean_url = url.split("?")[0].rstrip("/")
    result: dict = {
        "linkedinUrl": clean_url,
        "jobTitle": "",
        "company": "",
        "companyUrl": "",
        "email": "",
        "fullName": "",
    }

    public_id = _public_id_from_url(url)
    if not public_id:
        logger.warning("Cannot extract public_id from URL: %s", url)
        return result

    try:
        profile = api.get_profile(public_id)

        # ── Name ──────────────────────────────────────────────────────
        first = profile.get("firstName", "")
        last = profile.get("lastName", "")
        result["fullName"] = f"{first} {last}".strip()

        # ── Job title + company from most-recent experience ────────────
        experience: list[dict] = profile.get("experience") or []
        if experience:
            exp = experience[0]
            result["jobTitle"] = exp.get("title", "")
            result["company"] = exp.get("companyName", "")
            # Build company LinkedIn URL from universalName if present
            company_obj = exp.get("company") or {}
            universal_name = company_obj.get("universalName", "")
            if universal_name:
                result["companyUrl"] = (
                    f"https://www.linkedin.com/company/{universal_name}/"
                )

        # Fall back to headline if experience is missing
        if not result["jobTitle"]:
            result["jobTitle"] = profile.get("headline", "")

        # ── Email discovery ────────────────────────────────────────────
        if scrape_email:
            email = _get_email(api, public_id, result)
            result["email"] = email

    except Exception as exc:
        logger.warning("Profile API call failed for %s: %s", url, exc)

    return result


def _get_email(api, public_id: str, profile_result: dict) -> str:
    """Try LinkedIn contact info first, then fall back to website/DNS discovery."""
    # Step 1: LinkedIn contact info (free if person shared their email)
    try:
        contact_info = api.get_profile_contact_info(public_id)
        email = contact_info.get("email_address", "") or ""
        if email:
            logger.info("Email via LinkedIn contact info: %s", email)
            return email

        # Extract company website from contact info websites list
        websites: list[dict] = contact_info.get("websites") or []
        company_website = (websites[0].get("url", "") if websites else "")
    except Exception as exc:
        logger.debug("Contact info fetch failed for %s: %s", public_id, exc)
        company_website = ""

    # Step 2/3: website scraping + pattern guessing
    return discover_email_no_browser(
        full_name=profile_result.get("fullName", ""),
        linkedin_url=profile_result.get("linkedinUrl", ""),
        company=profile_result.get("company", ""),
        company_url=profile_result.get("companyUrl", ""),
        company_website=company_website,
    )


def scrape_profiles(
    profile_urls: list[str],
    email: str,
    password: str,
    scrape_email: bool = False,
) -> list[dict]:
    """
    Scrape job title + company (+ optionally email) for every URL.
    Reuses one authenticated API client for the whole batch.
    """
    if not profile_urls:
        return []

    api = create_linkedin_client(email, password)
    results: list[dict] = []

    for url in profile_urls:
        results.append(_scrape_one_profile(api, url, scrape_email))
        time.sleep(0.8)  # polite pacing to avoid rate-limiting

    logger.info("Scraped %d profile(s)", len(results))
    return results


def scrape_emails_for_profiles(
    profiles: list[dict],
    email: str,
    password: str,
) -> list[dict]:
    """
    Run email discovery for profiles that don't already have an email.
    Called as a separate pass after profile data is collected.
    """
    if not profiles:
        return profiles

    api = create_linkedin_client(email, password)

    for p in profiles:
        if p.get("email"):
            continue  # already found — skip

        public_id = _public_id_from_url(p.get("linkedinUrl", ""))
        if not public_id:
            continue

        p["email"] = _get_email(api, public_id, p)
        time.sleep(0.6)

    return profiles
