# Beacon

Monitors commercial signage websites every 30 minutes, tests quote forms, emails alerts, and shows a live dashboard.

**Production:** the checker runs on **GitHub Actions** (US runners) every 30 minutes.  
**Your PC:** local runs are **NON-US test / staging** only — never treated as production.

This project has **two parts**:

| Folder | What it does | Where it runs |
|--------|----------------|----------------|
| `engine/` | Opens browsers, runs checks, sends emails | **GitHub Actions** (production) · your PC (staging only) |
| `dashboard/` | Status wall, charts, settings | Your PC (`npm run dev`) or Cloudflare Pages |

Both share one **Supabase** database (free).

**Go live on GitHub:** follow **[GITHUB_SETUP.md](GITHUB_SETUP.md)** (click-by-click) and paste secrets from **[GITHUB_SECRETS.md](GITHUB_SECRETS.md)**.

---

## Local NON-US testing (your PC)

Local checks **work and save to Supabase** — they are labeled **staging**, not US production.

### One command — engine + dashboard together

```powershell
cd d:\bots
npm run install:all
npm start
```

What you should see:
- One PowerShell window stays open (engine + UI running together)
- Open **http://localhost:5173** in your browser
- Go to **Operations** in the menu for schedule, run-now buttons, and engine status

Leave that PowerShell window open. Press **Ctrl+C** to stop everything.

> **Why a process at all?** Beacon uses real browsers. Browsers cannot run inside a normal website tab 24/7. On GitHub, each scheduled workflow starts a US machine, runs the checks, then stops. On your PC, `npm start` is only for tuning.

### Staging defaults (already set)

- `engine/config/defaults.json` → `"deploymentMode": "staging"`
- Email alerts **off** during staging
- Do **not** set `FORCE_PRODUCTION=true` on your PC

Production flags are set only inside the GitHub workflow files.

---

## What’s done vs what’s left

### Done

- Load checks — all 5 sites × 3 devices  
- GitHub Actions schedules (30 min load, 4× daily forms, 23:30 ET report)  
- Dashboard UI — status, charts, forms, incidents, settings  
- Supabase database + seed sites  
- Local staging mode  
- Form auto-detection + quote form tests  
- US IP guard + optional `PROXY_URL`  
- Playwright browser cache + keepalive in Actions  

### Your next steps (production)

| # | Task | Guide |
|---|------|--------|
| 1 | Clear old check rows in Supabase | [GITHUB_SETUP.md](GITHUB_SETUP.md) Step 0 |
| 2 | Create public GitHub repo + push | [GITHUB_SETUP.md](GITHUB_SETUP.md) |
| 3 | Paste Actions secrets | [GITHUB_SECRETS.md](GITHUB_SECRETS.md) |
| 4 | Run **Load checks** once from Actions | [GITHUB_SETUP.md](GITHUB_SETUP.md) Step 6 |
| 5 | Host dashboard on Cloudflare Pages (optional) | below |
| 6 | GA4 / GTM exclude `?monitor=1` | below |

---

> **Note:** Checks on your PC are **NON-US test data**. Real production rows come only from GitHub Actions after secrets are set.

---

## What is already built

1. Project folders + config templates  
2. Supabase SQL (tables, security, cleanup helpers)  
3. Module 1 — load/render checks (3 device profiles)  
4. GitHub Actions workflows (load / form / daily report / keepalive)  
5. Dashboard (status, charts, forms, incidents, settings)  
6. Module 2 — quote form test (headed mode supported)  
7. IMAP inbox Layer 2  
8. Instant alerts (2-hour anti-spam)  
9. Daily HTML report email  
10. US IP geo guard + optional proxy hook  
11. Beginner GitHub setup + secrets checklist  
12. This README (including GA4 + inbox exclusion)

---

## One-time setup (plain English)

### A) Create the free database (Supabase)

