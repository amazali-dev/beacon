# Website Monitoring System - Project Spec for Cursor

Give this entire file to Cursor as the project brief. Build it step by step in the order listed. I am not a developer, so explain what you are doing in plain English at each step, and never assume I know terminal commands without showing them exactly.

---

## 1. What we are building

A monitoring system for 5 commercial signage websites. It runs 24/7 from a server with a US IP address, checks every site every 30 minutes on 3 device profiles, tests the quote forms end to end, sends instant alerts when something breaks, and emails one clean daily report.

The 5 sites:

1. https://signage.inc/
2. https://www.signmakerz.com/
3. https://signs.inc/
4. https://quicksignage.com/
5. https://signize.us/

Site settings do NOT live in a code file. They live in the Supabase sites table and are managed from a Settings page inside the dashboard (see section 3, Part B). I must be able to add, edit, pause, or remove a site entirely from the dashboard without ever touching code or JSON. The engine reads the current site list fresh from Supabase at the start of every run, so changes apply within 30 minutes with no redeploy.

For each site the Settings page has these fields:

- Site name
- Main URL to monitor (the load/render checks in Module 1 run against this)
- Extra pages to monitor (optional list, for key landing pages beyond the homepage)
- Get a Quote form page URL (Module 2 runs against this, it is often a different page than the homepage)
- Form testing on/off toggle (so a site can be load-monitored without form testing)
- Site active/paused toggle
- Advanced section, collapsed by default: CSS selectors for key elements and form fields, stored as json. I will never edit these by hand, see form field detection below.

**Form field detection:** I cannot write CSS selectors. The engine must auto-detect form fields on the quote form page using sensible signals: input types (email, tel, file), field names, placeholders, and labels. During initial setup for each site, Cursor runs a detection pass, shows me in plain English what it found ("Name field: found. Email field: found. File upload: found. Submit button: found."), and saves the confirmed selectors to the sites table. If detection fails on any field, Cursor inspects that site's form and writes the selector itself. When I add a NEW site later through Settings, the engine runs the same auto-detection on first run and reports in the dashboard what it found and whether anything needs attention, so adding a site stays a no-code action.

## 2. Non-negotiable requirement: US IP only

All checks must originate from a US IP address. Our customers are in the US and we need to see exactly what they see (CDN routing, geo rules, load times from the US).

- The engine runs as a scheduled GitHub Actions workflow (every 30 minutes) on GitHub-hosted runners, which are US-hosted machines. No credit card, no server to maintain.
- The repository must be PUBLIC (public repos get unlimited free Actions minutes; private repos only get 2,000 minutes per month which is not enough). Because the repo is public: ALL secrets (Supabase service key, email credentials, test inbox login, test phone number) live ONLY in GitHub Actions Secrets, never in code, never in config files committed to the repo. Cursor: treat any secret appearing in a committed file as a critical bug.
- My own computer is NOT in the US. Local runs on my machine are for development testing of the code only and must be clearly labeled as NON-US test runs in any output. Production data must only ever come from GitHub runners.
- Per-run IP guard: at the start of every workflow run, the script calls a free IP geolocation endpoint (for example ipapi.co/json) and verifies the country is US. If not US, skip recording production data for that run, log a loud warning, and let the next run proceed normally.
- GitHub disables scheduled workflows after 60 days of repo inactivity. Include a standard keepalive step so this never happens.
- Cache the Playwright browser installation between runs so each run starts fast.
- GitHub cron can start runs a few minutes late; that is acceptable, do not build anything complicated to fight it.
- **Proxy readiness (build the setting, leave it empty):** the engine must read an optional PROXY_URL from GitHub Secrets and, if present, route Playwright browser traffic through it. When empty (the default), runs go direct from the GitHub runner. This exists so a paid US residential proxy can be switched on later, by only pasting a proxy address into Secrets, if either of these ever happens: a site's firewall starts blocking GitHub runner IPs, or we decide to test whether spam filters block real US home connections. No proxy is used at launch.

## 3. Tech stack (all free)

This is a two-part system. Do not merge the parts.

**Part A - Checker engine (runs on GitHub Actions, scheduled every 30 minutes):**
- Node.js + TypeScript + Playwright (browser automation, all three engines)
- Runs as a GitHub Actions workflow on GitHub-hosted US runners, no server needed
- Writes all results to Supabase (Postgres) using the supabase-js client with the service role key stored ONLY in GitHub Actions Secrets
- Failure screenshots uploaded to Supabase Storage, results rows store the file path
- Scheduling via the workflow cron (every 30 minutes); the form-test schedule (4x daily) is a separate workflow or a time check inside the same workflow
- Nodemailer for alert and daily report emails (Gmail SMTP with an app password, or Resend free tier), credentials in GitHub Secrets
- imapflow for reading the test inbox, credentials in GitHub Secrets
- The daily report is generated by a third scheduled workflow at 23:30 US Eastern

