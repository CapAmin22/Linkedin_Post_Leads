# User Acceptance Criteria (UAC) - LeadHarvest Project

## Overview
This document outlines the User Acceptance Criteria (UAC) for the **LeadHarvest** application. These criteria serve as the benchmark to verify that the system satisfies the project requirements and functions as expected from the end-user's perspective.

---

## 1. Authentication

### 1.1 User Signup
- **Condition**: User visits the `/signup` page and submits a valid email and matching passwords.
- **Expected Result**: 
  - User account is successfully created in Supabase Auth.
  - User is immediately logged into the application.
  - User is routed to the `/dashboard`.

### 1.2 User Login
- **Condition**: User navigates to `/login` and inputs valid, registered credentials (e.g., Email: `shaikhaminrehman@gmail.com`, Pass: `Captainamin@22`), then clicks Login.
- **Expected Result**: 
  - The system authenticates the user successfully.
  - User is redirected to `/dashboard`.
- **Condition**: User inputs incorrect credentials.
- **Expected Result**: 
  - An error message (e.g., "Invalid login credentials") is displayed.

### 1.3 Logout
- **Condition**: Logged-in user clicks "Logout" in the navigation or dashboard.
- **Expected Result**: 
  - User session is securely terminated.
  - User is redirected to the `/login` or root page.
  - Attempting to navigate back to `/dashboard` redirects the user to `/login`.

---

## 2. Dashboard & Navigation

### 2.1 Protected Routes
- **Condition**: An unauthenticated user attempts to visit the `/dashboard` directly via URL.
- **Expected Result**: User is automatically intercepted and redirected to `/login`.

### 2.2 Data Privacy (Multi-tenant Security)
- **Condition**: A logged-in user views their dashboard metrics and Leads Table.
- **Expected Result**: The user can **only** see leads extracted under their own account (`user_id`). Leads from other users are completely hidden and inaccessible.

---

## 3. LinkedIn Lead Extraction

### 3.1 Post URL Submission
- **Condition**: On the `/dashboard`, user pastes a valid LinkedIn post URL and clicks "Extract Leads".
- **Expected Result**: 
  - The system validates the input string as a LinkedIn URL.
  - A background extraction job is dispatched to Trigger.dev.
  - The UI updates to indicate the processing state.

### 3.2 Lead Extraction Pipeline
- **Condition**: The backend receives the extraction request.
- **Expected Result**: 
  - **Extraction**: The Playwright agent logs into LinkedIn (using configured credentials) and extracts engagements (likers/commenters) from the target post.
  - **AI Parsing**: Extracted data (raw headlines, text) is sent to Groq/Gemini to cleanly extract `job_title` and `company`.
  - **Enrichment**: The system makes API calls to Apollo.io/Hunter using the `company` Name and Profile to attempt to find business email addresses.
  - **Data Storage**: Enriched lead records are saved into the `scraped_leads` Supabase table linked to the current user's `user_id`.

---

## 4. Leads Management (Leads Table)

### 4.1 Data Display
- **Condition**: User views the Leads Table on the dashboard after a successful scrape.
- **Expected Result**: 
  - Leads are displayed in a clean, paginated table.
  - Visible fields: Name, LinkedIn Profile Link, Job Title, Company, Email, and Status.
  - LinkedIn Profile URLs are clickable and open correctly in a new tab.

### 4.2 Search and Filtering
- **Condition**: User uses the search bar or source drop-down filter in the Leads Table.
- **Expected Result**: 
  - The table dynamically filters results in real-time based on the typed search term or selected source post, without reloading the entire page.

### 4.3 Data Export
- **Condition**: User clicks the "Export CSV" button.
- **Expected Result**: 
  - A CSV file containing all filtered leads currently visible/selected is downloaded.
  - Data formatting within the CSV correctly encapsulates strings so headers map cleanly in spreadsheet software (Excel, Google Sheets).

---

## 5. System Health & Environment

### 5.1 System Health
- **Condition**: Administrator pings the `/api/health` endpoint.
- **Expected Result**: The endpoint returns JSON detailing the status of all essential API keys and resources (e.g., Supabase Auth, Groq, App/Service credentials, Database connection), without exposing API secrets.

### 5.2 Environment Configuration
- **Condition**: Application boots up via Vercel or locally.
- **Expected Result**: Environment variables (e.g., `LINKEDIN_EMAIL` and `NEXT_PUBLIC_LINKEDIN_EMAIL`) are loaded securely, with fallbacks properly configured.
