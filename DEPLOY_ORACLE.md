# Deploy the checker engine on Oracle Cloud (US IP)

This guide is for a complete beginner. Do each numbered step. After a step, check the “What you should see” line before continuing.

You will create a **free** virtual computer in a **US region**. That computer runs the monitoring engine 24/7 so every check comes from a US IP.

---

## Before you start

On your PC you should already have:

- A working `engine/.env` with Supabase keys (from the main README)
- The project files under `d:\bots`

You will also need:

- A free Oracle Cloud account: https://www.oracle.com/cloud/free/
- A **debit or credit card** for signup (see “About the card” below — Oracle uses it for identity checks, not to charge you for the free VM if you follow this guide)
- A way to copy files to the server (we use the browser Cloud Shell / SCP notes below)

### About the card (common question)

Oracle almost always asks for a card during signup, even for the **Always Free** tier. Plain meaning:

- **Why they ask:** to verify you are a real person and to block spam accounts.
- **Will you be charged?** Not for the Always Free VM in this guide, as long as you pick only the **Always Free** shape when creating the server (Step 3) and do not turn on paid add-ons.
- **What shows on your statement:** sometimes a small temporary hold (often about $1) that disappears — not a real charge.
- **If you do not want to use a card:** you can still use Beacon on your PC and in the dashboard for testing. Results stay labeled **NON-US test** until you have a US server. There is no other 100% free US server option in this project that skips card verification — AWS, Google Cloud, and Azure ask for a card too.

If card signup fails or your bank blocks it, try another card or contact your bank. You can pause the Oracle step and keep building/testing locally until that is sorted.

---

## 1) Create the Oracle Cloud account

1. Open https://www.oracle.com/cloud/free/  
2. Click **Start for free**.  
3. Complete signup. Use a real phone number when asked.  
4. When Oracle asks for a **payment method**, enter a debit or credit card. This is normal for the free tier — see “About the card” above.  
5. Wait until you can open the Oracle Cloud **Console** home page.

What you should see: a dashboard with “Create a VM instance” or a hamburger menu (☰) in the top left.

---

## 2) Pick a US region

1. Top-right of the Console, click the region name.  
2. Choose **US East (Ashburn)** or **US West (Phoenix)**.  
3. Confirm the Console reloads in that region.

What you should see: the region label shows Ashburn or Phoenix.

---

## 3) Create an Always Free VM

1. ☰ menu → **Compute** → **Instances**.  
2. Click **Create instance**.  
3. Name: `beacon`.  
4. **Placement**: leave defaults (your US region).  
5. **Image**: click **Change image** → choose **Canonical Ubuntu 22.04** (or newest Ubuntu LTS).  
6. **Shape**: click **Change shape** → choose **Ampere** (Arm) **or** **AMD** Always Free micro shape if Ampere is unavailable. Prefer the free tier shape Oracle highlights.  
7. **Networking**: leave “Create new virtual cloud network” checked if this is your first VM.  
8. **SSH keys**: choose **Generate a key pair for me** → **Save private key** and **Save public key** to your PC Downloads folder. Keep the private key safe.  
9. Click **Create**.

What you should see: instance state becomes **Running** (green). Copy the **Public IP address** and save it in a notepad.

If Create fails with capacity errors: try the other US region (Phoenix ↔ Ashburn), or the other free shape (Ampere ↔ AMD).

---

## 4) Open the firewall for SSH only

1. On the instance page, click the **Subnet** link.  
2. Open the **Default Security List**.  
3. Confirm there is an Ingress rule for **TCP port 22** (SSH).  
4. Do **not** open port 80/443 for the engine — it does not serve a public website.

---

## 5) Connect with SSH from Windows

1. Open PowerShell.  
2. Go to the folder where you saved the private key (often Downloads).  
3. Paste this block (replace the path and IP):

```powershell
cd $HOME\Downloads
ssh -i .\ssh-key-YYYY-MM-DD.key ubuntu@YOUR_PUBLIC_IP
```

