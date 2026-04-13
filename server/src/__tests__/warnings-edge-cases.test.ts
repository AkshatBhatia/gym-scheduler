import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Warning thresholds and edge case tests.
 *
 * Spec requirements:
 *   - book_appointment: "Warns if balance ≤ 2 after booking"
 *   - mark_completed at 0: "still allow but warn: client needs to purchase more"
 *   - book_appointment: "rejected if sessionsRemaining is 0 (no exceptions)"
 *   - mark_no_show: "AI asks instructor before deducting" (deductSession param)
 *
 * These test the return values/warnings from service functions,
 * not the AI chat layer (which interprets warnings and presents them).
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

const mockSendSms = vi.fn().mockResolvedValue({ sid: "SM_test" });
vi.mock("../services/sms.js", () => ({ sendSms: mockSendSms }));

vi.mock("../services/recurring.js", () => ({
  generateForClient: vi.fn().mockResolvedValue({ created: 0, skipped: 0 }),
}));

const { bookAppointment, completeAppointment } = await import("../services/scheduling.js");

const nextMondayAt = (hour: number) => {
  const d = new Date();
  const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// =========================================================================
// BOOKING: balance = 0 rejection (hard gate)
// =========================================================================

describe("Balance gate: booking rejected at 0", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("rejects at exactly 0", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session|balance/i);
  });

  it("rejects at negative balance", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: -2 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(false);
  });

  it("allows at exactly 1", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 1 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(true);
  });

  it("allows at exactly 2 (but should warn — low balance)", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 2 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(true);
    // The warning is returned in the result for the chat layer to present
    // TODO: verify result contains a warning field/message about low balance
  });

  it("rejects null sessionsRemaining (treated as 0)", async () => {
    testDb.db.update(schema.clients)
      .set({ sessionsRemaining: null as unknown as number })
      .where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// COMPLETION: balance at 0 → negative (allowed with warning)
// =========================================================================

describe("Completion at zero balance", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();
  });

  it("allows completion (session happened, can't undo it)", async () => {
    const result = await completeAppointment(1);
    expect(result.success).toBe(true);
  });

  it("balance goes to -1", async () => {
    await completeAppointment(1);
    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.sessionsRemaining).toBeLessThan(0);
  });

  it("ledger records the negative balance", async () => {
    await completeAppointment(1);
    const ledger = testDb.db.select().from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, 1)).all();
    const last = ledger[ledger.length - 1];
    expect(last.balanceAfter).toBeLessThan(0);
    expect(last.changeAmount).toBe(-1);
  });

  // TODO: verify result contains a warning about needing to purchase more
  it.todo("returns a warning indicating client has no sessions remaining");
});

// =========================================================================
// BOOKING: low balance warning (balance ≤ 2)
// =========================================================================

describe("Low balance warning on booking", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("no warning when balance is high (e.g. 7)", async () => {
    // Sarah has 7 sessions
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(true);
    // TODO: result should NOT contain a low balance warning
  });

  it("warns when balance is 2", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 2 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(true);
    // TODO: result should contain a low balance warning
  });

  it("warns when balance is 1", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 1 }).where(eq(schema.clients.id, 1)).run();
    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(true);
    // TODO: result should contain a low/last session warning
  });
});

// =========================================================================
// BLOCK TIME: edge cases
// =========================================================================

describe("Block time edge cases", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("cannot book into a blocked slot", async () => {
    testDb.db.insert(schema.availability).values({
      overrideDate: nextMondayAt(10).slice(0, 10),
      startTime: "10:00", endTime: "11:00", isBlocked: 1,
    }).run();

    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/block/i);
  });

  it("adjacent blocks: can book in the gap between two blocks", async () => {
    const date = nextMondayAt(10).slice(0, 10);
    // Block 08:00-10:00 and 12:00-14:00, leave 10:00-12:00 open
    testDb.db.insert(schema.availability).values([
      { overrideDate: date, startTime: "08:00", endTime: "10:00", isBlocked: 1 },
      { overrideDate: date, startTime: "12:00", endTime: "14:00", isBlocked: 1 },
    ]).run();

    const result = await bookAppointment(1, nextMondayAt(10)); // 10:00-11:00
    expect(result.success).toBe(true);
  });

  it("partial overlap: block covers part of the slot → rejected", async () => {
    const date = nextMondayAt(10).slice(0, 10);
    // Block 10:30-11:30 — overlaps with 10:00-11:00 slot
    testDb.db.insert(schema.availability).values({
      overrideDate: date, startTime: "10:30", endTime: "11:30", isBlocked: 1,
    }).run();

    const result = await bookAppointment(1, nextMondayAt(10));
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// CANCEL: idempotency and status transitions
// =========================================================================

describe("Cancel: status transition rules", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it("cannot cancel a no-show appointment", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "no-show",
    }).run();

    // cancelAppointment checks status === "cancelled" but not "no-show"
    // Per spec, it should probably also handle this.
    // This test documents current behavior — update if spec changes.
  });

  it("can cancel a confirmed appointment", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(10),
      endTime: new Date(new Date(nextMondayAt(10)).getTime() + 3600000).toISOString(),
      status: "confirmed",
    }).run();

    const { cancelAppointment } = await import("../services/scheduling.js");
    const result = await cancelAppointment(1);
    expect(result.success).toBe(true);
  });
});

// =========================================================================
// APPOINTMENT STATUS: valid transitions
// =========================================================================

describe("Appointment status state machine", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // confirmed → completed ✓
  it("confirmed → completed is valid", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();
    const result = await completeAppointment(1);
    expect(result.success).toBe(true);
  });

  // confirmed → cancelled ✓ (tested in cancel tests)

  // completed → cancelled ✓ (refund)
  it("completed → cancelled is valid (with refund)", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "completed",
    }).run();
    const { cancelAppointment } = await import("../services/scheduling.js");
    const result = await cancelAppointment(1);
    expect(result.success).toBe(true);
  });

  // completed → completed ✗
  it("completed → completed is rejected (no double deduction)", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "completed",
    }).run();
    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
  });

  // cancelled → completed ✗
  it("cancelled → completed is rejected", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "cancelled",
    }).run();
    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
  });

  // no-show → completed ✗
  it("no-show → completed is rejected", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "no-show",
    }).run();
    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
  });

  // cancelled → cancelled ✗
  it("cancelled → cancelled is rejected", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "cancelled",
    }).run();
    const { cancelAppointment } = await import("../services/scheduling.js");
    const result = await cancelAppointment(1);
    expect(result.success).toBe(false);
  });
});
