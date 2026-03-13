"""
Email discovery WITHOUT external APIs.

Pipeline (ordered by reliability):
  1. LinkedIn Contact Info overlay  — direct email if person shared it
  2. Company website scraping       — requests + BeautifulSoup, find mailto: / email patterns
  3. Pattern guessing + DNS MX      — generate formats, validate domain has MX record

No Apollo, no Hunter, no paid API.
"""
import re
import logging
from urllib.parse import urlparse, urljoin

import requests
import dns.resolver
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", re.I)

# Emails to skip (generic / noise)
_SKIP_PREFIXES = (
    "noreply", "no-reply", "donotreply", "support", "help", "info",
    "hello", "hi", "contact", "admin", "team", "hr", "careers",
    "sales", "marketing", "press", "media", "legal", "privacy",
    "billing", "feedback", "newsletter",
)

_WEBSITE_PATHS = ["/", "/about", "/about-us", "/contact", "/contact-us",
                  "/team", "/our-team", "/people", "/staff"]


# ── 1. LinkedIn Contact Info (Selenium) ───────────────────────────────────────

def scrape_linkedin_contact_email(driver, profile_url: str) -> str:
    """
    Navigate to the contact-info overlay of a LinkedIn profile and return
    any email address listed there. Returns "" if none found or not public.
    """
    try:
        overlay_url = profile_url.rstrip("/") + "/overlay/contact-info/"
        driver.get(overlay_url)
        wait = WebDriverWait(driver, 8)

        # Wait for the overlay panel
        wait.until(EC.presence_of_element_located(
            (By.CSS_SELECTOR, ".pv-profile-section__section-info, .ci-email, section.pv-contact-info")
        ))

        # Look for email links
        email_links = driver.find_elements(By.CSS_SELECTOR, "a[href^='mailto:']")
        for link in email_links:
            href = link.get_attribute("href") or ""
            email = href.replace("mailto:", "").strip()
            if email and "@" in email:
                logger.debug("Found contact email: %s", email)
                return email.lower()

        # Fallback: scan page text for email-like strings
        text = driver.find_element(By.TAG_NAME, "body").text
        matches = _EMAIL_RE.findall(text)
        for m in matches:
            if not m.lower().startswith(_SKIP_PREFIXES):
                return m.lower()

    except (TimeoutException, NoSuchElementException, Exception) as exc:
        logger.debug("Contact info scrape failed for %s: %s", profile_url, exc)

    return ""


# ── 2. Company Website Email Scraping (requests + BeautifulSoup) ──────────────

def _get_company_website(company_linkedin_url: str) -> str:
    """
    Fetch the company's LinkedIn page and extract its external website URL.
    Returns "" if not found.
    """
    if not company_linkedin_url or not company_linkedin_url.startswith("http"):
        return ""

    try:
        r = requests.get(
            company_linkedin_url, headers=_HEADERS, timeout=6, allow_redirects=True
        )
        if not r.ok:
            return ""
        soup = BeautifulSoup(r.text, "lxml")
        # LinkedIn company page has a website link in the "about" section
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if href.startswith("http") and "linkedin.com" not in href:
                return href.split("?")[0].rstrip("/")
    except Exception as exc:
        logger.debug("Company website lookup failed: %s", exc)

    return ""


def _extract_emails_from_page(url: str, first: str, last: str) -> str:
    """
    Fetch a webpage and return the best email match for the given name.
    Prefers an email that contains first or last name; falls back to any non-generic one.
    """
    try:
        r = requests.get(url, headers=_HEADERS, timeout=6, allow_redirects=True)
        if not r.ok:
            return ""
        text = r.text

        # Also check mailto: links
        soup = BeautifulSoup(text, "lxml")
        mailto_emails = [
            a["href"].replace("mailto:", "").split("?")[0].strip().lower()
            for a in soup.find_all("a", href=lambda h: h and h.startswith("mailto:"))
        ]
        regex_emails = [m.lower() for m in _EMAIL_RE.findall(text)]
        all_emails = mailto_emails + regex_emails

        name_targets = {first.lower().split()[0], last.lower().split()[-1]} - {""}

        # Prefer emails that contain the person's name
        for email in all_emails:
            if any(t and t in email for t in name_targets):
                if not email.startswith(_SKIP_PREFIXES):
                    return email

        # Fall back to first non-generic email found
        for email in all_emails:
            local = email.split("@")[0]
            if not any(local.startswith(p) for p in _SKIP_PREFIXES):
                return email

    except Exception as exc:
        logger.debug("Page scrape failed for %s: %s", url, exc)

    return ""


