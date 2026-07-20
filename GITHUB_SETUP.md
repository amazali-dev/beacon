# Create the public GitHub repo and push Beacon (beginner guide)

Do these steps in order. After each big step, tell Cursor what you see if something looks wrong.

---

## Before you start

1. You need a free GitHub account: https://github.com/signup  
2. On your PC, install **Git for Windows** if you do not have it: https://git-scm.com/download/win  
3. On your PC, install **GitHub CLI** (easiest for beginners): https://cli.github.com/  
   - Or we can use the website + Git commands — this guide uses the website + PowerShell.

---

## Step 1 — Create a new PUBLIC repository on GitHub

1. Open https://github.com/new  
2. **Repository name:** type `beacon` (or any name you like)  
3. **Description:** optional, e.g. `Website monitoring for signage sites`  
4. Select **Public** (required for unlimited free Actions minutes)  
5. Do **NOT** check “Add a README”  
6. Do **NOT** add .gitignore or license (this project already has them)  
7. Click **Create repository**  
8. Leave that page open — you will need the repo URL (looks like `https://github.com/YOUR_USERNAME/beacon.git`)

---

## Step 2 — Make sure secrets are not going to be uploaded

On your PC, open PowerShell and paste this whole block:

```powershell
cd d:\bots
Get-ChildItem -Force -Recurse -Include .env,.env.local | Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object FullName
```

You should see `engine\.env` and maybe `dashboard\.env.local`.  
Those files are **ignored** by `.gitignore` and must **never** be pushed.

---

## Step 3 — Initialize Git and make the first commit

Paste this whole block into PowerShell:

```powershell
cd d:\bots
git init
git add .
git status
```

**Look at the `git status` list carefully.**

- You must **NOT** see `engine/.env` or `dashboard/.env.local`  
- You **should** see `.github/workflows/`, `engine/`, `dashboard/`, `supabase/`  

If you see `.env` in the list, stop and tell Cursor before continuing.

If the list looks safe, paste this next block (replace the name/email with yours if you want):

```powershell
cd d:\bots
git commit -m "Initial Beacon commit: engine, dashboard, GitHub Actions"
```

If Git says you need to set your name/email first, paste this (edit the two quoted values), then run the commit again:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"
```

---

## Step 4 — Connect to GitHub and push

Replace `YOUR_USERNAME` and `beacon` if your repo name is different, then paste:

```powershell
cd d:\bots
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/beacon.git
git push -u origin main
```

GitHub will ask you to sign in (browser or token). Finish the login when prompted.

What you should see: files appear on your GitHub repo page.

---

## Step 5 — Add GitHub Actions Secrets

Follow the checklist in **[GITHUB_SECRETS.md](GITHUB_SECRETS.md)** — click by click.

Minimum before the first load-check run:

- `SUPABASE_URL`  
- `SUPABASE_SERVICE_ROLE_KEY`  

Also add email + form-identity secrets before you care about alerts and form tests.

Leave `PROXY_URL` empty / uncreated.

---

## Step 6 — Turn on Actions and run a test once

1. On the GitHub repo page, click **Actions**  
2. If GitHub asks to enable workflows, click **I understand my workflows, go ahead and enable them**  
3. In the left list, click **Load checks**  
4. Click **Run workflow** (button on the right) → **Run workflow**  
5. Wait 2–5 minutes  
6. Click the newest run → open the **load-checks** job  
7. You should see logs like `US production run OK` and sites being checked  

If it fails, open the red job → copy the error text → paste it to Cursor.

---

## Step 7 — Confirm data in Supabase

1. Supabase → **Table Editor** → `load_checks`  
2. You should see new rows with `is_production` = true  

Your sites list should still be there under `sites`.

---

## Schedules (after the test run works)

These run automatically — you do not click them every day:

| Workflow | When |
|---|---|
| **Load checks** | Every 30 minutes |
| **Form tests** | 00:00, 06:00, 12:00, 18:00 US Eastern |
| **Daily report** | 23:30 US Eastern |
| **Keepalive** | Weekly (keeps schedules from being auto-disabled) |

GitHub cron can start a few minutes late. That is normal.

---

## Local runs on your PC (Pakistan / non-US)

Local runs are for code testing only. They stay **staging / NON-US**.

```powershell
cd d:\bots
npm start
```

Do not set `FORCE_PRODUCTION=true` on your PC.
