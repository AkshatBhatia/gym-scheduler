import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * skip_recurring_instance — spec says:
 *   - Cancels one or more weeks of a recurring appointment
 *   - Accepts optional `weeks` param (default 1)
 *   - No session deduction, no ledger entries
 *   - Recurring rule stays active; future appointments continue generating
 *   - Only targets appointments with a recurringScheduleId
 *
 * Expected signature:
 *   skipRecurringInstance(clientId: number, scheduleId: number, fromDate: string, weeks?: number):
 *     Promise<{ success: boolean; skipped: number; error?: string }>
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
  todayLocal: () => "2026-04-12",
  formatLocalTimeShort: (iso: string) => iso,
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

// TODO: update import once skipRecurringInstance is implemented
const { skipRecurringInstance } = await import("../services/scheduling.js");

describe("skip_recurring_instance", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);

    // Create a recurring schedule for Sarah (client 1): Monday 10am
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    // Generate 4 weeks of recurring appointments (Mon 2026-04-13, 04-20, 04-27, 05-04)
    const mondays = ["2026-04-13", "2026-04-20", "2026-04-27", "2026-05-04"];
    for (const date of mondays) {
      testDb.db.insert(schema.appointments).values({
        clientId: 1,
        startTime: `${date}T10:00:00.000Z`,
        endTime: `${date}T11:00:00.000Z`,
        status: "confirmed",
        recurringScheduleId: 1,
      }).run();
    }
  });

  // --- Skip 1 week (default) ---

  it("cancels the next recurring appointment for the given date", async () => {
    const result = await skipRecurringInstance(1, 1, "2026-04-13");
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(1);

    const appts = testDb.db.select().from(schema.appointments)
      .where(and(eq(schema.appointments.clientId, 1), eq(schema.appointments.recurringScheduleId, 1)))
      .all();

    const cancelled = appts.filter(a => a.status === "cancelled");
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].startTime).toContain("2026-04-13");

    // Other weeks untouched
    const confirmed = appts.filter(a => a.status === "confirmed");
    expect(confirmed.length).toBe(3);
  });

  // --- Skip multiple weeks ---

  it("skips 4 weeks when weeks=4", async () => {
    const result = await skipRecurringInstance(1, 1, "2026-04-13", 4);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(4);

    const appts = testDb.db.select().from(schema.appointments)
      .where(and(eq(schema.appointments.clientId, 1), eq(schema.appointments.recurringScheduleId, 1)))
      .all();

    const cancelled = appts.filter(a => a.status === "cancelled");
    expect(cancelled.length).toBe(4);
  });

  it("skips 2 weeks starting from a mid-range date", async () => {
    const result = await skipRecurringInstance(1, 1, "2026-04-20", 2);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(2);

    const appts = testDb.db.select().from(schema.appointments)
      .where(and(eq(schema.appointments.clientId, 1), eq(schema.appointments.recurringScheduleId, 1)))
      .all();

    // 04-13 should still be confirmed
    const first = appts.find(a => a.startTime.includes("2026-04-13"));
    expect(first?.status).toBe("confirmed");

    // 04-20 and 04-27 should be cancelled
    const cancelled = appts.filter(a => a.status === "cancelled");
    expect(cancelled.length).toBe(2);
  });

  // --- No session deduction ---

  it("does NOT change session balance", async () => {
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await skipRecurringInstance(1, 1, "2026-04-13", 2);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("does NOT create any ledger entries", async () => {
    const ledgerBefore = testDb.db.select().from(schema.sessionLedger).all();
    await skipRecurringInstance(1, 1, "2026-04-13", 2);
    const ledgerAfter = testDb.db.select().from(schema.sessionLedger).all();

    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });

  // --- Recurring rule stays active ---

  it("does NOT modify the recurring schedule rule", async () => {
    const before = testDb.db.select().from(schema.recurringSchedules).where(eq(schema.recurringSchedules.id, 1)).get()!;
    await skipRecurringInstance(1, 1, "2026-04-13", 2);
    const after = testDb.db.select().from(schema.recurringSchedules).where(eq(schema.recurringSchedules.id, 1)).get()!;

    expect(after.active).toBe(before.active);
    expect(after.dayOfWeek).toBe(before.dayOfWeek);
    expect(after.startTime).toBe(before.startTime);
  });

  // --- Only targets recurring appointments ---

  it("does NOT cancel non-recurring appointments on the same date", async () => {
    // Add a one-off appointment on the same day
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T14:00:00.000Z", endTime: "2026-04-13T15:00:00.000Z",
      status: "confirmed", recurringScheduleId: null,
    }).run();

    await skipRecurringInstance(1, 1, "2026-04-13");

    // The one-off should be untouched
    const oneOff = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.recurringScheduleId, null as unknown as number))
      .all()
      .filter(a => a.startTime.includes("2026-04-13") && a.recurringScheduleId === null);

    // All non-recurring appointments should still be confirmed
    for (const a of oneOff) {
      expect(a.status).toBe("confirmed");
    }
  });

  // --- Edge cases ---

  it("returns error if no recurring appointments found from given date", async () => {
    const result = await skipRecurringInstance(1, 1, "2027-01-01"); // way in the future
    expect(result.success).toBe(false);
  });

  it("returns error for nonexistent client", async () => {
    const result = await skipRecurringInstance(999, 1, "2026-04-13");
    expect(result.success).toBe(false);
  });

  it("returns error for nonexistent schedule", async () => {
    const result = await skipRecurringInstance(1, 999, "2026-04-13");
    expect(result.success).toBe(false);
  });

  it("skips fewer than requested if not enough future appointments exist", async () => {
    // Only 4 appointments exist, try to skip 10
    const result = await skipRecurringInstance(1, 1, "2026-04-13", 10);
    expect(result.success).toBe(true);
    expect(result.skipped).toBeLessThanOrEqual(4);
  });
});
