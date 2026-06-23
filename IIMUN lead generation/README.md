# n8n Lead Generation Workflow

This workspace contains a reusable n8n workflow export for lead generation and rule-based contact verification across Indian cities and categories.

Files:

- `n8n-lead-generation-workflow.json`: import this into n8n
- `generate_n8n_workflow.js`: source of truth for the workflow JSON and all Code node JavaScript

## What The Workflow Does

1. Reads request rows from Google Sheets.
2. Builds multiple public search queries per request.
3. Uses Bing web search result pages to discover candidate pages from:
   - general web results
   - official websites
   - Justdial
   - Sulekha
   - IndiaMART
   - WebIndia123
4. Fetches candidate pages and extracts:
   - organization name
   - phone numbers
   - email addresses
   - website
   - address
5. Fetches likely official website contact pages when a website is found.
6. Verifies and normalizes phones and emails with deterministic rules.
7. Deduplicates organizations, phones, and emails.
8. Scores confidence:
   - `HIGH`: valid phone + valid email + website
   - `MEDIUM`: valid phone + website
   - `LOW`: phone only or otherwise incomplete but still verified by phone or email
9. Appends only verified leads to the output sheet.
10. Logs source/page fetch failures into a log sheet without stopping the workflow.

## Google Sheets Structure

Create one spreadsheet with these tabs:

### 1. `Lead Requests`

Required header row:

| Category | City | Lead Count |
|---|---|---|
| NGO | Bangalore | 30 |
| Photographer | Goa | 20 |
| Yoga Instructor | Pune | 50 |

### 2. `Verified Leads`

Required header row:

| Organization Name | Category | City | Phone Number | Phone Verified | Email | Email Verified | Website | Address | Confidence Score | Timestamp |
|---|---|---|---|---|---|---|---|---|---|---|

### 3. `Workflow Logs`

Required header row:

| Timestamp | Stage | Category | City | Source | URL | Status | Message |
|---|---|---|---|---|---|---|---|

## Credentials Required

Use one Google Sheets credential in n8n:

- `Google Sheets OAuth2 API`

The workflow itself uses only public web pages for discovery and verification. No paid APIs are required.

## n8n Setup Steps

1. Import `n8n-lead-generation-workflow.json` into n8n.
2. Open each Google Sheets node and select your Google Sheets credential.
3. In each Google Sheets node, choose your spreadsheet from the **Document** dropdown and the correct tab from the **Sheet** dropdown:
   - `Lead Requests` (read input)
   - `Verified Leads` (append output)
   - `Workflow Logs` (append failures)
4. Run the workflow manually with a small test set first.

## Verification Rules

### Phone Verification

A phone is marked verified only when it can be normalized into a plausible Indian number:

- accepts `10` digit numbers
- accepts `0` + `10` digit numbers
- accepts `91` + `10` digit numbers
- rejects empty values
- rejects malformed values
- rejects repeated-digit junk like `9999999999`
- normalizes verified numbers to `+91XXXXXXXXXX`

Important note:
This is format-based verification, not carrier/live-call verification.

### Email Verification

An email is marked verified only when it:

- matches a valid email format
- is not empty
- is not a placeholder address
- is not an obvious `noreply` or test address

Important note:
This is syntax-and-placeholder verification, not SMTP inbox verification.

## Quality Controls

- External fetch nodes are configured to continue on failure.
- HTTP Request nodes store the fetched page text in `responseBody` and merge it back with the original request metadata by position.
- Fetch failures are appended to `Workflow Logs`.
- The workflow prioritizes quality over volume.
- If a request cannot reach its target count, it returns only verified leads.
- Unverified leads are not written just to fill quota.

## Production Notes

- Public directory pages can change structure over time. Re-test after n8n upgrades or major site redesigns.
- Some websites may block scraping intermittently. The workflow continues and logs those misses.
- For larger batches, consider running categories in smaller groups to reduce source throttling.
- If your n8n version re-prompts for Google Sheets field mapping on import, simply open each Google Sheets node once and re-save it.

## Regenerating The Workflow JSON

If you edit `generate_n8n_workflow.js`, regenerate the export with:

```bash
node generate_n8n_workflow.js
```