**Part B - Dashboard (React + TypeScript on Cloudflare Pages):**
- Reads from Supabase with the anon key and row level security enabled
- Supabase Auth for login, team members only
- Live status wall: one card per site, green/yellow/red, last check time
- Load time and LCP charts per site per device profile (last 24h and last 7 days)
- Form test history table with layer-by-layer pass/fail
- Incident log with failure screenshots served from Supabase Storage
- Settings page: add/edit/pause/remove sites, set the quote form URL per site, toggle form testing per site (details in section 1)
- Run Now button: fires an immediate check on demand (all sites or one site) outside the 30-minute schedule. Implementation: the button calls a Supabase Edge Function, which triggers the GitHub Actions workflow via workflow_dispatch using a GitHub fine-grained token stored ONLY as a Supabase Edge Function secret, never in dashboard frontend code (frontend code is public). The dashboard shows "run requested, results in 2-4 minutes" and refreshes when new rows arrive. Rate limit: max one manual run per site per 5 minutes.
- Mobile friendly, this will be checked from phones

Why not run the bot on Cloudflare: Pages/Workers cannot keep real browsers running, and Cloudflare Browser Rendering free tier is 10 minutes of browser time per day, far below this workload. The engine runs on GitHub Actions instead (see section 2).

Supabase schema (Cursor: create these via SQL migration and show me the SQL):
- sites (id, name, main_url, extra_urls json, quote_form_url, form_testing_enabled, selectors json, form_selectors json, active)
- load_checks (site_id, profile, timestamp, status_code, loaded, load_ms, lcp_ms, cls, console_errors json, failed_requests json, elements_ok json, screenshot_path)
- form_tests (site_id, timestamp, run_id, layer1_pass, layer2_pass, layer3_pass, submit_to_inbox_seconds, logo_upload_ok, screenshot_path, notes)
- incidents (site_id, opened_at, closed_at, type, detail, alerted)

No paid services anywhere. If any step would require a paid service, stop and tell me the free alternative.

**About Supabase cron:** Supabase supports scheduled jobs (pg_cron and scheduled Edge Functions), but Edge Functions run on Deno with short execution limits and CANNOT run Playwright browsers, and their IP location is not guaranteed US. So all browser checks stay on GitHub Actions. Use Supabase cron only for lightweight database-side jobs where it genuinely helps:
- A watchdog job every 15 minutes: if no new load_checks row has arrived in the last 45 minutes, the engine itself is down (GitHub skipped or disabled the workflow), insert an incident and trigger an email alert. This catches the failure the engine cannot report about itself.
- Nightly cleanup: delete screenshots and rows older than the retention window.
Do not use Supabase cron for anything involving a browser.

## 4. Module 1 - Load and render checks

Runs every 30 minutes, all 5 sites, each on 3 device profiles:

| Profile | Playwright setup |
|---|---|
| Desktop web | Chromium, 1920x1080 |
| Mac / Safari | WebKit, 1440x900 |
| Mobile | iPhone 14 device emulation (built into Playwright) |

For every site x profile combination, record into SQLite:

- Timestamp (store UTC, display in US Eastern in reports)
- HTTP status code
- Page fully loaded yes/no
- Load time in ms (navigation start to load event) plus Core Web Vitals: LCP and CLS
- JavaScript console errors (count + text)
- Failed network requests on the page (broken images, scripts, fonts)
- Presence checks for key elements: logo, main headline, primary CTA button, quote form. Selectors for each site live in config/sites.json. Cursor: visit each site once during setup, find stable selectors for these elements, and put them in the config with a comment on what each one targets.
- Full-page screenshot ONLY when something fails (keeps disk usage small). Auto-delete screenshots older than 30 days.

## 5. Module 2 - Quote form end-to-end test

Frequency: 4 times per day per site (00:00, 06:00, 12:00, 18:00 US Eastern). Code it so the frequency is one config value, in case we later change it.

Steps per site:

1. Open the page with query parameter ?monitor=1 appended.
2. Fill the quote form with the fixed test identity below. Never randomize it:
   - Name: MONITOR TEST
   - Email: (I will provide a dedicated test inbox address, put a placeholder in config)
   - Phone: same fixed number every time (placeholder in config)
   - Message/details field: "Automated monitoring test - please ignore. Run ID: {timestamp}"
3. Upload a real logo file: keep a small real PNG at assets/test-logo.png and attach it to the file upload field.
4. Submit and verify Layer 1: confirmation message or thank-you page appears within 15 seconds. Capture screenshot of the result either way.
5. Wait, then verify Layer 2: connect to the test inbox via IMAP and confirm the lead notification email for this Run ID arrived within 10 minutes, and that the logo attachment is present. Record submit-to-inbox delay in seconds.
6. Layer 3 (build the hook, leave disconnected for now): a placeholder function to verify the lead in a CRM via API. I will confirm later whether our leads go to a CRM or only email.

Every layer result goes into SQLite with pass/fail, timing, and screenshot path on failure.

### Data hygiene rules (must implement, not optional)

- The ?monitor=1 parameter must be on every monitored page visit in both modules, so we can exclude bot traffic in GA4 and block ad pixels for it. Add a section in the README explaining in plain English how I set up that exclusion in GA4 and in Google Tag Manager.
- The README must also tell me to create one filter/rule in our inbox or CRM that auto-archives anything from the test email address, so the sales team never sees test leads.

