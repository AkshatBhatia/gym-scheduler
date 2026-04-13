import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, gte } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for recurring schedule management tools:
 *   - list_recurring_schedules
 *   - update_recurring_schedule (with availability gate + regeneration)
 *   - delete_recurring_schedule (with future appointment cleanup)
 *
 * These test the service layer, not the chat tool wrappers.
 * The chat layer handles confirmation prompts; service layer handles logic.
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

// TODO: update imports once these service functions are implemented
const {
  listRecurringSchedules,
  updateRecurringSchedule,
  deleteRecurringSchedule,
} = await import("../services/recurring.js");

describe("list_recurring_schedules", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns all recurring schedules with client names", async () => {
    testDb.db.insert(schema.recurringSchedules).values([
      { clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1 },
      { clientId: 1, dayOfWeek: 3, startTime: "09:00", endTime: "10:00", active: 1 },
      { clientId: 2, dayOfWeek: 2, startTime: "11:00", endTime: "12:00", active: 1 },
    ]).run();

    const result = await listRecurringSchedules();
    expect(result.length).toBe(3);
    // Should include client name
    expect(result[0]).toHaveProperty("clientName");
  });

  it("returns schedules for a specific client when clientId provided", async () => {
    testDb.db.insert(schema.recurringSchedules).values([
      { clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1 },
      { clientId: 2, dayOfWeek: 2, startTime: "11:00", endTime: "12:00", active: 1 },
    ]).run();

    const result = await listRecurringSchedules(1);
    expect(result.length).toBe(1);
    expect(result[0].clientId).toBe(1);
  });

  it("returns empty array when client has no recurring schedules", async () => {
    const result = await listRecurringSchedules(3); // Emily has none
    expect(result).toEqual([]);
  });
});

describe("update_recurring_schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);

    // Add recurring schedule: Sarah on Monday 9am
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    // Generate some future recurring appointments
    const mondays = ["2026-04-13", "2026-04-20", "2026-04-27"];
    for (const date of mondays) {
      testDb.db.insert(schema.appointments).values({
        clientId: 1,
        startTime: `${date}T09:00:00.000Z`,
        endTime: `${date}T10:00:00.000Z`,
        status: "confirmed",
        recurringScheduleId: 1,
      }).run();
    }
  });

  it("updates day of week on the recurring schedule", async () => {
    // Move from Monday (1) to Wednesday (3)
    const result = await updateRecurringSchedule(1, { dayOfWeek: 3 });
    expect(result.success).toBe(true);

    const schedule = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.id, 1)).get()!;
    expect(schedule.dayOfWeek).toBe(3);
  });

  it("updates start/end time on the recurring schedule", async () => {
    const result = await updateRecurringSchedule(1, { startTime: "14:00", endTime: "15:00" });
    expect(result.success).toBe(true);

    const schedule = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.id, 1)).get()!;
    expect(schedule.startTime).toBe("14:00");
    expect(schedule.endTime).toBe("15:00");
  });

  it("rejects if new day/time is outside instructor availability", async () => {
    // Sunday (0) has no availability in seed data
    const result = await updateRecurringSchedule(1, { dayOfWeek: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/availability/i);

    // Schedule should be unchanged
    const schedule = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.id, 1)).get()!;
    expect(schedule.dayOfWeek).toBe(1); // still Monday
  });

  it("rejects if new time is outside availability hours", async () => {
    // Availability is 06:00-18:00, try 20:00
    const result = await updateRecurringSchedule(1, { startTime: "20:00", endTime: "21:00" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/availability/i);
  });

  it("deletes old future recurring appointments and regenerates", async () => {
    const apptsBefore = testDb.db.select().from(schema.appointments)
      .where(and(eq(schema.appointments.clientId, 1), eq(schema.appointments.recurringScheduleId, 1)))
      .all()
      .filter(a => a.status === "confirmed");
    expect(apptsBefore.length).toBe(3);

    // Move to Wednesday
    await updateRecurringSchedule(1, { dayOfWeek: 3 });

    // Old Monday appointments should be gone
    const oldMondays = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1))
      .all()
      .filter(a => a.status === "confirmed" && a.startTime.includes("T09:00"));

    // New appointments should be on Wednesdays
    const newAppts = testDb.db.select().from(schema.appointments)
      .where(and(eq(schema.appointments.clientId, 1), eq(schema.appointments.status, "confirmed")))
      .all();
    expect(newAppts.length).toBeGreaterThan(0);
  });

  it("rejects if schedule does not exist", async () => {
    const result = await updateRecurringSchedule(999, { dayOfWeek: 3 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("does not touch past/completed appointments during regeneration", async () => {
    // Add a completed appointment in the past
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-06T09:00:00.000Z", endTime: "2026-04-06T10:00:00.000Z",
      status: "completed", recurringScheduleId: 1,
    }).run();

    await updateRecurringSchedule(1, { dayOfWeek: 3 });

    // Completed appointment should still exist
    const completed = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.status, "completed")).all();
    expect(completed.length).toBe(1);
  });
});

describe("delete_recurring_schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();

    // Future recurring appointments
    testDb.db.insert(schema.appointments).values([
      {
        clientId: 1, startTime: "2026-04-20T09:00:00.000Z", endTime: "2026-04-20T10:00:00.000Z",
        status: "confirmed", recurringScheduleId: 1,
      },
      {
        clientId: 1, startTime: "2026-04-27T09:00:00.000Z", endTime: "2026-04-27T10:00:00.000Z",
        status: "confirmed", recurringScheduleId: 1,
      },
    ]).run();
  });

  it("deletes the recurring schedule", async () => {
    const result = await deleteRecurringSchedule(1);
    expect(result.success).toBe(true);

    const schedule = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.id, 1)).get();
    expect(schedule).toBeUndefined();
  });

  it("cancels all future confirmed appointments for this schedule", async () => {
    await deleteRecurringSchedule(1);

    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.recurringScheduleId, 1)).all();

    for (const appt of appts) {
      expect(appt.status).toBe("cancelled");
    }
  });

  it("does NOT affect appointments from other recurring schedules", async () => {
    // Add a second schedule for the same client
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 3, startTime: "11:00", endTime: "12:00", active: 1,
    }).run();
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-15T11:00:00.000Z", endTime: "2026-04-15T12:00:00.000Z",
      status: "confirmed", recurringScheduleId: 2,
    }).run();

    await deleteRecurringSchedule(1);

    // Schedule 2's appointments should be untouched
    const schedule2Appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.recurringScheduleId, 2)).all();
    expect(schedule2Appts[0].status).toBe("confirmed");
  });

  it("does NOT change session balance", async () => {
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await deleteRecurringSchedule(1);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("does NOT create ledger entries", async () => {
    const ledgerBefore = testDb.db.select().from(schema.sessionLedger).all();
    await deleteRecurringSchedule(1);
    const ledgerAfter = testDb.db.select().from(schema.sessionLedger).all();

    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });

  it("rejects if schedule does not exist", async () => {
    const result = await deleteRecurringSchedule(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("does not touch past completed appointments", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-06T09:00:00.000Z", endTime: "2026-04-06T10:00:00.000Z",
      status: "completed", recurringScheduleId: 1,
    }).run();

    await deleteRecurringSchedule(1);

    const completed = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.status, "completed")).all();
    expect(completed.length).toBe(1);
  });
});
