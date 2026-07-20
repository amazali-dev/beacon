/**
 * Instant email alerts with anti-spam:
 * one alert per site per issue type per cooldown window (default 2 hours).
 */

import nodemailer from 'nodemailer';
import { getEnv, isStagingMode, loadConfig, getStagingLabel } from '../config.js';
import { findOpenIncident, markIncidentAlerted } from '../db/supabase.js';

function smtpReady(): boolean {
  if (getEnv('RESEND_API_KEY')) return true;
  return Boolean(getEnv('SMTP_USER') && getEnv('SMTP_PASS') && getEnv('ALERT_TO'));
}

async function sendMail(opts: {
  subject: string;
  html: string;
  to?: string;
}): Promise<boolean> {
  const to = opts.to || getEnv('ALERT_TO') || getEnv('REPORT_TO');
  if (!to) {
    console.warn('No ALERT_TO / REPORT_TO set — email skipped.');
    return false;
  }

  const resendKey = getEnv('RESEND_API_KEY');
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: getEnv('SMTP_USER', 'alerts@beacon.local'),
        to: [to],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      console.warn('Resend email failed:', await res.text());
      return false;
    }
    return true;
  }

  if (!getEnv('SMTP_USER') || !getEnv('SMTP_PASS')) {
    console.warn('SMTP not configured — email skipped.');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: getEnv('SMTP_HOST', 'smtp.gmail.com'),
    port: Number(getEnv('SMTP_PORT', '587')),
    secure: false,
    auth: {
      user: getEnv('SMTP_USER'),
      pass: getEnv('SMTP_PASS'),
    },
  });

  await transporter.sendMail({
    from: getEnv('SMTP_USER'),
    to,
    subject: opts.subject,
    html: opts.html,
  });
  return true;
}

export async function maybeSendAlert(opts: {
  incidentId: string;
  siteId: string;
  siteName: string;
  type: string;
  detail: string;
  screenshotPath?: string | null;
  cooldownHours: number;
}): Promise<void> {
  try {
    const config = loadConfig();
    if (config.skipAlertsInStaging && isStagingMode()) {
      console.log(
        `Alert skipped (${getStagingLabel()} — email alerts off until production): ${opts.type} / ${opts.siteName}`
      );
      return;
    }

    if (!smtpReady()) {
      console.log(`Alert skipped (email not configured): ${opts.type} / ${opts.siteName}`);
      return;
    }

    const open = await findOpenIncident(opts.siteId, opts.type);
    if (open?.last_alerted_at) {
      const last = new Date(open.last_alerted_at).getTime();
      const cooldownMs = opts.cooldownHours * 60 * 60 * 1000;
      if (Date.now() - last < cooldownMs) {
        console.log(
          `Alert suppressed (cooldown ${opts.cooldownHours}h): ${opts.type} / ${opts.siteName}`
        );
        return;
      }
    }

    const screenshotHtml = opts.screenshotPath
      ? `<p><img src="${opts.screenshotPath}" alt="Failure screenshot" style="max-width:100%;border:1px solid #ccc" /></p>
       <p><a href="${opts.screenshotPath}">Open screenshot</a></p>`
      : '<p>(No screenshot available)</p>';

    const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4">
      <h2 style="color:#b00020">Alert: ${opts.siteName}</h2>
      <p><strong>Issue:</strong> ${opts.type}</p>
      <p>${opts.detail}</p>
      ${screenshotHtml}
      <p style="color:#666;font-size:13px">Anti-spam: at most one alert per site per issue every ${opts.cooldownHours} hours.</p>
    </div>
  `;

    const sent = await sendMail({
      subject: `[Beacon] ${opts.siteName}: ${opts.type}`,
      html,
    });
    if (sent) {
      await markIncidentAlerted(opts.incidentId);
      console.log(`Alert emailed for ${opts.siteName} / ${opts.type}`);
    }
  } catch (err) {
    // Never let email problems crash a site check
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Alert email failed (check continues anyway): ${message}`);
  }
}

export async function sendHtmlEmail(subject: string, html: string, to?: string): Promise<boolean> {
  return sendMail({ subject, html, to });
}

// Re-export config helper used by daily report
export { loadConfig };
