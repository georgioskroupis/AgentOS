export interface CapacityWait {
  resetAt: string;
  delayMs: number;
  reason: string;
}

const MAX_CAPACITY_WAIT_MS = 24 * 60 * 60 * 1000;

export function detectCapacityWait(message: string, now = new Date()): CapacityWait | null {
  if (!/\b(usage limit|rate limit|capacity|quota|too many requests|429)\b/i.test(message)) return null;
  const resetAt = parseResetTime(message, now);
  if (!resetAt) return null;
  const delayMs = Math.max(0, resetAt.getTime() - now.getTime());
  if (delayMs > MAX_CAPACITY_WAIT_MS) return null;
  return {
    resetAt: resetAt.toISOString(),
    delayMs,
    reason: "codex usage capacity reset time was provided"
  };
}

function parseResetTime(message: string, now: Date): Date | null {
  const iso = message.match(/\b20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:?\d\d)\b/);
  if (iso) return validDate(iso[0]);

  const duration = message.match(/\b(?:try again|reset|available)[^\n.]*?\bin\s+((?:(?:\d+)\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\s*){1,4})/i);
  if (duration) {
    const delayMs = parseDurationMs(duration[1]);
    return delayMs == null ? null : new Date(now.getTime() + delayMs);
  }

  const englishDate = message.match(
    /\b(?:reset|resets|try again|available)\s+(?:at|after)\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM|am|pm)?/
  );
  if (englishDate) {
    const month = monthIndex(englishDate[1]);
    const day = Number(englishDate[2]);
    const year = Number(englishDate[3]);
    const hourRaw = Number(englishDate[4]);
    const minute = Number(englishDate[5] ?? 0);
    const second = Number(englishDate[6] ?? 0);
    const meridiem = englishDate[7]?.toLowerCase();
    const hour = normalizeHour(hourRaw, meridiem);
    if (month !== null && validDateParts(year, month, day, hour, minute, second)) return new Date(year, month, day, hour, minute, second, 0);
  }

  const resetClock = message.match(/\b(?:reset|resets|try again|available)\s+(?:at|after)\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM|am|pm)?(?:\s+([A-Z]{2,5}|UTC|GMT))?/);
  if (!resetClock) return null;
  const hourRaw = Number(resetClock[1]);
  const minute = Number(resetClock[2] ?? 0);
  const second = Number(resetClock[3] ?? 0);
  const meridiem = resetClock[4]?.toLowerCase();
  const hour = normalizeHour(hourRaw, meridiem);
  if (!validDateParts(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second)) return null;
  const resetAt = new Date(now);
  resetAt.setHours(hour, minute, second, 0);
  if (resetAt.getTime() <= now.getTime()) resetAt.setDate(resetAt.getDate() + 1);
  return resetAt;
}

function parseDurationMs(value: string): number | null {
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount)) return null;
    if (unit.startsWith("h")) total += amount * 60 * 60 * 1000;
    else if (unit.startsWith("m")) total += amount * 60 * 1000;
    else total += amount * 1000;
  }
  return matched ? total : null;
}

function validDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeHour(hourRaw: number, meridiem?: string): number {
  if (!Number.isInteger(hourRaw)) return Number.NaN;
  let hour = hourRaw;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour;
}

function validDateParts(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    Number.isInteger(second) &&
    month >= 0 &&
    month <= 11 &&
    day >= 1 &&
    day <= 31 &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function monthIndex(value: string): number | null {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const index = months.findIndex((month) => month.startsWith(value.toLowerCase()));
  return index === -1 ? null : index;
}