1. Open https://supabase.com and create a free account.  
2. Click **New project**. Pick a name and a strong database password. Choose a region close to the US East Coast if offered.  
3. Wait until the project is ready.  
4. Left sidebar → **SQL** → **New query**.  
5. Open the file `supabase/migrations/001_initial.sql` on your computer, copy **everything**, paste into the Supabase SQL box, click **Run**.  
6. Open `supabase/seed.sql`, copy everything, paste, click **Run**. You should now see 5 sites.  
7. Left sidebar → **Project Settings** → **API**. Keep this tab open — you will copy:
   - **Project URL**
   - **anon public** key (for the dashboard)
   - **service_role** key (for the engine only — never put this in the dashboard)

### B) Configure the engine on this computer (test only)

1. In File Explorer open `d:\bots\engine`.  
2. Copy `.env.example` and rename the copy to `.env`.  
3. Open `.env` in Notepad and paste:
   - `SUPABASE_URL=` your Project URL  
   - `SUPABASE_SERVICE_ROLE_KEY=` your service_role key  
4. Leave `FORCE_PRODUCTION=false` while testing on your PC.  
5. Open PowerShell and paste this whole block:

```powershell
cd d:\bots\engine
npm install
npx playwright install chromium webkit
```

What you should see: packages install, then Playwright browsers download, with no red errors at the end.

### C) Run one test check (Step 2 style)

Paste this:

```powershell
cd d:\bots\engine
npm run check:one
```

What you should see:

- A loud **NON-US TEST RUN** warning (expected on your PC)  
- Lines like `→ Signage Inc / desktop …` then `status=200 loaded=true`  
- In Supabase → **Table Editor** → `load_checks`, a new row appears with `is_production = false`

If it fails: copy the full red error text from PowerShell and paste it back to Cursor.

### D) Run all sites × all profiles once

```powershell
cd d:\bots\engine
npm run check:once
```

### E) Keep checks running on a schedule (local test)

```powershell
cd d:\bots\engine
npm run scheduler
```

Leave that window open. Press `Ctrl+C` to stop.

### F) Form field auto-detect

```powershell
cd d:\bots\engine
npm run detect:forms
```

You will see plain-English lines like `Email field: found.` Results are saved on each site row.

## Form submissions (quote forms)

Beacon fills and submits quote forms automatically. **No test inbox setup needed.**

- **Email used:** `amaz@beacon.com` (built in — nothing to add to `.env`)
- **Name:** `MONITOR TEST`
- **Pass/fail:** Did the form submit and show a thank-you page? (**Layer 1**)
- **Layer 2 (inbox)** and **Layer 3 (CRM)** are off by default

### Run from the browser

1. **Sites** → set the correct **Get a Quote form page URL** per site  
2. **Operations** → **Detect form fields** (once)  
3. **Operations** → **Run form tests now**  
4. **Forms** page → see pass/fail + screenshot

To watch the browser fill a form once:

```powershell
cd d:\bots\engine
npm run form:one
```

### Optional later: inbox verification (Layer 2)

Only if you want to confirm lead emails arrive. Set in `engine/.env`:

```
FORM_INBOX_VERIFICATION=true
IMAP_HOST=...
IMAP_USER=...
IMAP_PASS=...
```

---

