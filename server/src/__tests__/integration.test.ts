import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, gte } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Integration tests — multi-step workflows that exercise multiple tools
 * together to verify end-to-end correctness, data integrity, and
 * cross-cutting concerns (ledger consistency, cascading, etc.).
 *
 * These are NOT unit tests — each test touches multiple service functions
 * in sequence and asserts the cumulative system state.
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
vi.mock("../services/sms.js", () => ({
  sendSms: mockSendSms,
}));

const {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
} = await import("../services/scheduling.js");
const { decrementSession, addSessions } = await import("../services/sessions.js");

// Helper: next Monday at given hour
const nextMondayAt = (hour: number) => {
  const d = new Date();
  const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// Helper: count ledger entries for a client
const ledgerEntries = (clientId: number) =>
  testDb.db.select().from(schema.sessionLedger)
    .where(eq(schema.sessionLedger.clientId, clientId)).all();

// Helper: get client balance
const getBalance = (clientId: number) =>
  testDb.db.select().from(schema.clients)
    .where(eq(schema.clients.id, clientId)).get()!.sessionsRemaining ?? 0;

// =========================================================================
// WORKFLOW 1: Full appointment lifecycle
// book → complete → verify ledger → verify balance
// =========================================================================

describe("Workflow: book → complete → ledger audit", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("booking does not deduct, completion deducts, ledger is consistent", async () => {
    const initialBalance = getBalance(1); // Sarah: 7

    // Step 1: Book
    const booking = await bookAppointment(1, nextMondayAt(10));
    expect(booking.success).toBe(true);
    expect(getBalance(1)).toBe(initialBalance); // no change

    // Step 2: Complete
    const completion = await completeAppointment(booking.appointment!.id);
    expect(completion.success).toBe(true);
    expect(getBalance(1)).toBe(initialBalance - 1);

    // Step 3: Ledger audit
    const ledger = ledgerEntries(1);
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    const lastEntry = ledger[ledger.length - 1];
    expect(lastEntry.changeAmount).toBe(-1);
    expect(lastEntry.balanceAfter).toBe(initialBalance - 1);
    expect(lastEntry.appointmentId).toBe(booking.appointment!.id);
  });

  it("multiple completions maintain running ledger balance", async () => {
    const initialBalance = getBalance(1); // 7

    const b1 = await bookAppointment(1, nextMondayAt(8));
    const b2 = await bookAppointment(1, nextMondayAt(10));
    expect(b1.success).toBe(true);
    expect(b2.success).toBe(true);
    expect(getBalance(1)).toBe(initialBalance); // still no change

    await completeAppointment(b1.appointment!.id);
    expect(getBalance(1)).toBe(initialBalance - 1);

    await completeAppointment(b2.appointment!.id);
    expect(getBalance(1)).toBe(initialBalance - 2);

    // Ledger should have 2 entries, each with correct running balance
    const ledger = ledgerEntries(1);
    const completionEntries = ledger.filter(e => e.changeAmount === -1);
    expect(completionEntries.length).toBe(2);
    expect(completionEntries[0].balanceAfter).toBe(initialBalance - 1);
    expect(completionEntries[1].balanceAfter).toBe(initialBalance - 2);
  });
});

// =========================================================================
// WORKFLOW 2: Cancel after completion → refund
// book → complete → cancel → verify refund + ledger
// =========================================================================

describe("Workflow: book → complete → cancel → refund", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("cancelling a completed appointment refunds the session", async () => {
    const initialBalance = getBalance(1);

    const booking = await bookAppointment(1, nextMondayAt(10));
    await completeAppointment(booking.appointment!.id);
    expect(getBalance(1)).toBe(initialBalance - 1); // deducted

    await cancelAppointment(booking.appointment!.id);
    expect(getBalance(1)).toBe(initialBalance); // refunded

    // Ledger: -1 (completion) then +1 (refund)
    const ledger = ledgerEntries(1);
    const changes = ledger.map(e => e.changeAmount);
    expect(changes).toContain(-1);
    expect(changes).toContain(1);
  });

  it("cancelling a confirmed (not completed) appointment does NOT refund", async () => {
    const initialBalance = getBalance(1);

    const booking = await bookAppointment(1, nextMondayAt(10));
    await cancelAppointment(booking.appointment!.id);

    expect(getBalance(1)).toBe(initialBalance); // no change — wasn't completed
    const ledger = ledgerEntries(1);
    const refunds = ledger.filter(e => e.changeAmount === 1);
    expect(refunds.length).toBe(0);
  });
});

// =========================================================================
// WORKFLOW 3: Balance depletion → booking rejected
// book + complete until balance hits 0 → next booking rejected
// =========================================================================

