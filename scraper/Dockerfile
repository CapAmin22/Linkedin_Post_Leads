FROM python:3.11-slim

# Install Chromium and its driver (matches the selenium version's expectations)
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium-driver \
        chromium \
    && rm -rf /var/lib/apt/lists/*

# Tell selenium/webdriver-manager where Chrome lives
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Run with a single worker — Selenium is CPU/memory heavy; scale horizontally
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
