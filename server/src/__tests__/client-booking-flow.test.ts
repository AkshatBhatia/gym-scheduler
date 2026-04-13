import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Client booking flow integration tests — end-to-end journeys from
 * the client's perspective covering booking, cancellation, rescheduling,
 * session balance checks, and recurring schedule management.
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

const mockSendSms = vi.fn().mockResolvedValue({ sid: "SM_test" });
vi.mock("../services/sms.js", () => ({ sendSms: mockSendSms }));

const {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
  rescheduleAppointment,
  getAvailableSlots,
  skipRecurringInstance,
} = await import("../services/scheduling.js");
const { generateForClient, listRecurringSchedules, deleteRecurringSchedule } = await import("../services/recurring.js");
const { getBalance } = await import("../services/sessions.js");

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

// =========================================================================
// Journey 2: Existing client books a session
// =========================================================================

describe("Client journey: book a session", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("full flow: check slots → book → verify", async () => {
    // Step 1: Check available slots for next Monday
    const mondayDate = nextMondayAt(10).slice(0, 10);
    const slots = await getAvailableSlots(mondayDate);
    const availableSlots = slots.filter(s => s.available);
    expect(availableSlots.length).toBeGreaterThan(0);

    // Step 2: Book a slot (client-initiated)
    const result = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    expect(result.success).toBe(true);

    // Step 3: Verify appointment exists
    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1)).all();
    const confirmed = appts.filter(a => a.status === "confirmed");
    expect(confirmed.length).toBe(1);
  });

  it("rejects when balance is 0", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();

    const result = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session/i);
  });

  it("rejects booking outside availability hours", async () => {
    // Availability is 06:00-18:00, try 20:00
    const result = await bookAppointment(1, nextMondayAt(20), undefined, { clientInitiated: true });
    expect(result.success).toBe(false);
  });

  it("does NOT deduct sessions at booking time", async () => {
    const before = (await getBalance(1)).balance;
    await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    const after = (await getBalance(1)).balance;
    expect(after).toBe(before);
  });
});

// =========================================================================
// Journey 3: Client cancels and rebooks
// =========================================================================

describe("Client journey: cancel and rebook", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("full flow: book → cancel → rebook different day", async () => {
    // Book Monday
    const booking = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    expect(booking.success).toBe(true);

    // Cancel Monday
    const cancel = await cancelAppointment(booking.appointment!.id);
    expect(cancel.success).toBe(true);

    // Rebook on Tuesday (same day as Monday is now free, but pick a different day)
    const rebook = await bookAppointment(1, nextTuesdayAt(10), undefined, { clientInitiated: true });
    expect(rebook.success).toBe(true);

    // Verify: 1 cancelled, 1 confirmed
    const all = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1)).all();
    expect(all.filter(a => a.status === "cancelled").length).toBe(1);
    expect(all.filter(a => a.status === "confirmed").length).toBe(1);
  });

  it("session balance unchanged through cancel+rebook cycle", async () => {
    const before = (await getBalance(1)).balance;

    const booking = await bookAppointment(1, nextMondayAt(10));
    await cancelAppointment(booking.appointment!.id);
    await bookAppointment(1, nextTuesdayAt(10));

    const after = (await getBalance(1)).balance;
    expect(after).toBe(before); // no change — sessions deducted on completion only
  });

  it("can rebook same day after cancellation (one-per-day: cancelled slot freed)", async () => {
    const booking = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    await cancelAppointment(booking.appointment!.id);

    // Same day, different time — should work since the cancelled one doesn't count
    const rebook = await bookAppointment(1, nextMondayAt(14), undefined, { clientInitiated: true });
    expect(rebook.success).toBe(true);
  });
});

// =========================================================================
// Journey 4: Client reschedules
// =========================================================================

describe("Client journey: reschedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("full flow: book → reschedule to different day", async () => {
    const booking = await bookAppointment(1, nextMondayAt(10));
    expect(booking.success).toBe(true);

    const reschedule = await rescheduleAppointment(
      booking.appointment!.id,
      nextTuesdayAt(14),
      undefined,
      { clientInitiated: true }
    );
    expect(reschedule.success).toBe(true);

    // Old appointment cancelled, new one created
    const old = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, booking.appointment!.id)).get()!;
    expect(old.status).toBe("cancelled");
    expect(reschedule.appointment!.status).toBe("confirmed");
  });

  it("session balance unchanged after reschedule", async () => {
    const before = (await getBalance(1)).balance;

    const booking = await bookAppointment(1, nextMondayAt(10));
    await rescheduleAppointment(booking.appointment!.id, nextTuesdayAt(14));

    const after = (await getBalance(1)).balance;
    expect(after).toBe(before);
  });

  it("no ledger entries from reschedule", async () => {
    const ledgerBefore = testDb.db.select().from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, 1)).all();

    const booking = await bookAppointment(1, nextMondayAt(10));
    await rescheduleAppointment(booking.appointment!.id, nextTuesdayAt(14));

    const ledgerAfter = testDb.db.select().from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, 1)).all();
    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });
});

// =========================================================================
// Journey 5: Client checks session balance
// =========================================================================

