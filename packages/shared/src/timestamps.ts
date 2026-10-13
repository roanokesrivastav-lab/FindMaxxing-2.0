/** Timestamp checks shared by the web app, the mobile app and validation. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2})(?::?(\d{2}))?)$/;

export function isValidTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const [offsetHours, offsetMinutes] = [Number(m[9] ?? 0), Number(m[10] ?? 0)];
  if (year < 1 || hour > 23 || minute > 59 || second > 59 || offsetHours > 15 || offsetMinutes > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
