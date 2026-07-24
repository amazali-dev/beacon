import { sendHtmlEmail } from '../alerts/email.js';
import { getSupabase } from '../db/supabase.js';

type AlertState = {
  key: string;
  detail: string;
  overdue: boolean;
};

function olderThan(value: string | null | undefined, maxMs: number): boolean {
  return !value || Date.now() - new Date(value).getTime() > maxMs;
}

export async function runOperationalWatchdog(): Promise<void> {
  const sb = getSupabase();
  const [loadRun, formSlot] = await Promise.all([
    sb
      .from('monitor_runs')
      .select('completed_at')
      .eq('job_type', 'load_check')
      .eq('is_production', true)
      .in('status', ['completed', 'partial'])
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('schedule_slots')
      .select('completed_at')
      .eq('job_type', 'form_test')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const result of [loadRun, formSlot]) {
    if (result.error) throw new Error(`Watchdog query failed: ${result.error.message}`);
  }

  // Close stale daily-report alert — scheduled reports are disabled for now.
  await sb
    .from('operational_alerts')
    .update({ closed_at: new Date().toISOString() })
    .eq('key', 'missed_daily_report')
    .is('closed_at', null);

  const states: AlertState[] = [
    {
      key: 'missed_load_run',
      detail: 'No completed production load run has been recorded in the last 90 minutes.',
      overdue: olderThan(loadRun.data?.completed_at, 90 * 60_000),
    },
    {
      key: 'missed_form_slot',
      detail: 'No completed scheduled form slot has been recorded in the last 8 hours.',
      overdue: olderThan(formSlot.data?.completed_at, 8 * 60 * 60_000),
    },
  ];

  for (const state of states) {
    const { data: existing, error } = await sb
      .from('operational_alerts')
      .select('closed_at,last_alerted_at')
      .eq('key', state.key)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!state.overdue) {
      if (existing && !existing.closed_at) {
        await sb
          .from('operational_alerts')
          .update({ closed_at: new Date().toISOString() })
          .eq('key', state.key);
      }
      continue;
    }

    const shouldAlert =
      !existing ||
      Boolean(existing.closed_at) ||
      olderThan(existing.last_alerted_at, 12 * 60 * 60_000);
    await sb.from('operational_alerts').upsert({
      key: state.key,
      detail: state.detail,
      opened_at: existing && !existing.closed_at ? undefined : new Date().toISOString(),
      closed_at: null,
      last_alerted_at: existing?.last_alerted_at || null,
    });
    if (shouldAlert) {
      const sent = await sendHtmlEmail(
        `Beacon scheduling alert: ${state.key.replaceAll('_', ' ')}`,
        `<h2>Beacon scheduling alert</h2><p>${state.detail}</p>`
      );
      if (sent) {
        await sb
          .from('operational_alerts')
          .update({ last_alerted_at: new Date().toISOString() })
          .eq('key', state.key);
      }
    }
  }
}
