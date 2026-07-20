# GitHub Actions Secrets — checklist

Paste these in your **public** Beacon repo. Never put them in code or commit `.env`.

## Where to paste (exact clicks)

1. Open your repo on GitHub (example: `https://github.com/YOUR_USERNAME/beacon`)
2. Click **Settings** (top menu of the repo)
3. In the left sidebar, click **Secrets and variables**
4. Click **Actions**
5. Click **New repository secret** for each row below
6. **Name** must match exactly (copy-paste the name)
7. **Secret** = the value you paste
8. Click **Add secret**

---

## Required secrets (engine will not work without these)

| Secret name (exact) | What to paste | Where you get it |
|---|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → **Project Settings** (gear) → **API** → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the long **service_role** key | Same page → **Project API keys** → `service_role` → **Reveal** → copy. This is powerful — never put it in the dashboard. |

---

## Required for production labeling

These are already set inside the workflow files as plain values (`DEPLOYMENT_MODE=production`, `FORCE_PRODUCTION=true`). You do **not** need to add them as Secrets.

---

## Email alerts + daily report (pick one path)

### Path A — Gmail SMTP (common)

| Secret name | What to paste | Where you get it |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | type that exactly |
| `SMTP_PORT` | `587` | type that exactly |
| `SMTP_USER` | your Gmail address | your email |
| `SMTP_PASS` | Gmail **App Password** (16 characters) | Google Account → [App passwords](https://myaccount.google.com/apppasswords) (2-Step Verification must be on) |
| `ALERT_TO` | email that receives instant failure alerts | usually your email |
| `REPORT_TO` | email that receives the nightly report | usually your email |
| `RESEND_API_KEY` | leave empty / skip creating this secret | only if using Path B |

### Path B — Resend instead of Gmail

| Secret name | What to paste | Where you get it |
|---|---|---|
| `RESEND_API_KEY` | your Resend API key | [resend.com](https://resend.com) → API Keys |
| `ALERT_TO` | alert inbox | your email |
| `REPORT_TO` | report inbox | your email |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | skip these | not needed if Resend is set |

---

## Form test identity

| Secret name | What to paste | Notes |
|---|---|---|
| `TEST_NAME` | e.g. `MONITOR TEST` or `amaz@beacon` | Fixed name used on every form fill |
| `TEST_EMAIL` | your dedicated test inbox address | Same every time |
| `TEST_PHONE` | fixed phone digits, e.g. `5550100100` | Same every time |

---

## Optional — inbox verification (Layer 2)

Only if you turn on IMAP checking later.

| Secret name | What to paste | Notes |
|---|---|---|
| `FORM_INBOX_VERIFICATION` | `true` | or skip / leave unset to keep Layer 2 off |
| `IMAP_HOST` | `imap.gmail.com` | for Gmail |
| `IMAP_PORT` | `993` | for Gmail |
| `IMAP_USER` | test inbox email | |
| `IMAP_PASS` | inbox app password | separate from SMTP if different accounts |

---

## Optional — proxy (leave empty at launch)

| Secret name | What to paste | Notes |
|---|---|---|
| `PROXY_URL` | **leave this secret empty**, or do not create it yet | When empty, Playwright goes direct from the GitHub US runner. Later you can paste a residential proxy URL here without changing code. |

Example later format (do not invent one now): `http://user:pass@proxy-host:port`

---

## Dashboard (Cloudflare Pages later — NOT GitHub Actions Secrets)

These go in Cloudflare Pages environment variables when you host the dashboard, or in `dashboard/.env.local` on your PC only:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | same Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase **anon** / publishable key (safe for browser with RLS) |

Do **not** put `SUPABASE_SERVICE_ROLE_KEY` in the dashboard.

---

## Quick count

Minimum to get load checks writing production rows:

1. `SUPABASE_URL`
2. `SUPABASE_SERVICE_ROLE_KEY`
3. Form identity three: `TEST_NAME`, `TEST_EMAIL`, `TEST_PHONE` (recommended before form workflow runs)
4. Email secrets when you want alerts/reports

`PROXY_URL` stays empty.