def scrape_company_website_email(
    first: str, last: str, company_website: str, company_linkedin_url: str = ""
) -> str:
    """
    Try to find an email for *first* *last* on the company's website.
    Checks several sub-pages (about, contact, team, etc.).
    """
    website = company_website

    if not website and company_linkedin_url:
        website = _get_company_website(company_linkedin_url)

    if not website:
        return ""

    # Normalise base URL
    base = website.rstrip("/")
    parsed = urlparse(base)
    if not parsed.scheme:
        base = "https://" + base

    for path in _WEBSITE_PATHS:
        url = urljoin(base, path)
        email = _extract_emails_from_page(url, first, last)
        if email:
            return email

    return ""


# ── 3. Pattern Guessing + DNS MX Validation ───────────────────────────────────

def _domain_has_mx(domain: str) -> bool:
    """Return True if *domain* has at least one MX record."""
    try:
        dns.resolver.resolve(domain, "MX", lifetime=3)
        return True
    except Exception:
        return False


def _domain_from_url(url: str) -> str:
    """Extract the bare domain (no www) from a URL string."""
    if not url:
        return ""
    if "://" not in url:
        url = "https://" + url
    host = urlparse(url).hostname or ""
    return host.replace("www.", "")


def guess_email_by_pattern(first: str, last: str, domain: str) -> str:
    """
    Generate common email patterns for *first*/*last* at *domain*.
    Returns the first pattern whose domain has an MX record, or "" if none.
    Note: This confirms the domain is real but does NOT guarantee delivery.
    """
    if not first or not last or not domain:
        return ""

    f = re.sub(r"[^a-z]", "", first.lower().split()[0]) if first else ""
    l = re.sub(r"[^a-z]", "", last.lower().split()[-1]) if last else ""

    if not f or not l:
        return ""

    patterns = [
        f"{f}.{l}@{domain}",
        f"{f}{l}@{domain}",
        f"{f[0]}{l}@{domain}",
        f"{f}@{domain}",
        f"{l}@{domain}",
        f"{f}_{l}@{domain}",
        f"{f[0]}.{l}@{domain}",
    ]

    if _domain_has_mx(domain):
        return patterns[0]  # Return best-guess pattern (first.last@domain)

    return ""


# ── Public entry point ────────────────────────────────────────────────────────

def discover_email(
    driver,
    full_name: str,
    linkedin_url: str,
    company: str,
    company_url: str,
    company_website: str = "",
) -> str:
    """
    Full no-API email discovery cascade:
      1. LinkedIn Contact Info overlay (Selenium)
      2. Company website scraping (requests + BeautifulSoup)
      3. Pattern guessing + DNS MX (fallback)

    Returns email string or "" if nothing found.
    """
    parts = full_name.strip().split()
    first = parts[0] if parts else ""
    last = parts[-1] if len(parts) > 1 else ""

    # ── Strategy 1: LinkedIn Contact Info ─────────────────────────────
    if linkedin_url and driver:
        email = scrape_linkedin_contact_email(driver, linkedin_url)
        if email:
            logger.info("✅ Email found via LinkedIn Contact Info: %s", email)
            return email

    # ── Strategy 2: Company website scraping ──────────────────────────
    if company or company_url or company_website:
        email = scrape_company_website_email(first, last, company_website, company_url)
        if email:
            logger.info("✅ Email found via company website: %s", email)
            return email

    # ── Strategy 3: Pattern guessing + DNS MX ─────────────────────────
    domain = _domain_from_url(company_website or company_url)
    if domain:
        email = guess_email_by_pattern(first, last, domain)
        if email:
            logger.info("✅ Email guessed via pattern (MX validated): %s", email)
            return email

    logger.debug("No email found for %s", full_name)
    return ""
