/**
 * Daily HTML report email — skimmable on a phone.
 * Runs at 23:30 US Eastern (scheduled separately).
 */

import { getEnv } from '../config.js';
import { getSupabase } from '../db/supabase.js';
import { sendHtmlEmail } from '../alerts/email.js';

function easternDayBounds(now = new Date(), requestedLabel?: string): { start: Date; end: Date; label: string } {
  // Approximate Eastern offset (handles EST/EDT via Intl)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  const label = requestedLabel || `${y}-${m}-${d}`;

  // Convert Eastern midnight ↔ next midnight to UTC via Date parsing trick
  const start = new Date(
    new Date(`${label}T00:00:00`).toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  // More reliable: use temporal-like offset from formatter
  const startUtc = easternLocalToUtc(label, '00:00:00');
  const endUtc = easternLocalToUtc(label, '23:59:59.999');
  return { start: startUtc, end: endUtc, label };
}

function easternLocalToUtc(dateLabel: string, time: string): Date {
  // Interpret dateLabel + time as America/New_York
  const guess = new Date(`${dateLabel}T${time}-05:00`);
  // Correct with actual offset at that moment
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  // Simpler approach: iterate — for reporting, use UTC day windows labeled Eastern
  void formatter;
  void guess;
  const [y, m, d] = dateLabel.split('-').map(Number);
  // Build using toLocale trick
  const utcGuess = Date.UTC(y, m - 1, d, 5, 0, 0); // rough EST
  // Find offset
  const asEastern = new Date(utcGuess).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const local = new Date(asEastern);
  const offset = local.getTime() - utcGuess;
  const [hh, mm, ssMs] = time.split(':');
  const ss = Number(ssMs);
  const base = Date.UTC(y, m - 1, d, Number(hh), Number(mm), Math.floor(ss));
  return new Date(base - offset);
}

async function signedScreenshotUrl(value: string | null): Promise<string | null> {
  if (!value) return null;
  const marker = '/storage/v1/object/public/screenshots/';
  const path = value.includes(marker)
    ? decodeURIComponent(value.slice(value.indexOf(marker) + marker.length))
    : value.replace(/^screenshots\//, '');
  const { data, error } = await getSupabase().storage
    .from('screenshots')
    .createSignedUrl(path, 7 * 24 * 60 * 60);
  return error ? null : data.signedUrl;
}

type Verdict = 'HEALTHY' | 'DEGRADED' | 'BROKEN';

function verdictFor(opts: {
  uptime: number;
  formFail: boolean;
  openIncidents: number;
}): Verdict {
  if (opts.uptime < 90 || opts.openIncidents > 0 && opts.formFail) return 'BROKEN';
  if (opts.uptime < 99 || opts.openIncidents > 0 || opts.formFail) return 'DEGRADED';
  return 'HEALTHY';
}

export async function generateAndSendDailyReport(reportDate?: string): Promise<void> {
  const sb = getSupabase();
  const { start, end, label } = easternDayBounds(new Date(), reportDate);
  const weekAgo = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: sites, error: sitesErr } = await sb
    .from('sites')
    .select('id,name')
    .eq('active', true)
    .order('name');
  if (sitesErr) throw new Error(sitesErr.message);

  const sections: string[] = [];

  for (const site of sites || []) {
    const { data: checks } = await sb
      .from('load_checks')
      .select('profile,loaded,load_ms,lcp_ms,console_errors,checked_at,status_code,outcome')
      .eq('site_id', site.id)
      .eq('is_production', true)
      .gte('checked_at', start.toISOString())
      .lte('checked_at', end.toISOString());

    const { data: weekChecks } = await sb
      .from('load_checks')
      .select('lcp_ms')
      .eq('site_id', site.id)
      .eq('is_production', true)
      .gte('checked_at', weekAgo.toISOString())
      .lt('checked_at', start.toISOString());

    const { data: forms } = await sb
      .from('form_tests')
      .select('layer1_pass,layer2_pass,layer3_pass,submit_to_inbox_seconds,logo_upload_ok,outcome')
      .eq('site_id', site.id)
      .eq('is_production', true)
      .gte('tested_at', start.toISOString())
      .lte('tested_at', end.toISOString());

    const { data: incidents } = await sb
      .from('incidents')
      .select('type,detail,opened_at,closed_at,screenshot_path')
      .eq('site_id', site.id)
      .eq('is_production', true)
      .gte('opened_at', start.toISOString())
      .lte('opened_at', end.toISOString())
      .order('opened_at', { ascending: false });

    const byProfile: Record<string, { total: number; ok: number; loads: number[]; lcps: number[] }> =
      {};
    for (const c of (checks || []).filter(
      (check) =>
        check.status_code !== 429 &&
        check.outcome !== 'rate_limited' &&
        check.outcome !== 'monitor_error'
    )) {
      const p = c.profile as string;
      byProfile[p] ||= { total: 0, ok: 0, loads: [], lcps: [] };
      byProfile[p].total += 1;
      if (c.loaded) byProfile[p].ok += 1;
      if (c.load_ms != null) byProfile[p].loads.push(c.load_ms);
      if (c.lcp_ms != null) byProfile[p].lcps.push(c.lcp_ms);
    }

    const weekLcps = (weekChecks || [])
      .map((c) => c.lcp_ms)
      .filter((n): n is number => n != null);
    const weekAvgLcp =
      weekLcps.length > 0
        ? Math.round(weekLcps.reduce((a, b) => a + b, 0) / weekLcps.length)
        : null;

    let profileHtml = '';
    let overallUptime = 100;
    for (const [profile, stats] of Object.entries(byProfile)) {
      const uptime = stats.total ? Math.round((stats.ok / stats.total) * 1000) / 10 : 0;
      overallUptime = Math.min(overallUptime, uptime || 0);
      const avg =
        stats.loads.length > 0
          ? Math.round(stats.loads.reduce((a, b) => a + b, 0) / stats.loads.length)
          : null;
      const worst = stats.loads.length ? Math.max(...stats.loads) : null;
      const avgLcp =
        stats.lcps.length > 0
          ? Math.round(stats.lcps.reduce((a, b) => a + b, 0) / stats.lcps.length)
          : null;
      const lcpTrend =
        avgLcp != null && weekAvgLcp != null
          ? avgLcp - weekAvgLcp > 200
            ? 'slower than 7-day avg'
            : avgLcp - weekAvgLcp < -200
              ? 'faster than 7-day avg'
              : 'similar to 7-day avg'
          : 'n/a';
      profileHtml += `<li><strong>${profile}</strong>: uptime ${uptime}% · avg ${avg ?? '—'}ms · worst ${worst ?? '—'}ms · LCP ${avgLcp ?? '—'}ms (${lcpTrend})</li>`;
    }
    if (!profileHtml) profileHtml = '<li>No load checks recorded today</li>';

    // Console errors summary
    const errorTexts = new Map<string, number>();
    for (const c of checks || []) {
      const errs = (c.console_errors as Array<{ text: string }>) || [];
      for (const e of errs) {
        const t = (e.text || '').slice(0, 120);
        if (!t) continue;
        errorTexts.set(t, (errorTexts.get(t) || 0) + 1);
      }
    }
    const errorLines = [...errorTexts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t, n]) => `<li>${n}× ${escapeHtml(t)}</li>`)
      .join('');

    const formList = (forms || []).filter(
      (form) => form.outcome !== 'rate_limited' && form.outcome !== 'monitor_error'
    );
    const l1 = formList.filter((f) => f.layer1_pass === true).length;
    const l2 = formList.filter((f) => f.layer2_pass === true).length;
    const formTotal = formList.length;
    const avgInbox =
      formList
        .map((f) => f.submit_to_inbox_seconds)
        .filter((n): n is number => n != null)
        .reduce((a, b, _, arr) => a + b / arr.length, 0) || null;
    const logoOk = formList.filter((f) => f.logo_upload_ok === true).length;
    const formFail = formList.some(
      (f) => f.layer1_pass === false || f.layer2_pass === false
    );

    const openIncidents = (incidents || []).filter((i) => !i.closed_at).length;
    const v = verdictFor({
      uptime: overallUptime,
      formFail,
      openIncidents,
    });
    const color =
      v === 'HEALTHY' ? '#0a7a32' : v === 'DEGRADED' ? '#a15c00' : '#b00020';

    const incidentRows = await Promise.all(
      (incidents || []).map(async (incident) => ({
        ...incident,
        signedScreenshot: await signedScreenshotUrl(incident.screenshot_path),
      }))
    );
    const incidentHtml = incidentRows
      .map((i) => {
        const shot = i.signedScreenshot
          ? ` · <a href="${i.signedScreenshot}">screenshot</a>`
          : '';
        return `<li><strong>${escapeHtml(i.type)}</strong> ${escapeHtml(i.detail || '')} <em>(${i.opened_at}${i.closed_at ? ` → ${i.closed_at}` : ' — still open'})</em>${shot}</li>`;
      })
      .join('');

    sections.push(`
      <section style="margin:0 0 28px;padding:16px;border:1px solid #e5e5e5;border-radius:8px">
        <h2 style="margin:0 0 8px;font-size:20px">${escapeHtml(site.name)}
          <span style="color:${color};font-size:14px;margin-left:8px">${v}</span>
        </h2>
        <p style="margin:0 0 12px;color:#444">Uptime &amp; speed</p>
        <ul style="margin:0 0 12px;padding-left:18px">${profileHtml}</ul>
        <p style="margin:0 0 6px;color:#444">Console errors</p>
        <ul style="margin:0 0 12px;padding-left:18px">${errorLines || '<li>None recorded</li>'}</ul>
        <p style="margin:0 0 6px;color:#444">Form tests</p>
        <ul style="margin:0 0 12px;padding-left:18px">
          <li>Runs today: ${formTotal}</li>
          <li>Layer 1 success: ${formTotal ? Math.round((l1 / formTotal) * 100) : 0}%</li>
          <li>Layer 2 success: ${formTotal ? Math.round((l2 / formTotal) * 100) : 0}%</li>
          <li>Avg submit→inbox: ${avgInbox != null ? `${Math.round(avgInbox)}s` : '—'}</li>
          <li>Logo upload OK: ${logoOk}/${formTotal}</li>
        </ul>
        <p style="margin:0 0 6px;color:#444">Incidents</p>
        <ul style="margin:0;padding-left:18px">${incidentHtml || '<li>None</li>'}</ul>
      </section>
    `);
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#111">
      <h1 style="font-size:22px;margin:0 0 4px">Daily monitoring report</h1>
      <p style="margin:0 0 20px;color:#666">US Eastern day ${label}</p>
      ${sections.join('\n') || '<p>No active sites.</p>'}
      <p style="font-size:12px;color:#888;margin-top:24px">Details live in Supabase / the dashboard. This email is the skimmable summary.</p>
    </div>
  `;

  const to = getEnv('REPORT_TO') || getEnv('ALERT_TO');
  const sent = await sendHtmlEmail(`[Beacon] Daily report ${label}`, html, to || undefined);
  console.log(sent ? `Daily report emailed to ${to}` : 'Daily report built but email was not sent (configure REPORT_TO).');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
