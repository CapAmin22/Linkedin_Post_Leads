"""
Scrape current job title, company, company URL, and email from LinkedIn profiles.

Strategy
--------
- One Selenium session for the whole batch (login once, reuse cookies).
- Scrapy Selector parses rendered page HTML — clean CSS/XPath extraction.
- Email discovered via the no-API cascade in emails.py.
- Results returned as plain dicts.
"""
import time
import logging

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from scrapy import Selector

from .auth import create_driver, linkedin_login
from .items import ProfileItem
from .pipelines import CleanFieldsPipeline
from .emails import discover_email

logger = logging.getLogger(__name__)
_pipeline = CleanFieldsPipeline()

# ── Selector fallback chains ──────────────────────────────────────────────────
# LinkedIn redesigns its DOM regularly; we try multiple patterns in order.

_PROFILE_READY = [
    ".pv-top-card",
    ".profile-photo-edit__preview",
    ".artdeco-card",
    "main .scaffold-layout__main",
]

# Job title selectors (2024+ layout first, legacy last)
_JOB_TITLE_CSS = [
    # New 2024 — top-card sub-headline
    ".pv-text-details__left-panel .text-body-medium::text",
    # pvs = profile view section (experience)
    ".pvs-list__item--line-separated:first-child .mr1.t-bold span[aria-hidden='true']::text",
    # Legacy experience section
    ".experience-section li:first-child .pv-entity__summary-info h3::text",
    # Fallback: top-card headline (includes company usually, will be split by AI later)
    ".pv-top-card--headline::text",
    ".text-body-medium.break-words::text",
]

# Company name selectors
_COMPANY_CSS = [
    ".pvs-list__item--line-separated:first-child .t-14.t-normal span[aria-hidden='true']::text",
    ".experience-section li:first-child .pv-entity__secondary-title::text",
    ".pv-top-card--experience-list-item:first-child span[aria-hidden='true']::text",
]

# Company LinkedIn URL selectors
_COMPANY_URL_CSS = [
    ".pvs-list__item--line-separated:first-child a[href*='/company/']::attr(href)",
    ".experience-section a[href*='/company/']::attr(href)",
    "a[href*='/company/']::attr(href)",
]

# Company website from "About" section (some profiles show it)
_COMPANY_WEBSITE_CSS = [
    "a[href*='://'][data-tracking-control-name*='website']::attr(href)",
    ".pv-top-card--website a::attr(href)",
]


def _first(sel: Selector, css_list: list[str]) -> str:
    for css in css_list:
        val = sel.css(css).get()
        if val and val.strip():
            return val.strip()
    return ""


def _scrape_one(driver, url: str, scrape_email: bool) -> dict:
    """Scrape a single profile. Driver must already be authenticated."""
    clean_url = url.split("?")[0].rstrip("/")
    try:
        driver.get(clean_url)

        # Wait for any recognisable profile element
        for css in _PROFILE_READY:
            try:
                WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, css))
                )
                break
            except TimeoutException:
                continue

        time.sleep(1.2)  # let lazy sections render

        sel = Selector(text=driver.page_source)

        job_title    = _first(sel, _JOB_TITLE_CSS)
        company      = _first(sel, _COMPANY_CSS)
        company_url  = _first(sel, _COMPANY_URL_CSS).split("?")[0].rstrip("/")
        company_site = _first(sel, _COMPANY_WEBSITE_CSS).split("?")[0].rstrip("/")

        # Derive full name from page title (used for email discovery)
        page_title = sel.css("title::text").get("").split("|")[0].strip()
        full_name = page_title.split("-")[0].strip() if "-" in page_title else page_title

        email = ""
        if scrape_email:
            email = discover_email(
                driver,
                full_name=full_name,
                linkedin_url=clean_url,
                company=company,
                company_url=company_url,
                company_website=company_site,
            )

        item = ProfileItem(
            linkedinUrl=clean_url,
            jobTitle=job_title,
            company=company,
            companyUrl=company_url,
        )
        result = dict(_pipeline.process_item(item, None))
        result["email"] = email
        result["fullName"] = full_name
        return result

    except Exception as exc:
        logger.warning("Failed to scrape %s: %s", clean_url, exc)
        return {
            "linkedinUrl": clean_url,
            "jobTitle": "", "company": "",
            "companyUrl": "", "email": "", "fullName": "",
        }


def scrape_profiles(
    profile_urls: list[str],
    email: str,
    password: str,
    scrape_email: bool = False,
) -> list[dict]:
    """
    Scrape job title + company (+optionally email) for every URL.
    Uses one browser session for the whole batch.
    """
    if not profile_urls:
        return []

    driver = create_driver()
    results: list[dict] = []
    try:
        linkedin_login(driver, email, password)
        for url in profile_urls:
            results.append(_scrape_one(driver, url, scrape_email))
            time.sleep(1.0)  # polite delay between profile requests
    except Exception as exc:
        logger.error("Profile scraping session failed: %s", exc, exc_info=True)
        raise
    finally:
        driver.quit()

    logger.info("Scraped %d profile(s)", len(results))
    return results


def scrape_emails_for_profiles(
    profiles: list[dict],
    email: str,
    password: str,
) -> list[dict]:
    """
    Given profiles that already have linkedinUrl, company, companyUrl —
    run only the email discovery step for each, reusing one browser session.
    This is called as a separate pass after profile data is collected.
    """
    if not profiles:
        return profiles

    driver = create_driver()
    try:
        linkedin_login(driver, email, password)
        for p in profiles:
            if p.get("email"):
                continue  # already found — skip
            p["email"] = discover_email(
                driver,
                full_name=p.get("fullName", ""),
                linkedin_url=p.get("linkedinUrl", ""),
                company=p.get("company", ""),
                company_url=p.get("companyUrl", ""),
                company_website=p.get("companyWebsite", ""),
            )
            time.sleep(0.8)
    except Exception as exc:
        logger.error("Email scraping pass failed: %s", exc, exc_info=True)
    finally:
        driver.quit()

    return profiles
