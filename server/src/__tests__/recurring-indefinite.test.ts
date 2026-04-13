import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for the "generate indefinitely" recurring schedule behavior:
 *   - Recurring appointments are NOT limited by sessionsRemaining
 *   - They hold the calendar slot even when balance is 0
 *   - Generation uses a rolling horizon (e.g. 12 weeks)
 *   - Availability gate: rejects recurring schedules on days without availability
 *   - Multiple schedules distribute evenly via round-robin by date
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
  localDateTimeToUTC: (date: string, time: string) => `${date}T${time}:00.000Z`,
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

const { generateForClient } = await import("../services/recurring.js");

describe("recurring — generate indefinitely", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("generates appointments even when sessionsRemaining is 0", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    const result = await generateForClient(1);

    // Should still generate appointments to hold the slot
    expect(result.created).toBeGreaterThan(0);
  });

  it("generates up to the rolling horizon (at least 12 weeks)", async () => {
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    const result = await generateForClient(1);

    // 1 schedule × 12 weeks = at least 12 appointments
    expect(result.created).toBeGreaterThanOrEqual(12);
  });

  it("generates for multiple schedules on a rolling horizon", async () => {
    testDb.db.insert(schema.recurringSchedules).values([
      { clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1 },
      { clientId: 1, dayOfWeek: 3, startTime: "09:00", endTime: "10:00", active: 1 },
    ]).run();

    const result = await generateForClient(1);

    // 2 schedules × 12 weeks = at least 24
    expect(result.created).toBeGreaterThanOrEqual(24);
  });

  // --- Availability gate ---

  it("rejects creating a recurring schedule on a day with no availability", async () => {
    // Sunday (0) has no availability in seed data
    // This is tested at the service level when creating the schedule
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 0, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    const result = await generateForClient(1);

    // No appointments should be generated for a day with no availability
    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("rejects time outside availability window", async () => {
    // Availability is 06:00-18:00, schedule at 20:00
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "20:00", endTime: "21:00", active: 1,
    }).run();

    const result = await generateForClient(1);

    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  // --- Blocked dates skipped silently ---

  it("skips blocked dates but generates for other weeks", async () => {
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    // Block the first Monday
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-13", startTime: "08:00", endTime: "11:00", isBlocked: 1,
    }).run();

    const result = await generateForClient(1);

    // Should still generate for other weeks
    expect(result.created).toBeGreaterThan(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Verify no appointment on the blocked date
    const blocked = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1))
      .all()
      .filter(a => a.startTime.includes("2026-04-13"));
    expect(blocked.length).toBe(0);
  });

  // --- Double-booking check ---

  it("skips weeks where the slot is already booked by another client", async () => {
    // Another client has an appointment at the same time on the first Monday
    testDb.db.insert(schema.appointments).values({
      clientId: 2, startTime: "2026-04-13T09:00:00.000Z", endTime: "2026-04-13T10:00:00.000Z", status: "confirmed",
    }).run();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    const result = await generateForClient(1);

    // First Monday should be skipped
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Verify no double-booking
    const firstMondayAppts = testDb.db.select().from(schema.appointments)
      .all()
      .filter(a => a.startTime.includes("2026-04-13") && a.status === "confirmed");
    expect(firstMondayAppts.length).toBe(1); // only the existing one
  });

  // --- Inactive schedules ---

  it("does NOT generate for inactive schedules", async () => {
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 0,
    }).run();

    const result = await generateForClient(1);
    expect(result.created).toBe(0);
  });

  // --- Starts from next available date ---

  it("does NOT generate appointments for today or past dates", async () => {
    // Today is 2026-04-12 (Sunday). Monday schedule should start from 2026-04-13.
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    await generateForClient(1);

    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1))
      .all();

    for (const appt of appts) {
      expect(appt.startTime >= "2026-04-13").toBe(true);
    }
  });
});
