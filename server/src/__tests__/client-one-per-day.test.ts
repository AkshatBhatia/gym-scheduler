import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * One appointment per day per client — enforced for client-initiated actions.
 *
 * Spec says:
 *   - book_appointment with clientInitiated=true rejects if same-day confirmed exists
 *   - reschedule_appointment with clientInitiated=true rejects if new date has confirmed (excl. self)
 *   - Instructor-initiated (no flag) can override this limit
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

const { bookAppointment, rescheduleAppointment } = await import("../services/scheduling.js");

const nextMondayAt = (hour: number) => {
  const d = new Date();
  const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const nextTuesdayAt = (hour: number) => {
  const d = new Date();
  const daysUntilTue = ((2 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilTue);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe("One appointment per day: book_appointment", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("client-initiated: rejects second booking on same day", async () => {
    const first = await bookAppointment(1, nextMondayAt(8), undefined, { clientInitiated: true });
    expect(first.success).toBe(true);

    const second = await bookAppointment(1, nextMondayAt(14), undefined, { clientInitiated: true });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already have an appointment/i);
  });

  it("client-initiated: allows booking on a different day", async () => {
    const monday = await bookAppointment(1, nextMondayAt(8), undefined, { clientInitiated: true });
    expect(monday.success).toBe(true);

    const tuesday = await bookAppointment(1, nextTuesdayAt(8), undefined, { clientInitiated: true });
    expect(tuesday.success).toBe(true);
  });

  it("client-initiated: cancelled appointment does NOT block the day", async () => {
    // Book and cancel
    const first = await bookAppointment(1, nextMondayAt(8), undefined, { clientInitiated: true });
    expect(first.success).toBe(true);

    testDb.db.update(schema.appointments)
      .set({ status: "cancelled" })
      .where(eq(schema.appointments.id, first.appointment!.id))
      .run();

    // Should allow a new booking on the same day
    const second = await bookAppointment(1, nextMondayAt(14), undefined, { clientInitiated: true });
    expect(second.success).toBe(true);
  });

  it("client-initiated: completed appointment DOES block the day", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(8),
      endTime: new Date(new Date(nextMondayAt(8)).getTime() + 3600000).toISOString(),
      status: "confirmed",
    }).run();

    const second = await bookAppointment(1, nextMondayAt(14), undefined, { clientInitiated: true });
    expect(second.success).toBe(false);
  });

  it("instructor-initiated: ALLOWS second booking on same day (override)", async () => {
    const first = await bookAppointment(1, nextMondayAt(8));
    expect(first.success).toBe(true);

    // No clientInitiated flag = instructor override
    const second = await bookAppointment(1, nextMondayAt(14));
    expect(second.success).toBe(true);
  });

  it("different clients CAN book same day (limit is per-client)", async () => {
    const sarah = await bookAppointment(1, nextMondayAt(8), undefined, { clientInitiated: true });
    expect(sarah.success).toBe(true);

    const mike = await bookAppointment(2, nextMondayAt(14), undefined, { clientInitiated: true });
    expect(mike.success).toBe(true);
  });
});

describe("One appointment per day: reschedule_appointment", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("client-initiated: rejects reschedule to a day with existing appointment", async () => {
    // Book Monday and Tuesday
    const mon = await bookAppointment(1, nextMondayAt(8));
    const tue = await bookAppointment(1, nextTuesdayAt(8));
    expect(mon.success).toBe(true);
    expect(tue.success).toBe(true);

    // Client tries to reschedule Monday appointment to Tuesday (already has one)
    const result = await rescheduleAppointment(
      mon.appointment!.id,
      nextTuesdayAt(14),
      undefined,
      { clientInitiated: true }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already have an appointment/i);

    // Original appointment should be untouched (atomic)
    const original = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, mon.appointment!.id)).get()!;
    expect(original.status).toBe("confirmed");
  });

  it("client-initiated: allows reschedule to a free day", async () => {
    const mon = await bookAppointment(1, nextMondayAt(8));
    expect(mon.success).toBe(true);

    const result = await rescheduleAppointment(
      mon.appointment!.id,
      nextTuesdayAt(14),
      undefined,
      { clientInitiated: true }
    );
    expect(result.success).toBe(true);
  });

  it("client-initiated: allows reschedule within same day (different time)", async () => {
    const mon = await bookAppointment(1, nextMondayAt(8));
    expect(mon.success).toBe(true);

    // Reschedule to same day, different time — should work since the
    // check excludes the appointment being rescheduled
    const result = await rescheduleAppointment(
      mon.appointment!.id,
      nextMondayAt(14),
      undefined,
      { clientInitiated: true }
    );
    expect(result.success).toBe(true);
  });

  it("instructor-initiated: ALLOWS reschedule to a day with existing appointment", async () => {
    const mon = await bookAppointment(1, nextMondayAt(8));
    const tue = await bookAppointment(1, nextTuesdayAt(8));

    // No clientInitiated flag = instructor can override
    const result = await rescheduleAppointment(
      mon.appointment!.id,
      nextTuesdayAt(14)
    );
    expect(result.success).toBe(true);
  });
});
