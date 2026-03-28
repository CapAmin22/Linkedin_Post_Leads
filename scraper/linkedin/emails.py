"""
Email discovery WITHOUT external APIs and WITHOUT a browser.

Pipeline (ordered by reliability):
  1. Company website scraping  — requests + BeautifulSoup, find mailto: / email patterns
  2. Pattern guessing + DNS MX — generate formats, validate domain has MX record

Note: LinkedIn Contact Info (step 0) is handled upstream in profiles.py via
api.get_profile_contact_info() so it doesn't need a browser here.
"""
import re
import logging
from urllib.parse import urlparse, urljoin

import requests
import dns.resolver
from bs4 import BeautifulSoup

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

_SKIP_PREFIXES = (
    "noreply", "no-reply", "donotreply", "support", "help", "info",
    "hello", "hi", "contact", "admin", "team", "hr", "careers",
    "sales", "marketing", "press", "media", "legal", "privacy",
    "billing", "feedback", "newsletter",
)

_WEBSITE_PATHS = ["/", "/about", "/about-us", "/contact", "/contact-us",
                  "/team", "/our-team", "/people", "/staff"]


# ── 1. Company Website Email Scraping (requests + BeautifulSoup) ──────────────

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
    Prefers an email containing first or last name; falls back to any non-generic one.
    """
    try:
        r = requests.get(url, headers=_HEADERS, timeout=6, allow_redirects=True)
        if not r.ok:
            return ""
        text = r.text

        soup = BeautifulSoup(text, "lxml")
        mailto_emails = [
            a["href"].replace("mailto:", "").split("?")[0].strip().lower()
            for a in soup.find_all("a", href=lambda h: h and h.startswith("mailto:"))
        ]
        regex_emails = [m.lower() for m in _EMAIL_RE.findall(text)]
        all_emails = mailto_emails + regex_emails

        name_targets = {first.lower().split()[0], last.lower().split()[-1]} - {""}

        for email in all_emails:
            if any(t and t in email for t in name_targets):
                if not email.startswith(_SKIP_PREFIXES):
                    return email

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


# ── 2. Pattern Guessing + DNS MX Validation ───────────────────────────────────

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
        return patterns[0]

    return ""


# ── Public entry point ────────────────────────────────────────────────────────

def discover_email_no_browser(
    full_name: str,
    linkedin_url: str,
    company: str,
    company_url: str,
    company_website: str = "",
) -> str:
    """
    No-browser email discovery cascade:
      1. Company website scraping (requests + BeautifulSoup)
      2. Pattern guessing + DNS MX (fallback)

    Returns email string or "" if nothing found.
    """
    parts = full_name.strip().split()
    first = parts[0] if parts else ""
    last = parts[-1] if len(parts) > 1 else ""

    # Strategy 1: Company website scraping
    if company or company_url or company_website:
        email = scrape_company_website_email(first, last, company_website, company_url)
        if email:
            logger.info("Email found via company website: %s", email)
            return email

    # Strategy 2: Pattern guessing + DNS MX
    domain = _domain_from_url(company_website or company_url)
    if domain:
        email = guess_email_by_pattern(first, last, domain)
        if email:
            logger.info("Email guessed via pattern (MX validated): %s", email)
            return email

    logger.debug("No email found for %s", full_name)
    return ""
