import { getSupabase } from '../db/supabase.js';
import { loadConfig } from '../config.js';

function easternParts(now = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')) % 24,
  };
}

function previousDate(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function dueFormSlotKey(now: Date, configuredTimes: string[]): string | null {
  const eastern = easternParts(now);
  const slots = configuredTimes
    .map((time) => Number(time.split(':')[0]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!slots.length) return null;
  const slotHour = [...slots].reverse().find((hour) => hour <= eastern.hour) ?? slots.at(-1)!;
  const date = eastern.hour < slots[0]! ? previousDate(eastern.date) : eastern.date;
  return `${date}T${String(slotHour).padStart(2, '0')}:00-America/New_York`;
}

export function dueDailySlot(
  now: Date,
  configuredTime: string
): { key: string; reportDate: string } | null {
  const eastern = easternParts(now);
  const reportHour = Number(configuredTime.split(':')[0]);
  let reportDate: string | null = null;
  if (eastern.hour >= reportHour) reportDate = eastern.date;
  else if (eastern.hour <= 5) reportDate = previousDate(eastern.date);
  if (!reportDate) return null;
  return {
    key: `${reportDate}T${configuredTime}-America/New_York`,
    reportDate,
  };
}

async function claim(jobType: string, slotKey: string): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('claim_schedule_slot', {
    p_job_type: jobType,
    p_slot_key: slotKey,
  });
  if (error) throw new Error(`Could not claim ${jobType} slot: ${error.message}`);
  return Boolean(data);
}

export async function claimDueFormSlot(now = new Date()): Promise<string | null> {
  const key = dueFormSlotKey(now, loadConfig().formTestTimesEastern);
  if (!key) return null;
  return (await claim('form_test', key)) ? key : null;
}

export async function claimDueDailySlot(now = new Date()): Promise<{
  key: string;
  reportDate: string;
} | null> {
  const configuredTime = loadConfig().dailyReportTimeEastern || '23:30';
  const slot = dueDailySlot(now, configuredTime);
  if (!slot) return null;
  return (await claim('daily_report', slot.key)) ? slot : null;
}

export async function completeScheduleSlot(
  jobType: 'form_test' | 'daily_report',
  slotKey: string,
  success: boolean,
  detail?: string
): Promise<void> {
  const { error } = await getSupabase().rpc('complete_schedule_slot', {
    p_job_type: jobType,
    p_slot_key: slotKey,
    p_success: success,
    p_detail: detail || null,
  });
  if (error) throw new Error(`Could not complete ${jobType} slot: ${error.message}`);
}