describe("Workflow: deplete balance → booking rejected", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    // Set Emily (client 3) to 2 sessions
    testDb.db.update(schema.clients)
      .set({ sessionsRemaining: 2 })
      .where(eq(schema.clients.id, 3)).run();
  });

  it("allows bookings until balance hits 0, then rejects", async () => {
    // Book and complete session 1
    const b1 = await bookAppointment(3, nextMondayAt(8));
    expect(b1.success).toBe(true);
    await completeAppointment(b1.appointment!.id);
    expect(getBalance(3)).toBe(1);

    // Book and complete session 2
    const b2 = await bookAppointment(3, nextMondayAt(10));
    expect(b2.success).toBe(true);
    await completeAppointment(b2.appointment!.id);
    expect(getBalance(3)).toBe(0);

    // Session 3 — should be rejected (balance = 0)
    const b3 = await bookAppointment(3, nextMondayAt(12));
    expect(b3.success).toBe(false);
    expect(b3.error).toMatch(/session|balance/i);
  });

  it("adding sessions re-enables booking after depletion", async () => {
    // Deplete
    testDb.db.update(schema.clients)
      .set({ sessionsRemaining: 0 })
      .where(eq(schema.clients.id, 3)).run();

    const rejected = await bookAppointment(3, nextMondayAt(8));
    expect(rejected.success).toBe(false);

    // Add sessions
    await addSessions(3, 5, "Purchased 5-pack");
    expect(getBalance(3)).toBe(5);

    // Now booking works
    const accepted = await bookAppointment(3, nextMondayAt(8));
    expect(accepted.success).toBe(true);
  });
});

// =========================================================================
// WORKFLOW 4: Negative balance via mark_completed
// recurring client at 0 balance → complete → balance goes negative
// =========================================================================

describe("Workflow: completion at zero balance → negative balance", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    // Sarah at 0 balance with a recurring appointment already on calendar
    testDb.db.update(schema.clients)
      .set({ sessionsRemaining: 0 })
      .where(eq(schema.clients.id, 1)).run();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
      recurringScheduleId: 1,
    }).run();
  });

  it("allows completion and balance goes to -1", async () => {
    const result = await completeAppointment(1);
    expect(result.success).toBe(true);
    expect(getBalance(1)).toBeLessThan(0);

    const ledger = ledgerEntries(1);
    const last = ledger[ledger.length - 1];
    expect(last.changeAmount).toBe(-1);
    expect(last.balanceAfter).toBeLessThan(0);
  });

  it("balance recovers after adding sessions post-negative", async () => {
    await completeAppointment(1);
    expect(getBalance(1)).toBeLessThan(0);

    // Client purchases 10-pack
    await addSessions(1, 10, "Purchased 10-pack");
    // Should be -1 + 10 = 9
    expect(getBalance(1)).toBeGreaterThan(0);

    const ledger = ledgerEntries(1);
    const lastAdd = ledger.filter(e => e.changeAmount === 10);
    expect(lastAdd.length).toBe(1);
  });
});

// =========================================================================
// WORKFLOW 5: Double-booking prevention across tools
// =========================================================================

describe("Workflow: double-booking prevention", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("two clients cannot book the same slot", async () => {
    const time = nextMondayAt(10);

    const b1 = await bookAppointment(1, time); // Sarah
    expect(b1.success).toBe(true);

    const b2 = await bookAppointment(2, time); // Mike
    expect(b2.success).toBe(false);
    expect(b2.error).toMatch(/already booked|conflict/i);
  });

  it("cancelling frees the slot for another client", async () => {
    const time = nextMondayAt(10);

    const b1 = await bookAppointment(1, time);
    expect(b1.success).toBe(true);

    await cancelAppointment(b1.appointment!.id);

    const b2 = await bookAppointment(2, time);
    expect(b2.success).toBe(true);
  });

  it("completing does NOT free the slot (status is completed, not cancelled)", async () => {
    const time = nextMondayAt(10);

    const b1 = await bookAppointment(1, time);
    await completeAppointment(b1.appointment!.id);

    // Slot should still be occupied (completed appointment blocks it)
    const b2 = await bookAppointment(2, time);
    expect(b2.success).toBe(false);
  });
});

// =========================================================================
// WORKFLOW 6: Block time with existing appointments
// book → block that time → verify cascade
// =========================================================================

describe("Workflow: book → block → cascade cancellation", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: requires cascading logic on block_time
  it.todo("blocking a time cancels overlapping confirmed appointments");
  it.todo("blocking a time does NOT cancel completed appointments");
  it.todo("blocking a time sends SMS to each affected client");
  it.todo("blocking a time does NOT deduct sessions from cancelled appointments");
  it.todo("after blocking, the slot is no longer bookable");
});

// =========================================================================
// WORKFLOW 7: Deactivate client → recurring + appointments
// =========================================================================

