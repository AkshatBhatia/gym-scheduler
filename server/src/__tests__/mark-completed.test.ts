import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

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

const { completeAppointment } = await import("../services/scheduling.js");

describe("mark_completed", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  // --- Happy path ---

  it("sets status to 'completed' for a confirmed appointment", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const result = await completeAppointment(1);
    expect(result.success).toBe(true);

    const appt = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
    expect(appt?.status).toBe("completed");
  });

  it("deducts 1 session from client balance", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await completeAppointment(1);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) - 1);
  });

  it("creates a session_ledger entry with changeAmount -1", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    await completeAppointment(1);

    const ledger = testDb.db.select().from(schema.sessionLedger).where(eq(schema.sessionLedger.clientId, 1)).all();
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    const entry = ledger[ledger.length - 1];
    expect(entry.changeAmount).toBe(-1);
    expect(entry.appointmentId).toBe(1);
    expect(entry.reason).toContain("completed");
  });

  // --- Balance goes negative ---

  it("allows completion when balance is 0 (goes to -1)", async () => {
    // Set Sarah's balance to 0
    testDb.db.update(schema.clients).set({ sessionsRemaining: 0 }).where(eq(schema.clients.id, 1)).run();
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const result = await completeAppointment(1);
    expect(result.success).toBe(true);

    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    // Per spec: balance can go negative (owes sessions)
    expect(after.sessionsRemaining).toBeLessThanOrEqual(0);
  });

  // --- Rejection cases ---

  it("rejects if appointment is already completed", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "completed",
    }).run();

    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects if appointment is cancelled", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "cancelled",
    }).run();

    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
  });

  it("rejects if appointment is already marked no-show", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "no-show",
    }).run();

    const result = await completeAppointment(1);
    expect(result.success).toBe(false);
  });

  it("rejects if appointment does not exist", async () => {
    const result = await completeAppointment(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // --- Idempotency / no double-deduction ---

  it("does not deduct session twice if called twice on same appointment", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();

    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await completeAppointment(1);
    await completeAppointment(1); // second call should fail
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    // Only 1 deduction, not 2
    expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) - 1);
  });
});
