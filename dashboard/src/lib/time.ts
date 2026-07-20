/** All dashboard times shown in Pakistan (your local tuning timezone). */
export const PAKISTAN_TZ = 'Asia/Karachi';
export const EASTERN_TZ = 'America/New_York';
export const TIME_LABEL = 'PKT';

const defaultDateOpts: Intl.DateTimeFormatOptions = {
  timeZone: PAKISTAN_TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

export function formatPakistanTime(
  iso: string | null | undefined,
  opts?: Intl.DateTimeFormatOptions
): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PK', { ...defaultDateOpts, ...opts });
}

export function formatPakistanTimeShort(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return formatPakistanTime(iso, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatPakistanTimeShort(iso);
}

export function formatPakistanChartTick(iso: string): string {
  return new Date(iso).toLocaleString('en-PK', {
    timeZone: PAKISTAN_TZ,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function nowPakistanClock(): string {
  return new Date().toLocaleString('en-PK', {
    timeZone: PAKISTAN_TZ,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.trim().split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

function formatHm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getHmInZone(date: Date, tz: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return { h: h === 24 ? 0 : h, m };
}

function wallClockToDate(hm: string, tz: string, ref = new Date()): Date {
  const { h, m } = parseHm(hm);
  const ymd = ref.toLocaleDateString('en-CA', { timeZone: tz });
  let utc = Date.parse(`${ymd}T${formatHm(h, m)}:00Z`);
  for (let i = 0; i < 5; i++) {
    const shown = getHmInZone(new Date(utc), tz);
    const diffMin = h * 60 + m - (shown.h * 60 + shown.m);
    if (diffMin === 0) break;
    utc += diffMin * 60_000;
  }
  return new Date(utc);
}

/** Engine stores US Eastern schedule — show/edit as Pakistan time in the UI. */
export function easternHmToPakistanHm(easternHm: string): string {
  const d = wallClockToDate(easternHm, EASTERN_TZ);
  const { h, m } = getHmInZone(d, PAKISTAN_TZ);
  return formatHm(h, m);
}

export function pakistanHmToEasternHm(pakistanHm: string): string {
  const d = wallClockToDate(pakistanHm, PAKISTAN_TZ);
  const { h, m } = getHmInZone(d, EASTERN_TZ);
  return formatHm(h, m);
}

export function easternTimesToPakistanText(easternTimes: string[]): string {
  return easternTimes.map(easternHmToPakistanHm).join(', ');
}

export function pakistanTimesTextToEastern(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(pakistanHmToEasternHm);
}

export function sinceIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function sinceDays(days: number): string {
  return sinceIso(days * 24);
}