## 6. Alerts (instant, not just daily)

Send an immediate email alert when any of these happen:

- A site returns non-200 status or fails to load on any profile
- A key element (quote form, CTA) is missing
- Form test fails at any layer
- Load time exceeds a threshold (config value, default 8 seconds) on 2 consecutive checks

Anti-spam rule: one alert per site per issue type per 2 hours, not one per check. Include the failure screenshot inline in the alert email.

## 7. Daily report

At 23:30 US Eastern, generate one HTML email covering the day, per site:

- Uptime percent per device profile
- Average and worst load time per profile, plus LCP trend vs the previous 7 days
- Console error summary (new errors highlighted)
- Form test results: success rate per layer, average submit-to-inbox time, logo upload result
- Incident list: what failed, when, for how long, with screenshot links
- A one-line verdict per site: HEALTHY / DEGRADED / BROKEN

Design it clean and skimmable on a phone. No walls of raw data; details stay in SQLite and a simple on-server dashboard page (see idea 1 below).

## 8. Build order for Cursor

1. Project skeleton (two folders: engine/ and dashboard/), config files, Supabase schema via SQL migration
2. Module 1 for ONE site, one profile, run manually, confirm the row appears in Supabase
3. Expand to all sites and all 3 profiles
4. Scheduling every 30 minutes
5. Basic dashboard on Cloudflare Pages: status wall + load time chart reading live Supabase data
6. Module 2 form test on ONE site with me watching, headed browser mode, so we verify it fills the right fields before automating all sites
7. IMAP inbox verification
8. Alerts
9. Daily report email + form test section added to dashboard
10. US IP verification guard
11. Move the engine to GitHub Actions: create the public repo, workflows, and GitHub Secrets, with a click-by-click guide for me to paste each secret
12. README in plain English: how to start, stop, change config, read the report, and the GA4/inbox exclusion setup

Steps 1-5 can be built and previewed on my own machine (marked as non-US test data). Nothing counts as production until step 11 is done.

At each step, tell me exactly what to click or paste, and wait for my confirmation before moving on.

## 9. Ideas to add later (build hooks now where cheap, do not build fully yet)

1. **SSL and domain expiry watch.** Check certificate and domain expiration daily, alert 21 days before. A silently expired cert kills conversions instantly. Nearly free to add.
3. **Visual regression.** Take one baseline screenshot per site per profile weekly, then compare daily screenshots pixel-wise. Catches a broken layout, a plugin destroying the hero section, or an accidental change nobody noticed, even when the page technically "loads fine".
4. **Third-party script watch.** Specifically check that chat widget, review widget, and tracking pixels loaded. A dead chat widget is a silent lead killer on signage sites.
5. **Competitor benchmark.** Once daily, measure load time and LCP of 2-3 competitor landing pages from the same US server. Puts our speed numbers in context for optimization reports.
6. **Broken link sweep.** Weekly crawl of each site's main pages for 404s and mixed-content warnings.
7. **Form friction timer.** During the form test, record how long the automated fill takes per field and how many fields exist. Track this over time; when someone adds a field to a form, the report flags it, since every added field costs conversion rate.
8. **Weekly trend email.** Every Monday, a 7-day comparison: is each site faster or slower than last week, are error counts rising. Turns monitoring into optimization ammunition.
9. **Multi-region US checks.** Later, if we ever add a server or paid checks, compare East vs West coast experience.
10. **Checkout/pricing element watch.** If any site shows prices or a payment step, verify currency shows USD and the payment page loads. Wrong-currency display for US visitors is a conversion killer worth catching.

## 10. Rules for Cursor - strict working protocol

Treat me as a complete beginner. I do not read code, I will not debug, and I will not understand technical explanations. Your job is to do everything and hand me only simple actions.

- **Every instruction to me must be a numbered list of exact actions:** exact button names, exact text to paste in exact places. Never say "configure X" or "set up Y", show me literally how, click by click.
- **All terminal commands come as a single copy-paste block** with one plain sentence above it saying what it does. Never make me type commands manually or edit a command myself.
- **One step at a time.** After each step, tell me exactly what I should see if it worked, and what to paste back to you if it did not. Wait for my confirmation before continuing.
- **You write 100% of the code.** Never leave TODOs for me, never ask me to "fill in" anything except passwords and keys, and when keys are needed, tell me exactly which website page to get them from.
- **When something errors, I will paste the error to you.** You fix it fully. Do not explain the cause in technical terms, one plain sentence maximum, then the fixed step.
- **No jargon.** If a technical word is unavoidable, add a one-line plain meaning in brackets the first time.
- Explain everything in plain English, all code commented in simple language
- Never invent data; if a check cannot run, record "check failed to run", not a fake pass
- Everything configurable lives in config files, never hardcoded
- Keep it one project, two parts (engine and dashboard), one Supabase database, one report
- My only manual jobs in this whole project should be: creating accounts (GitHub, Supabase, Cloudflare), pasting keys into GitHub Secrets where you tell me, and setting up the GA4 exclusion with your guide. Everything else is yours.
