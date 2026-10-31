/** Calendar dates are handled as ISO `YYYY-MM-DD` strings so comparisons are timezone-free. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayUtc(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10);
}

/** Converts a Date coming from a Postgres `date` column (midnight UTC) to IsoDate. */
export function toIsoDate(value: Date | null | undefined): IsoDate | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
