import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { DateTime } from "luxon";

const sqlite = new Database(":memory:");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles');
`);
const testDb = drizzle(sqlite, { schema });

vi.mock("../db/index.js", () => ({
  default: testDb,
  db: testDb,
  sqliteDb: sqlite,
}));

import {
  getTimezone, setTimezone, localToUTC, utcToLocal,
  localDateTimeToUTC, formatLocalTimeShort, todayLocal,
} from "../services/timezone.js";

function resetTimezone(tz = "America/Los_Angeles") {
  sqlite.exec(`DELETE FROM settings WHERE key = 'timezone'`);
  sqlite.exec(`INSERT INTO settings (key, value) VALUES ('timezone', '${tz}')`);
}

describe("timezone service", () => {
  beforeEach(() => resetTimezone());

  describe("getTimezone / setTimezone", () => {
    it("returns default timezone", () => {
      expect(getTimezone()).toBe("America/Los_Angeles");
    });

    it("updates and reads back", () => {
      setTimezone("America/New_York");
      expect(getTimezone()).toBe("America/New_York");
    });

    it("rejects invalid timezone", () => {
      expect(() => setTimezone("Not/Real")).toThrow();
    });
  });

  describe("localToUTC", () => {
    it("converts 3pm PDT to 10pm UTC", () => {
      expect(localToUTC("2026-07-15T15:00:00")).toBe("2026-07-15T22:00:00.000Z");
    });

    it("converts 3pm PST to 11pm UTC", () => {
      expect(localToUTC("2026-01-15T15:00:00")).toBe("2026-01-15T23:00:00.000Z");
    });

    it("handles midnight crossover PDT", () => {
      expect(localToUTC("2026-07-15T23:00:00")).toBe("2026-07-16T06:00:00.000Z");
    });
  });

  describe("utcToLocal", () => {
    it("converts UTC to Pacific", () => {
      expect(utcToLocal("2026-07-15T22:00:00.000Z")).toBe("2026-07-15T15:00:00");
    });

    it("returns ISO without offset", () => {
      const result = utcToLocal("2026-07-15T22:00:00.000Z");
      expect(result).not.toMatch(/[Z+-]/);
    });

    it("round-trips correctly", () => {
      const original = "2026-07-15T22:00:00.000Z";
      expect(localToUTC(utcToLocal(original))).toBe(original);
    });
  });

  describe("localDateTimeToUTC", () => {
    it("combines date + time", () => {
      expect(localDateTimeToUTC("2026-07-15", "15:00")).toBe("2026-07-15T22:00:00.000Z");
    });

    it("handles midnight", () => {
      expect(localDateTimeToUTC("2026-07-15", "00:00")).toBe("2026-07-15T07:00:00.000Z");
    });

    it("handles DST spring forward", () => {
      expect(localDateTimeToUTC("2026-03-08", "15:00")).toBe("2026-03-08T22:00:00.000Z");
    });
  });

  describe("formatLocalTimeShort", () => {
    it("formats 3pm correctly", () => {
      expect(formatLocalTimeShort("2026-07-15T22:00:00.000Z")).toBe("3:00 PM");
    });

    it("formats noon", () => {
      expect(formatLocalTimeShort("2026-07-15T19:00:00.000Z")).toBe("12:00 PM");
    });

    it("formats midnight", () => {
      expect(formatLocalTimeShort("2026-07-15T07:00:00.000Z")).toBe("12:00 AM");
    });
  });

  describe("todayLocal", () => {
    it("returns YYYY-MM-DD format", () => {
      expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("matches luxon today in configured timezone", () => {
      expect(todayLocal()).toBe(DateTime.now().setZone("America/Los_Angeles").toISODate());
    });
  });
});
