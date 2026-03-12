"""
Scrape who reacted to a LinkedIn post.

Strategy
--------
- Selenium drives Chrome: login → navigate → click reactions button → scroll modal.
- Scrapy Selector parses the modal's innerHTML with CSS selectors.
- Multiple selector fallbacks handle LinkedIn DOM changes across years.
- Returns plain dicts (serialised from ReactorItem).
"""
import time
import logging

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from scrapy import Selector

from .auth import create_driver, linkedin_login
from .items import ReactorItem
from .pipelines import CleanFieldsPipeline

logger = logging.getLogger(__name__)
_pipeline = CleanFieldsPipeline()

# ── Selector banks (tried in order; first match wins) ────────────────────────

# Buttons that open the reactions/likes modal
_BTN_SELECTORS = [
    # 2024 feed layout
    "button.social-details-social-counts__count-value",
    ".social-details-social-counts__count-value",
    # Older layout
    ".social-counts__reactions button",
    ".feed-shared-social-counts button",
    # Aria-label based (most robust but slower)
    "button[aria-label*='reaction']",
    "button[aria-label*='like']",
    "button[aria-label*='Like']",
    # Data-attr fallback
    "[data-test-id*='social-counts'] button",
    # Generic: any button near the reaction count area
    ".feed-shared-social-action-bar button:first-child",
]

# The container that holds the reactor list once the modal is open
_MODAL_SELECTORS = [
    ".artdeco-modal__content",
    ".social-details-reactors-modal",
    ".reactions-tabpanel",
    "[class*='reactions-modal']",
    "[class*='reactor-list']",
    # 2024 redesign
    ".scaffold-finite-scroll__content",
]

# Individual reactor rows inside the modal
_ROW_SELECTORS = [
    # 2024 list items
    ".artdeco-list__item",
    # Older modal structure
    ".social-details-reactors-modal__reactor-list li",
    "[class*='reactor-list'] li",
    "li.reacted-people-list__list-item",
    # Fallback: generic list items inside modal
    "li",
]

# Name within a row
_NAME_CSS = [
    ".artdeco-entity-lockup__title span[aria-hidden='true']::text",
    ".artdeco-entity-lockup__title::text",
    ".actor-name span[aria-hidden='true']::text",
    "span[aria-hidden='true']::text",
    # 2024
    ".lockup__title span::text",
]

# Headline within a row
_HEADLINE_CSS = [
    ".artdeco-entity-lockup__subtitle span[aria-hidden='true']::text",
    ".artdeco-entity-lockup__subtitle::text",
    ".actor-description span[aria-hidden='true']::text",
    ".lockup__subtitle span::text",
]


def _try_click(driver, selectors: list[str], wait: WebDriverWait) -> bool:
    for sel in selectors:
        try:
            el = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, sel)))
            driver.execute_script("arguments[0].click();", el)
            return True
        except TimeoutException:
            continue
    return False


def _find_modal(selectors: list[str], wait: WebDriverWait):
    for sel in selectors:
        try:
            return wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, sel)))
        except TimeoutException:
            continue
    return None


def _parse_rows(modal_html: str, limit: int, seen: set[str]) -> list[dict]:
    """Parse reactor rows from modal innerHTML via Scrapy Selector."""
    sel = Selector(text=modal_html)
    results: list[dict] = []

    rows = []
    for row_sel in _ROW_SELECTORS:
        rows = sel.css(row_sel)
        if rows:
            break

    for row in rows:
        if len(results) + len(seen) >= limit:
            break

        # ── Name ───────────────────────────────────────────────────────
        name = ""
        for css in _NAME_CSS:
            name = (row.css(css).get() or "").strip()
            if name:
                break

        # ── Headline ───────────────────────────────────────────────────
        headline = ""
        for css in _HEADLINE_CSS:
            headline = (row.css(css).get() or "").strip()
            if headline:
                break

        # ── Profile URL ────────────────────────────────────────────────
        profile_url = (
            row.css("a[href*='/in/']::attr(href)").get() or ""
        ).split("?")[0].rstrip("/")

        # ── Reaction type ──────────────────────────────────────────────
        reaction_type = (
            row.css("[aria-label*='reaction']::attr(aria-label)").get()
            or row.css("img[alt]::attr(alt)").get("")
        ).strip()

        if name and profile_url and profile_url not in seen:
            seen.add(profile_url)
            item = ReactorItem(
                fullName=name,
                headline=headline,
                profileUrl=profile_url,
                reactionType=reaction_type,
            )
            results.append(dict(_pipeline.process_item(item, None)))

    return results


def scrape_reactions(post_url: str, email: str, password: str, limit: int = 20) -> list[dict]:
    """
    Return up to *limit* reactor profiles from the given LinkedIn post URL.

    Each dict: fullName, headline, profileUrl, reactionType.
    """
    driver = create_driver()
    try:
        linkedin_login(driver, email, password)
        logger.info("Navigating to: %s", post_url)
        driver.get(post_url)
        time.sleep(3)

        wait_short = WebDriverWait(driver, 10)
        wait_long  = WebDriverWait(driver, 15)

        # ── Click reactions button ─────────────────────────────────────
        clicked = _try_click(driver, _BTN_SELECTORS, wait_short)
        if not clicked:
            # Last-ditch attempt: find any button whose text contains a number
            try:
                btns = driver.find_elements(By.TAG_NAME, "button")
                for btn in btns:
                    txt = btn.text.strip()
                    if txt and txt.replace(",", "").replace(".", "").isdigit():
                        driver.execute_script("arguments[0].click();", btn)
                        clicked = True
                        break
            except Exception:
                pass

        if not clicked:
            logger.warning("Could not find the reactions button — post may have no reactions")
            return []

        time.sleep(2)

        # ── Find modal ─────────────────────────────────────────────────
        modal = _find_modal(_MODAL_SELECTORS, wait_long)
        if not modal:
            logger.warning("Reactions modal did not appear")
            return []

        # ── Scroll & parse ─────────────────────────────────────────────
        profiles: list[dict] = []
        seen_urls: set[str] = set()
        stale = 0

        for _ in range(25):  # max scroll attempts
            if len(profiles) >= limit:
                break

            html = modal.get_attribute("innerHTML") or ""
            batch = _parse_rows(html, limit, seen_urls)
            profiles.extend(batch)

            if not batch:
                stale += 1
                if stale >= 3:
                    break
            else:
                stale = 0

            driver.execute_script("arguments[0].scrollTop += 600;", modal)
            time.sleep(1.5)

        logger.info("Scraped %d reactor(s)", len(profiles))
        return profiles[:limit]

    except Exception as exc:
        logger.error("reactions scraping failed: %s", exc, exc_info=True)
        raise
    finally:
        driver.quit()