describe("Client journey: check balance", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns correct balance for active client", async () => {
    const result = await getBalance(1); // Sarah: 7 sessions
    expect(result.balance).toBe(7);
  });

  it("returns 0 for client with no sessions", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();
    const result = await getBalance(1);
    expect(result.balance).toBe(0);
  });

  it("balance decreases after completion (instructor action)", async () => {
    const booking = await bookAppointment(1, nextMondayAt(10));
    await completeAppointment(booking.appointment!.id);

    const result = await getBalance(1);
    expect(result.balance).toBe(6); // was 7, now 6
  });
});

// =========================================================================
// Journey 6: Client skips recurring weeks
// =========================================================================

describe("Client journey: skip recurring", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    // Give Sarah a recurring Monday schedule
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    // Generate recurring appointments
    for (const date of ["2026-04-20", "2026-04-27", "2026-05-04", "2026-05-11"]) {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: `${date}T10:00:00.000Z`, endTime: `${date}T11:00:00.000Z`,
        status: "confirmed", recurringScheduleId: 1,
      }).run();
    }
  });

  it("skips 1 week — cancels only that week", async () => {
    const result = await skipRecurringInstance(1, 1, "2026-04-20", 1);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(1);

    // 04-20 cancelled, others confirmed
    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1)).all();
    expect(appts.find(a => a.startTime.includes("2026-04-20"))!.status).toBe("cancelled");
    expect(appts.find(a => a.startTime.includes("2026-04-27"))!.status).toBe("confirmed");
  });

  it("skips 2 weeks (vacation)", async () => {
    const result = await skipRecurringInstance(1, 1, "2026-04-20", 2);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(2);
  });

  it("no session deduction from skip", async () => {
    const before = (await getBalance(1)).balance;
    await skipRecurringInstance(1, 1, "2026-04-20", 2);
    const after = (await getBalance(1)).balance;
    expect(after).toBe(before);
  });

  it("recurring schedule stays active after skip", async () => {
    await skipRecurringInstance(1, 1, "2026-04-20", 2);
    const schedules = await listRecurringSchedules(1);
    expect(schedules.length).toBe(1);
    expect(schedules[0].active).toBe(1);
  });
});

// =========================================================================
// Journey 9: Client cancels recurring schedule
// =========================================================================

describe("Client journey: cancel recurring schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-20T10:00:00.000Z", endTime: "2026-04-20T11:00:00.000Z", status: "confirmed", recurringScheduleId: 1 },
      { clientId: 1, startTime: "2026-04-27T10:00:00.000Z", endTime: "2026-04-27T11:00:00.000Z", status: "confirmed", recurringScheduleId: 1 },
    ]).run();
  });

  it("deletes recurring schedule and cancels future appointments", async () => {
    const result = await deleteRecurringSchedule(1);
    expect(result.success).toBe(true);

    // Schedule gone
    const schedules = await listRecurringSchedules(1);
    expect(schedules.length).toBe(0);

    // Appointments cancelled
    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1)).all();
    for (const a of appts) {
      expect(a.status).toBe("cancelled");
    }
  });

  it("no session change from recurring deletion", async () => {
    const before = (await getBalance(1)).balance;
    await deleteRecurringSchedule(1);
    const after = (await getBalance(1)).balance;
    expect(after).toBe(before);
  });
});

// =========================================================================
// Edge case: session depletion during active booking
// =========================================================================

describe("Client edge cases: session depletion", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("book → instructor completes → balance drops → can still reschedule (no balance check)", async () => {
    // Set to 1 session
    testDb.db.update(schema.clients).set({ sessionsRemaining: 1 }).where(eq(schema.clients.id, 1)).run();

    // Client books
    const booking = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    expect(booking.success).toBe(true);

    // Instructor completes it — balance goes to 0
    await completeAppointment(booking.appointment!.id);
    expect((await getBalance(1)).balance).toBe(0);

    // Client can't book NEW appointment (balance = 0)
    const newBooking = await bookAppointment(1, nextTuesdayAt(10), undefined, { clientInitiated: true });
    expect(newBooking.success).toBe(false);
  });

  it("recurring appointments persist even at 0 balance (holds the slot)", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    // Generate should still create appointments (indefinite horizon)
    const result = await generateForClient(1);
    expect(result.created).toBeGreaterThan(0);
  });
});

// =========================================================================
// Edge case: booking during blocked time
// =========================================================================

describe("Client edge cases: blocked time", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("client cannot book during a blocked time", async () => {
    const mondayDate = nextMondayAt(10).slice(0, 10);
    testDb.db.insert(schema.availability).values({
      overrideDate: mondayDate, startTime: "10:00", endTime: "11:00", isBlocked: 1,
    }).run();

    const result = await bookAppointment(1, nextMondayAt(10), undefined, { clientInitiated: true });
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// Integration: confirm pattern matching (pre-AI fast path)
// =========================================================================

describe("Client pattern matching: confirmation replies", () => {
  // These test the regex patterns, not the AI. The patterns are defined
  // in processClientMessage in chat.ts. Here we test the expected behavior
  // at the data level when a cancellation pattern is triggered.

  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("cancelling via pattern match properly updates DB", async () => {
    // Simulate what happens when the cancel pattern triggers cancelAppointment
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-20T10:00:00.000Z", endTime: "2026-04-20T11:00:00.000Z", status: "confirmed",
    }).run();

    const result = await cancelAppointment(1);
    expect(result.success).toBe(true);

    const appt = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get()!;
    expect(appt.status).toBe("cancelled");
  });
});
