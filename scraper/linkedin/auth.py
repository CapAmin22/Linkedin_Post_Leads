"""
Selenium-based LinkedIn authentication and browser driver factory.
"""
import time
import logging
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException

logger = logging.getLogger(__name__)


def create_driver() -> webdriver.Chrome:
    """Create a headless Chrome driver with anti-detection settings."""
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    driver = webdriver.Chrome(options=options)
    # Hide webdriver property from JavaScript
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"},
    )
    return driver


def linkedin_login(driver: webdriver.Chrome, email: str, password: str) -> None:
    """Log in to LinkedIn using email and password."""
    logger.info("Logging in to LinkedIn...")
    driver.get("https://www.linkedin.com/login")
    wait = WebDriverWait(driver, 15)

    try:
        wait.until(EC.presence_of_element_located((By.ID, "username"))).send_keys(email)
        driver.find_element(By.ID, "password").send_keys(password)
        driver.find_element(By.CSS_SELECTOR, "[type=submit]").click()

        # Wait until redirected away from the login page
        wait.until(EC.url_changes("https://www.linkedin.com/login"))
        time.sleep(2)  # Let session cookies settle
        logger.info("Login successful")
    except TimeoutException as e:
        raise RuntimeError("LinkedIn login timed out — check credentials or CAPTCHA") from e