describe("Workflow: deactivate client cleans up recurring", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    // Give Sarah a recurring schedule and future appointment
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T09:00:00.000Z",
      endTime: "2026-04-13T10:00:00.000Z", status: "confirmed",
      recurringScheduleId: 1,
    }).run();
  });

  it("deactivating client pauses their recurring schedules", async () => {
    // Deactivate Sarah
    testDb.db.update(schema.clients)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(schema.clients.id, 1)).run();
    testDb.db.update(schema.recurringSchedules)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(schema.recurringSchedules.clientId, 1)).run();

    const schedule = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.clientId, 1)).get()!;
    expect(schedule.active).toBe(0);
  });

  it("deactivated client cannot book new appointments", async () => {
    testDb.db.update(schema.clients)
      .set({ active: 0 })
      .where(eq(schema.clients.id, 1)).run();

    const result = await bookAppointment(1, nextMondayAt(14));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inactive/i);
  });

  it("session balance is preserved after deactivation", async () => {
    const balanceBefore = getBalance(1);
    testDb.db.update(schema.clients)
      .set({ active: 0 })
      .where(eq(schema.clients.id, 1)).run();

    const client = testDb.db.select().from(schema.clients)
      .where(eq(schema.clients.id, 1)).get()!;
    expect(client.sessionsRemaining).toBe(balanceBefore);
  });
});

// =========================================================================
// WORKFLOW 8: Ledger integrity audit
// Multiple operations → verify ledger running balance is always correct
// =========================================================================

describe("Workflow: ledger integrity across mixed operations", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("ledger running balance matches client balance after mixed operations", async () => {
    const clientId = 1;
    const initialBalance = getBalance(clientId); // 7

    // Add 5 sessions
    await addSessions(clientId, 5, "Purchased 5-pack");
    // Balance: 12

    // Book and complete 2 appointments
    const b1 = await bookAppointment(clientId, nextMondayAt(8));
    const b2 = await bookAppointment(clientId, nextMondayAt(10));
    await completeAppointment(b1.appointment!.id);
    await completeAppointment(b2.appointment!.id);
    // Balance: 10

    // Cancel a completed appointment (refund)
    await cancelAppointment(b1.appointment!.id);
    // Balance: 11

    // Final check: ledger's last balanceAfter matches actual client balance
    const finalBalance = getBalance(clientId);
    const ledger = ledgerEntries(clientId);
    const lastEntry = ledger[ledger.length - 1];

    expect(finalBalance).toBe(initialBalance + 5 - 2 + 1); // 7 + 5 - 2 + 1 = 11
    expect(lastEntry.balanceAfter).toBe(finalBalance);
  });

  it("each ledger entry's balanceAfter equals previous + changeAmount", async () => {
    const clientId = 3; // Emily, 4 sessions

    await addSessions(clientId, 3, "Added");
    const b1 = await bookAppointment(clientId, nextMondayAt(8));
    await completeAppointment(b1.appointment!.id);

    const ledger = ledgerEntries(clientId);
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i].balanceAfter).toBe(
        ledger[i - 1].balanceAfter + ledger[i].changeAmount
      );
    }
  });
});

// =========================================================================
// WORKFLOW 9: Availability boundary — booking at edge of window
// =========================================================================

describe("Workflow: availability boundary conditions", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("allows booking at exact start of availability window", async () => {
    // Seed has Mon-Sat 06:00-18:00
    const result = await bookAppointment(1, nextMondayAt(6));
    expect(result.success).toBe(true);
  });

  it("allows booking at last valid slot (17:00 for 1hr in 06:00-18:00 window)", async () => {
    const result = await bookAppointment(1, nextMondayAt(17));
    expect(result.success).toBe(true);
  });

  it("rejects booking that would end after availability window", async () => {
    // 18:00 start → 19:00 end, but availability ends at 18:00
    const result = await bookAppointment(1, nextMondayAt(18));
    expect(result.success).toBe(false);
  });

  it("rejects booking before availability window starts", async () => {
    const result = await bookAppointment(1, nextMondayAt(5));
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// WORKFLOW 10: Reschedule preserves data integrity
// TODO: uncomment when rescheduleAppointment is implemented
// =========================================================================

describe("Workflow: reschedule end-to-end", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("reschedule → complete new appointment → correct ledger entry");
  it.todo("reschedule recurring → skip old + book new → recurring rule unchanged");
  it.todo("failed reschedule leaves system in exact original state");
  it.todo("reschedule to same time is a no-op (or error)");
});

// =========================================================================
// WORKFLOW 11: Skip recurring → one-off reschedule pattern
// skip_recurring_instance(Tue) + book_appointment(Thu) = one-off move
// =========================================================================

describe("Workflow: skip + rebook (one-off recurring reschedule)", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("skip Tuesday + book Thursday = same session count, different day");
  it.todo("skip does not deduct, book does not deduct, complete deducts once");
  it.todo("recurring rule still generates next Tuesday as normal");
});

// =========================================================================
// WORKFLOW 12: Session purchase → recurring regeneration
// =========================================================================

describe("Workflow: add sessions triggers recurring regeneration", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("adding sessions to a client with active recurring triggers regeneration");
  it.todo("regenerated appointments respect availability and conflicts");
  it.todo("regenerated appointments have recurringScheduleId set");
});
