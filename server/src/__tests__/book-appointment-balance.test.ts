import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * book_appointment session balance checks — spec says:
 *   - Reject booking if sessionsRemaining == 0 (no exceptions)
 *   - No session deduction at booking time
 *   - Warn if balance ≤ 2 after booking
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

const { bookAppointment } = await import("../services/scheduling.js");

describe("book_appointment — session balance gate", () => {
  const futureMonday = () => {
    const d = new Date();
    const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMon);
    d.setUTCHours(10, 0, 0, 0);
    return d.toISOString();
  };

  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("rejects booking when sessionsRemaining is 0", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();

    const result = await bookAppointment(1, futureMonday());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session|balance/i);
  });

  it("rejects booking when sessionsRemaining is negative", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: -1 }).where(eq(schema.clients.id, 1)).run();

    const result = await bookAppointment(1, futureMonday());
    expect(result.success).toBe(false);
  });

  it("allows booking when sessionsRemaining is 1", async () => {
    testDb.db.update(schema.clients).set({ sessionsRemaining: 1 }).where(eq(schema.clients.id, 1)).run();

    const result = await bookAppointment(1, futureMonday());
    expect(result.success).toBe(true);
  });

  it("does NOT deduct session at booking time", async () => {
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await bookAppointment(1, futureMonday());
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("does NOT create a ledger entry on booking", async () => {
    const ledgerBefore = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();
    await bookAppointment(1, futureMonday());
    const ledgerAfter = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();

    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });
});
