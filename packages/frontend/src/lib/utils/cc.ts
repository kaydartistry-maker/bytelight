// Shared utilities for Command Center pages

export const CC_API = '/api/cc';

let _timezone: string | null = null;

async function getTimezone(): Promise<string> {
  if (_timezone) return _timezone;
  try {
    const res = await fetch('/api/cc/config', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      // Fall back to identity endpoint timezone
      _timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  } catch { /* ignore */ }
  // Use browser timezone as fallback
  if (!_timezone) _timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return _timezone;
}

export function todayStr(): string {
  // Use browser's resolved timezone (matches server config in most cases)
  return new Date().toLocaleDateString('en-CA', { timeZone: _timezone || undefined });
}

export function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function dayLabel(dateStr: string): { name: string; num: string } {
  const d = new Date(dateStr);
  return {
    name: d.toLocaleDateString('en-GB', { weekday: 'short' }),
    num: String(d.getDate()),
  };
}

export function daysLabel(d: number): string {
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return `${d} days`;
}

export function isToday(dateStr: string): boolean {
  return dateStr === todayStr();
}

export function shortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