1. Copy `dashboard/.env.example` to `dashboard/.env.local`.  
2. Paste `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the **anon** key, not service_role).  
3. In Supabase: **Authentication** → **Users** → **Add user** → create your email + password.  
4. Paste:

```powershell
cd d:\bots\dashboard
npm install
npm run dev
```

5. Open the URL it prints (usually http://localhost:5173), sign in with the user you created.

### I) Put the dashboard on Cloudflare Pages (free)

1. Push this project to a GitHub repo (or upload the `dashboard` folder).  
2. Open https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → connect the repo.  
3. Build settings:
   - Root directory: `dashboard`
   - Build command: `npm run build`
   - Build output: `dist`
4. Environment variables (Production):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy. Open the `*.pages.dev` URL and sign in.

In Supabase → **Authentication** → **URL configuration**, add your Pages URL under Redirect URLs if login redirects fail.

---

## Email alerts and daily report

In `engine/.env` fill:

- `SMTP_USER` / `SMTP_PASS` (Gmail: create an **App Password** at https://myaccount.google.com/apppasswords)  
- `ALERT_TO` and `REPORT_TO`

Or set `RESEND_API_KEY` from https://resend.com (free tier) instead of Gmail SMTP.

Send a report now:

```powershell
cd d:\bots\engine
npm run report:daily
```

---

## IMAP (optional — Layer 2 inbox check)

**Not required.** Forms submit as **amaz@beacon.com** and pass/fail on the thank-you page.

Enable only if you later want to verify lead notification emails in `engine/.env`:

- `FORM_INBOX_VERIFICATION=true`
- `IMAP_HOST` / `IMAP_USER` / `IMAP_PASS`

For Gmail, turn on IMAP and use an App Password.

---

## Production (US IP) — required

Follow **[DEPLOY_ORACLE.md](DEPLOY_ORACLE.md)** step by step.

On the US VM only:

- Set `FORCE_PRODUCTION=true` in `.env`  
- The geo guard must report country `US`  
- Then `is_production` becomes `true` on new rows  

---

## How to exclude bot traffic in GA4 and GTM

Every monitored visit includes `?monitor=1` on the URL.

### Google Analytics 4

1. Open GA4 → **Admin** (gear).  
2. Under **Data display** click **Data filters** (or **Data settings** → filters, depending on UI).  
3. Create a filter:
   - Filter name: `Exclude monitor bot`  
   - Filter type: Exclude  
   - Condition: Event parameter / Page query string contains `monitor=1`  
4. If your GA4 version uses **Internal traffic** rules instead: define a rule matching query parameter `monitor=1`, then set the filter to Exclude internal traffic.  
5. Save. Filters can take 24–48 hours to fully apply.

### Google Tag Manager

1. Open GTM → your container.  
2. **Triggers** → New → trigger type **History Change** or **Page View**.  
3. Fire this trigger only when **Page URL** does **not** contain `monitor=1` for tags you want to block on bot visits — **or** easier:  
4. On ad / chat / pixel tags, add an exception trigger:
   - Trigger type: Page View  
   - Condition: Page URL contains `monitor=1`  
   - Use that as **Exception** on those tags.  
5. Submit and publish the container.

Plain meaning: when our bot visits with `?monitor=1`, your ads and chat widgets should not fire, and GA should not count it as a real customer visit.

---

## How to hide test leads from the sales team

1. Decide the fixed test email (the same as `TEST_EMAIL` in `.env`).  
2. In your inbox (Gmail example):
   - Settings → **See all settings** → **Filters and Blocked Addresses** → **Create a filter**  
   - **To:** your test address *or* **Has the words:** `MONITOR TEST` / `Automated monitoring test`  
   - Create filter → check **Skip the Inbox (Archive it)** and optionally **Apply label** `monitor-tests`  
3. If leads go to a CRM, create an automation: when email equals the test address OR message contains `Automated monitoring test`, auto-archive / do not notify sales.

---

## Changing config (no code)

| What | Where |
|------|--------|
| Add/edit/pause sites | Dashboard → **Settings** |
| Check interval, slow threshold, form times | `engine/config/defaults.json` |
| Secrets (keys, SMTP, IMAP) | `engine/.env` on the VM |

After editing Settings, wait for the next engine run (up to 30 minutes) — the engine reloads sites from Supabase every time.

---

## Common commands (copy-paste)

```powershell
cd d:\bots\engine
npm run check:one
npm run check:once
npm run form:one
npm run detect:forms
npm run report:daily
npm run scheduler
```

```powershell
cd d:\bots\dashboard
npm run dev
npm run build
```

---

## Folders at a glance

```
bots/
  engine/                 Checker (Playwright)
  dashboard/              React dashboard
  supabase/               SQL migration + seed
  MONITORING_PROJECT_SPEC.md
  DEPLOY_ORACLE.md
  README.md               You are here
```
