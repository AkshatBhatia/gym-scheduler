import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for dashboard/overview tools:
 *   - get_daily_summary: today's appointment count, upcoming list, low-balance alerts
 *   - get_weekly_summary: appointments per day for the week
 *
 * Expected service functions:
 *   getDailySummary(): Promise<{ todayCount, upcoming, lowBalanceClients, ... }>
 *   getWeeklySummary(weekStart?: string): Promise<{ days: Record<string, ...> }>
 */

let testDb: ReturnType<typeof createTestDb>;

vi.mock("../db/index.js", () => ({
  get db() { return testDb.db; },
  get default() { return testDb.db; },
  get sqliteDb() { return testDb.sqlite; },
}));

vi.mock("../services/timezone.js", () => ({
  getTimezone: () => "UTC",
  localToUTC: (iso: string) => new Date(iso).toISOString(),
  utcToLocal: (iso: string) => iso.replace(/\.000Z$/, "").replace(/Z$/, ""),
  todayLocal: () => "2026-04-13", // Monday
  formatLocalTimeShort: (iso: string) => iso,
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

// TODO: update imports once service functions are implemented
const { getDailySummary, getWeeklySummary } = await import("../services/dashboard.js");

describe("get_daily_summary", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns today's appointment count (non-cancelled)", async () => {
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 2, startTime: "2026-04-13T14:00:00.000Z", endTime: "2026-04-13T15:00:00.000Z", status: "confirmed" },
      { clientId: 3, startTime: "2026-04-13T16:00:00.000Z", endTime: "2026-04-13T17:00:00.000Z", status: "cancelled" },
    ]).run();

    const result = await getDailySummary();
    expect(result.todayCount).toBe(2); // cancelled excluded
  });

  it("returns upcoming confirmed appointments with client names", async () => {
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 2, startTime: "2026-04-13T14:00:00.000Z", endTime: "2026-04-13T15:00:00.000Z", status: "confirmed" },
    ]).run();

    const result = await getDailySummary();
    expect(result.upcoming.length).toBe(2);
    expect(result.upcoming[0]).toHaveProperty("clientName");
    expect(result.upcoming[0]).toHaveProperty("startTime");
  });

  it("returns low-balance clients (sessionsRemaining ≤ 2)", async () => {
    // Emily has 4 sessions — not low. Set her to 1.
    testDb.db.update(schema.clients).set({ sessionsRemaining: 1 }).where(eq(schema.clients.id, 3)).run();

    const result = await getDailySummary();
    const lowNames = result.lowBalanceClients.map((c: any) => c.name);
    expect(lowNames).toContain("Emily Rodriguez");
  });

  it("excludes inactive clients from low-balance alerts", async () => {
    // Inactive Joe has 5 sessions but is inactive — should not appear
    const result = await getDailySummary();
    const names = result.lowBalanceClients.map((c: any) => c.name);
    expect(names).not.toContain("Inactive Joe");
  });

  it("returns 0 count when no appointments today", async () => {
    const result = await getDailySummary();
    expect(result.todayCount).toBe(0);
    expect(result.upcoming).toEqual([]);
  });
});

describe("get_weekly_summary", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns appointments grouped by day for the current week", async () => {
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 2, startTime: "2026-04-15T10:00:00.000Z", endTime: "2026-04-15T11:00:00.000Z", status: "confirmed" },
      { clientId: 1, startTime: "2026-04-17T10:00:00.000Z", endTime: "2026-04-17T11:00:00.000Z", status: "confirmed" },
    ]).run();

    const result = await getWeeklySummary();

    expect(result.days).toBeDefined();
    // Should have 7 day entries
    expect(Object.keys(result.days).length).toBe(7);
  });

  it("includes total appointment count for the week", async () => {
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 2, startTime: "2026-04-15T10:00:00.000Z", endTime: "2026-04-15T11:00:00.000Z", status: "confirmed" },
    ]).run();

    const result = await getWeeklySummary();
    expect(result.totalCount).toBe(2);
  });

  it("excludes cancelled appointments from counts", async () => {
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 2, startTime: "2026-04-13T14:00:00.000Z", endTime: "2026-04-13T15:00:00.000Z", status: "cancelled" },
    ]).run();

    const result = await getWeeklySummary();
    expect(result.totalCount).toBe(1);
  });
});