First time, type `yes` when asked about fingerprint.

What you should see: a Linux prompt like `ubuntu@beacon:~$`.

If permission denied: make sure you used the **private** key file and the user `ubuntu` (Ubuntu images).

---

## 6) Install Node.js and browser dependencies on the VM

Paste this **entire** block into the SSH window:

```bash
sudo apt-get update
sudo apt-get install -y curl git ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 libxcomposite1 libxdamage1 libxrandr2 xdg-utils
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

What you should see: `node -v` prints something like `v22.x.x`.

---

## 7) Copy the project to the VM

**Option A — from your PC with SCP (simple):**

In a **new** PowerShell window on your PC (not the SSH session):

```powershell
cd d:\bots
scp -i $HOME\Downloads\ssh-key-YYYY-MM-DD.key -r engine ubuntu@YOUR_PUBLIC_IP:~/beacon-engine
```

**Option B — git clone** if you pushed the repo to GitHub:

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git
cd YOUR_REPO/engine
```

What you should see: on the VM, `ls ~/beacon-engine` shows `package.json`, `src`, `config`.

---

## 8) Install engine packages + Playwright on the VM

In the SSH session:

```bash
cd ~/beacon-engine
npm install
npx playwright install --with-deps chromium webkit
```

What you should see: install finishes without a fatal error.

---

## 9) Create the production `.env` on the VM

```bash
cd ~/beacon-engine
cp .env.example .env
nano .env
```

Fill in the same Supabase + email + IMAP values as your PC.

**Critical production lines:**

```
FORCE_PRODUCTION=true
```

Save in nano: `Ctrl+O`, Enter, then `Ctrl+X`.

---

## 10) Prove the US IP guard passes

```bash
cd ~/beacon-engine
npm run check:one
```

What you should see:

- A line like `US production run OK` (or US IP detected with production true)  
- **No** “NON-US TEST RUN” banner  
- A new row in Supabase `load_checks` with `is_production = true`

If you still see NON-US: you are not on a US region VM. Recreate the instance in Ashburn or Phoenix.

---

## 11) Run the scheduler forever with systemd

Create a service file:

```bash
sudo nano /etc/systemd/system/beacon.service
```

Paste exactly (adjust the path if your folder name differs):

```
[Unit]
Description=Beacon monitoring engine
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/beacon-engine
ExecStart=/usr/bin/npm run scheduler
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then paste:

```bash
sudo systemctl daemon-reload
sudo systemctl enable beacon
sudo systemctl start beacon
sudo systemctl status beacon
```

What you should see: `Active: active (running)`.

Useful commands later:

```bash
sudo systemctl stop beacon
sudo systemctl start beacon
sudo journalctl -u beacon -f
```

---

## 12) Optional: Supabase watchdog (engine-down alert)

The SQL migration already created a function `check_engine_watchdog()`.

1. Supabase → **Edge Functions** or **Database** → **Extensions** → enable `pg_cron` if available on your plan.  
2. If `pg_cron` is available, in SQL Editor:

```sql
select cron.schedule(
  'engine-watchdog',
  '*/15 * * * *',
  $$ select public.check_engine_watchdog(); $$
);

select cron.schedule(
  'monitoring-cleanup',
  '15 8 * * *',
  $$ select public.cleanup_old_monitoring_data(); $$
);
```

If `pg_cron` is not available on free tier: skip this. The VM systemd Restart=always still auto-recovers most crashes. You can also call the watchdog from a free external uptime ping later.

---

## Done checklist

- [ ] VM in Ashburn or Phoenix  
- [ ] `FORCE_PRODUCTION=true`  
- [ ] `npm run check:one` writes `is_production=true`  
- [ ] `beacon` systemd service is running  
- [ ] Dashboard shows fresh green/yellow/red cards  

Your home PC can still run `npm run check:one` anytime — those rows stay `is_production=false` and never count as production.
