import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import db from "../db/index.js";
import { settings } from "../db/schema.js";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

/**
 * Get the configured instructor timezone from settings.
 */
export function getTimezone(): string {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "timezone"))
    .get();
  return row?.value || DEFAULT_TIMEZONE;
}

/**
 * Set the instructor timezone.
 */
export function setTimezone(tz: string): void {
  // Validate the timezone
  if (!DateTime.now().setZone(tz).isValid) {
    throw new Error(`Invalid timezone: ${tz}`);
  }

  const existing = db
    .select()
    .from(settings)
    .where(eq(settings.key, "timezone"))
    .get();

  if (existing) {
    db.update(settings)
      .set({ value: tz, updatedAt: new Date().toISOString() })
      .where(eq(settings.key, "timezone"))
      .run();
  } else {
    db.insert(settings)
      .values({ key: "timezone", value: tz })
      .run();
  }
}

/**
 * Convert a local time string (e.g., "2026-04-08T15:00:00") in the instructor's
 * timezone to a UTC ISO string for database storage.
 */
export function localToUTC(localISO: string): string {
  const tz = getTimezone();
  const dt = DateTime.fromISO(localISO, { zone: tz });
  return dt.toUTC().toISO()!;
}

/**
 * Convert a UTC ISO string from the database to the instructor's local time.
 * Returns an ISO string in the local timezone.
 */
export function utcToLocal(utcISO: string): string {
  const tz = getTimezone();
  const dt = DateTime.fromISO(utcISO, { zone: "utc" });
  return dt.setZone(tz).toISO({ suppressMilliseconds: true, includeOffset: false })!;
}

/**
 * Format a UTC ISO string as a human-readable local time.
 * e.g., "Tuesday, April 8 at 3:00 PM"
 */
export function formatLocalTime(utcISO: string, format?: string): string {
  const tz = getTimezone();
  const dt = DateTime.fromISO(utcISO, { zone: "utc" }).setZone(tz);
  return dt.toFormat(format || "cccc, LLLL d 'at' h:mm a");
}

/**
 * Format just the time portion, e.g., "3:00 PM"
 */
export function formatLocalTimeShort(utcISO: string): string {
  const tz = getTimezone();
  const dt = DateTime.fromISO(utcISO, { zone: "utc" }).setZone(tz);
  return dt.toFormat("h:mm a");
}

/**
 * Get "today" in the instructor's timezone as YYYY-MM-DD.
 */
export function todayLocal(): string {
  const tz = getTimezone();
  return DateTime.now().setZone(tz).toISODate()!;
}

/**
 * Get "now" as a UTC ISO string.
 */
export function nowUTC(): string {
  return DateTime.utc().toISO()!;
}

/**
 * Format a Date object as YYYY-MM-DD string.
 */
export function formatDateYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Build a UTC datetime from a local date (YYYY-MM-DD) and local time (HH:MM).
 * This is what we use when the instructor says "book at 3pm on Tuesday".
 */
export function localDateTimeToUTC(date: string, time: string): string {
  const tz = getTimezone();
  const dt = DateTime.fromISO(`${date}T${time}:00`, { zone: tz });
  return dt.toUTC().toISO()!;
}
