import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * reschedule_appointment — spec says:
 *   - Atomic: validate new slot first, only then cancel old + book new
 *   - If new slot is unavailable, old appointment stays untouched
 *   - Net zero session change: no deduction, no refund, no ledger entries
 *   - No balance check (session was already reserved)
 *   - Must carry over recurringScheduleId if original was recurring-generated
 *   - Conflict checks: no double-booking, within availability, not blocked
 *
 * Expected signature:
 *   rescheduleAppointment(appointmentId: number, newStartTime: string, notes?: string):
 *     Promise<{ success: boolean; appointment?: Appointment; error?: string }>
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
  todayLocal: () => new Date().toISOString().slice(0, 10),
  formatLocalTimeShort: (iso: string) => iso,
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

// TODO: update import once rescheduleAppointment is implemented
const { rescheduleAppointment, bookAppointment } = await import("../services/scheduling.js");

describe("reschedule_appointment", () => {
  // Helper: next Monday 10am UTC
  const nextMondayAt = (hour: number) => {
    const d = new Date();
    const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMon);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  // Helper: next Tuesday at hour
  const nextTuesdayAt = (hour: number) => {
    const d = new Date();
    const daysUntilTue = ((2 - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilTue);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  // --- Happy path ---

  it("moves appointment to new time slot", async () => {
    const oldTime = nextMondayAt(10);
    const newTime = nextMondayAt(14);

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const result = await rescheduleAppointment(1, newTime);
    expect(result.success).toBe(true);

    // Old appointment should be cancelled
    const old = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
    expect(old?.status).toBe("cancelled");

    // New appointment should exist and be confirmed
    expect(result.appointment).toBeDefined();
    expect(result.appointment!.status).toBe("confirmed");
    expect(result.appointment!.clientId).toBe(1);
  });

  // --- Session balance: net zero ---

  it("does NOT change session balance", async () => {
    const oldTime = nextMondayAt(10);
    const newTime = nextMondayAt(14);

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await rescheduleAppointment(1, newTime);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("does NOT create any session_ledger entries", async () => {
    const oldTime = nextMondayAt(10);
    const newTime = nextMondayAt(14);

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const ledgerBefore = testDb.db.select().from(schema.sessionLedger).all();
    await rescheduleAppointment(1, newTime);
    const ledgerAfter = testDb.db.select().from(schema.sessionLedger).all();

    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });

  // --- No balance check needed ---

  it("allows reschedule even when client has 0 sessions (session already reserved)", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();

    const oldTime = nextMondayAt(10);
    const newTime = nextMondayAt(14);

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const result = await rescheduleAppointment(1, newTime);
    expect(result.success).toBe(true);
  });

  // --- Atomic: fails if new slot is unavailable ---

  it("fails if new slot has a conflict (double-booking)", async () => {
    const oldTime = nextMondayAt(10);
    const conflictTime = nextMondayAt(14);

    // Book existing appointment at the conflict time
    testDb.db.insert(schema.appointments).values({
      clientId: 2, startTime: conflictTime, endTime: new Date(new Date(conflictTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    // Book the appointment to reschedule
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const result = await rescheduleAppointment(2, conflictTime);
    expect(result.success).toBe(false);

    // Original appointment should be UNTOUCHED
    const original = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 2)).get();
    expect(original?.status).toBe("confirmed");
    expect(original?.startTime).toBe(oldTime);
  });

  it("fails if new slot is blocked", async () => {
    const oldTime = nextMondayAt(10);
    const blockedTime = nextMondayAt(14);
    const blockedDate = blockedTime.slice(0, 10);

    // Block the target time
    testDb.db.insert(schema.availability).values({
      overrideDate: blockedDate, startTime: "14:00", endTime: "15:00", isBlocked: 1,
    }).run();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    const result = await rescheduleAppointment(1, blockedTime);
    expect(result.success).toBe(false);

    // Original stays untouched
    const original = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
    expect(original?.status).toBe("confirmed");
  });

  it("fails if new slot is outside availability hours", async () => {
    const oldTime = nextMondayAt(10);

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(), status: "confirmed",
    }).run();

    // Use a time outside availability hours (seed has 06:00-18:00)
    // 20:00 UTC on Monday = outside the availability window
    const d = new Date();
    const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMon);
    d.setUTCHours(20, 0, 0, 0); // 8pm — outside 06:00-18:00 availability
    const outsideHoursTime = d.toISOString();

    const result = await rescheduleAppointment(1, outsideHoursTime);
    expect(result.success).toBe(false);

    // Original stays untouched
    const original = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
    expect(original?.status).toBe("confirmed");
  });

  // --- Carries over recurringScheduleId ---

  it("preserves recurringScheduleId on the new appointment", async () => {
    const oldTime = nextMondayAt(10);
    const newTime = nextMondayAt(14);

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: oldTime, endTime: new Date(new Date(oldTime).getTime() + 3600000).toISOString(),
      status: "confirmed", recurringScheduleId: 1,
    }).run();

    const result = await rescheduleAppointment(1, newTime);
    expect(result.success).toBe(true);
    expect(result.appointment!.recurringScheduleId).toBe(1);
  });

  // --- Edge cases ---

  it("rejects if appointment does not exist", async () => {
    const result = await rescheduleAppointment(999, nextMondayAt(10));
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects if appointment is already cancelled", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(10),
      endTime: new Date(new Date(nextMondayAt(10)).getTime() + 3600000).toISOString(),
      status: "cancelled",
    }).run();

    const result = await rescheduleAppointment(1, nextMondayAt(14));
    expect(result.success).toBe(false);
  });

  it("rejects if appointment is already completed", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(10),
      endTime: new Date(new Date(nextMondayAt(10)).getTime() + 3600000).toISOString(),
      status: "completed",
    }).run();

    const result = await rescheduleAppointment(1, nextMondayAt(14));
    expect(result.success).toBe(false);
  });
});
