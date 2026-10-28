import { getISTDateRangeUtc } from '../db/applications.js';
import { getISTDateString } from '../services/workHistoryClient.js';

export { getISTDateRangeUtc };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstCalendarDate {
  year: number;
  month: number;
  day: number;
  isoDate: string;
  dayOfWeek: number; // 1 = Monday, ..., 7 = Sunday
}

export function getIstCalendarDate(instant: Date | number = Date.now()): IstCalendarDate {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  const istDate = new Date(ms + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth() + 1;
  const day = istDate.getUTCDate();
  const utcDay = istDate.getUTCDay();
  const dayOfWeek = utcDay === 0 ? 7 : utcDay;
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, isoDate, dayOfWeek };
}

export type DashboardCreatedAtPreset = 'default' | 'day' | 'week' | 'month' | 'lifetime' | 'custom' | 'legacy_day';

export interface DashboardCreatedAtRange {
  startIso: string;
  endIso: string | null;
  preset: DashboardCreatedAtPreset;
  fromDate?: string;
  toDate?: string;
  label: string;
}

export function parseDashboardStatsRange(
  query: Record<string, unknown>,
  referenceInstant: Date | number = Date.now()
): DashboardCreatedAtRange | { error: string } {
  let explicitRange = typeof query.range === 'string' ? query.range.trim().toLowerCase() : '';
  if (explicitRange === 'today') explicitRange = 'day';
  const hasCustomDates = typeof query.from === 'string' || typeof query.to === 'string';
  const singleDate = typeof query.date === 'string' && ISO_DATE.test(query.date.trim()) ? query.date.trim() : '';
  const range = explicitRange || (hasCustomDates || singleDate ? 'custom' : 'day');

  const refMs = typeof referenceInstant === 'number' ? referenceInstant : referenceInstant.getTime();
  const istNow = getIstCalendarDate(refMs);
  const today = istNow.isoDate;
  let fromDate = today;

  if (range === 'week') {
    const daysSinceMonday = istNow.dayOfWeek - 1;
    const mondayMs = refMs - daysSinceMonday * 24 * 60 * 60 * 1000;
    fromDate = getIstCalendarDate(mondayMs).isoDate;
  } else if (range === 'month') {
    fromDate = `${istNow.year}-${String(istNow.month).padStart(2, '0')}-01`;
  } else if (range === 'lifetime') {
    fromDate = '2000-01-01';
  } else if (range !== 'day' && range !== 'custom') {
    return { error: 'range must be day, week, month, lifetime, or custom.' };
  }

  if (range === 'custom') {
    const from = (typeof query.from === 'string' ? query.from.trim() : '') || singleDate;
    const to = (typeof query.to === 'string' ? query.to.trim() : '') || singleDate;
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
      return { error: 'custom stats ranges require valid from and to dates.' };
    }
    fromDate = from;
    const { startIso } = getISTDateRangeUtc(from);
    const { endIso } = getISTDateRangeUtc(to);
    return { startIso, endIso, preset: 'custom', fromDate: from, toDate: to, label: `${from} - ${to}` };
  }

  const { startIso } = getISTDateRangeUtc(fromDate);
  const { endIso } = getISTDateRangeUtc(today);
  return {
    startIso,
    endIso,
    preset: range,
    fromDate,
    toDate: today,
    label: range === 'day' ? 'Today' : range === 'week' ? 'This Week' : range === 'month' ? 'This Month' : range === 'lifetime' ? 'Lifetime' : 'Stats',
  };
}

export function defaultDashboardCreatedAtRange(): DashboardCreatedAtRange {
  const startIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  return {
    startIso,
    endIso: null,
    preset: 'default',
    label: 'Today & Yesterday',
  };
}

function formatIstCalendarFromInstant(instantMs: number): string {
  const istDate = new Date(instantMs + 5.5 * 60 * 60 * 1000);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function listIstDatesInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursorMs = new Date(`${from}T00:00:00+05:30`).getTime();
  const endMs = new Date(`${to}T00:00:00+05:30`).getTime();
  while (cursorMs <= endMs) {
    dates.push(formatIstCalendarFromInstant(cursorMs));
    cursorMs += 24 * 60 * 60 * 1000;
    if (dates.length > 366) break;
  }
  return dates;
}

export function istDatesForWorkHistory(range: DashboardCreatedAtRange): string[] {
  if (range.preset === 'default') {
    return [getISTDateString(0), getISTDateString(1)];
  }
  if (range.fromDate && range.toDate) {
    return listIstDatesInclusive(range.fromDate, range.toDate);
  }
  return [getISTDateString(0), getISTDateString(1)];
}

export function parseDashboardCreatedAtRange(
  query: Record<string, unknown>
): DashboardCreatedAtRange | { error: string } {
  const from = typeof query.from === 'string' ? query.from.trim() : '';
  const to = typeof query.to === 'string' ? query.to.trim() : '';
  const legacyDate = typeof query.date === 'string' ? query.date.trim() : '';
  if (from || to) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return { error: 'from and to must use YYYY-MM-DD format.' };
    }
    if (from > to) {
      return { error: 'from must be on or before to.' };
    }
    const { startIso } = getISTDateRangeUtc(from);
    const { endIso } = getISTDateRangeUtc(to);
    return {
      startIso,
      endIso,
      preset: 'custom',
      fromDate: from,
      toDate: to,
      label: `${from} - ${to}`,
    };
  }
  if (legacyDate) {
    if (!ISO_DATE.test(legacyDate)) {
      return { error: 'date must use YYYY-MM-DD format.' };
    }
    const { startIso, endIso } = getISTDateRangeUtc(legacyDate);
    return {
      startIso,
      endIso,
      preset: 'legacy_day',
      fromDate: legacyDate,
      toDate: legacyDate,
      label: legacyDate,
    };
  }

  return defaultDashboardCreatedAtRange();
}

export function serializeDateRange(range: DashboardCreatedAtRange): {
  preset: DashboardCreatedAtPreset;
  from: string | null;
  to: string | null;
  label: string;
} {
  return {
    preset: range.preset,
    from: range.fromDate ?? null,
    to: range.toDate ?? null,
    label: range.label,
  };
}
