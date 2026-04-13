import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * mark_no_show — spec says:
 *   - Sets status to 'no-show'
 *   - Default: no session deduction (deductSession=false)
 *   - Optional: deduct 1 session if instructor confirms (deductSession=true)
 *   - Only allowed on 'confirmed' appointments
 *   - Ledger entry only if session deducted
 *
 * NOTE: This service function does not exist yet. These tests define
 * the expected behavior for implementation. The function signature should be:
 *   markNoShow(appointmentId: number, deductSession?: boolean): Promise<{ success: boolean; error?: string }>
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

// TODO: update import path once markNoShow is implemented
const { markNoShow } = await import("../services/scheduling.js");

describe("mark_no_show", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  // --- Status change ---

  it("sets appointment status to 'no-show'", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const result = await markNoShow(1);
    expect(result.success).toBe(true);

    const appt = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
    expect(appt?.status).toBe("no-show");
  });

  // --- Default: no session deduction ---

  it("does NOT deduct a session by default", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await markNoShow(1); // default deductSession=false
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("does NOT create a ledger entry when deductSession is false", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const ledgerBefore = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();
    await markNoShow(1, false);
    const ledgerAfter = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();

    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });

  // --- Explicit deduction ---

  it("deducts 1 session when deductSession=true", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await markNoShow(1, true);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) - 1);
  });

  it("creates a ledger entry when deductSession=true", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    await markNoShow(1, true);

    const ledger = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    const entry = ledger[ledger.length - 1];
    expect(entry.changeAmount).toBe(-1);
    expect(entry.appointmentId).toBe(1);
    expect(entry.reason).toContain("no-show");
  });

  // --- Rejection cases ---

  it("rejects if appointment is already cancelled", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "cancelled",
    }).run();

    const result = await markNoShow(1);
    expect(result.success).toBe(false);
  });

  it("rejects if appointment is already completed", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "completed",
    }).run();

    const result = await markNoShow(1);
    expect(result.success).toBe(false);
  });

  it("rejects if appointment is already no-show", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "no-show",
    }).run();

    const result = await markNoShow(1);
    expect(result.success).toBe(false);
  });

  it("rejects if appointment does not exist", async () => {
    const result = await markNoShow(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // --- No double deduction ---

  it("cannot deduct twice by calling markNoShow twice", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await markNoShow(1, true);
    await markNoShow(1, true); // second call should fail (already no-show)
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) - 1);
  });
});
