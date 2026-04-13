import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

// We need to mock the db module before importing services
let testDb: ReturnType<typeof createTestDb>;

vi.mock("../db/index.js", () => {
  return {
    get db() { return testDb.db; },
    get default() { return testDb.db; },
    get sqliteDb() { return testDb.sqlite; },
  };
});

// Mock timezone — treat all times as UTC (no conversion) for simplicity
vi.mock("../services/timezone.js", () => ({
  getTimezone: () => "UTC",
  localToUTC: (iso: string) => new Date(iso).toISOString(),
  utcToLocal: (iso: string) => iso.replace(/\.000Z$/, "").replace(/Z$/, ""),
  todayLocal: () => new Date().toISOString().slice(0, 10),
  formatLocalTimeShort: (iso: string) => iso,
  localDateTimeToUTC: (date: string, time: string) => new Date(`${date}T${time}:00Z`).toISOString(),
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

// Now import services (they'll use mocked db)
const { getAvailableSlots, bookAppointment, cancelAppointment, completeAppointment } = await import("../services/scheduling.js");

describe("Scheduling Service", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  describe("getAvailableSlots", () => {
    it("returns 12 slots for a Monday", async () => {
      const slots = await getAvailableSlots("2026-04-13"); // Monday
      expect(slots.length).toBe(12);
      expect(slots.every((s) => s.available)).toBe(true);
    });

    it("returns 0 slots for Sunday", async () => {
      const slots = await getAvailableSlots("2026-04-12"); // Sunday
      expect(slots.length).toBe(0);
    });

    it("excludes blocked time slots", async () => {
      testDb.db.insert(schema.availability).values({
        overrideDate: "2026-04-13", startTime: "10:00", endTime: "12:00", isBlocked: 1,
      }).run();
      const slots = await getAvailableSlots("2026-04-13");
      const available = slots.filter((s) => s.available);
      expect(available.length).toBe(10); // 12 - 2 blocked
    });

    it("marks booked slots as unavailable", async () => {
      // Book 10am on Monday (UTC time for 10am Pacific)
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "confirmed",
      }).run();
      const slots = await getAvailableSlots("2026-04-13");
      const unavail = slots.filter((s) => !s.available);
      expect(unavail.length).toBeGreaterThanOrEqual(1);
    });

    it("cancelled appointments don't affect availability", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "cancelled",
      }).run();
      const slots = await getAvailableSlots("2026-04-13");
      expect(slots.every((s) => s.available)).toBe(true);
    });
  });

  describe("bookAppointment", () => {
    const futureTime = () => {
      // Next Monday at 10am UTC (within Mon-Sat 6am-6pm window)
      const d = new Date();
      const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilMon);
      d.setUTCHours(10, 0, 0, 0);
      return d.toISOString();
    };

    it("creates a confirmed appointment", async () => {
      const result = await bookAppointment(1, futureTime());
      expect(result.success).toBe(true);
      expect(result.appointment?.status).toBe("confirmed");
    });

    it("rejects inactive client", async () => {
      const result = await bookAppointment(4, futureTime()); // Inactive Joe
      expect(result.success).toBe(false);
      expect(result.error).toContain("inactive");
    });

    it("rejects nonexistent client", async () => {
      const result = await bookAppointment(999, futureTime());
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects past dates", async () => {
      const past = new Date("2026-01-01T10:00:00.000Z").toISOString();
      const result = await bookAppointment(1, past);
      expect(result.success).toBe(false);
      expect(result.error).toContain("past");
    });

    it("rejects double booking", async () => {
      const time = futureTime();
      await bookAppointment(1, time);
      const result = await bookAppointment(2, time);
      expect(result.success).toBe(false);
      expect(result.error).toContain("already booked");
    });
  });

  describe("cancelAppointment", () => {
    it("sets status to cancelled", async () => {
      const time = new Date();
      time.setDate(time.getDate() + 7);
      time.setHours(17, 0, 0, 0);
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: time.toISOString(), endTime: new Date(time.getTime() + 3600000).toISOString(), status: "confirmed",
      }).run();
      const result = await cancelAppointment(1);
      expect(result.success).toBe(true);
      const appt = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get();
      expect(appt?.status).toBe("cancelled");
    });

    it("rejects already cancelled", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "cancelled",
      }).run();
      const result = await cancelAppointment(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("already cancelled");
    });

    it("does NOT refund confirmed appointments", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "confirmed",
      }).run();
      const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      await cancelAppointment(1);
      const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
    });

    it("refunds completed appointments", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "completed",
      }).run();
      const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      await cancelAppointment(1);
      const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) + 1);
    });
  });

  describe("completeAppointment", () => {
    it("sets status to completed and decrements session", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "confirmed",
      }).run();
      const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      const result = await completeAppointment(1);
      expect(result.success).toBe(true);
      const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      expect(after.sessionsRemaining).toBe((before.sessionsRemaining ?? 0) - 1);
    });

    it("rejects already completed", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "completed",
      }).run();
      const result = await completeAppointment(1);
      expect(result.success).toBe(false);
    });

    it("rejects cancelled appointments", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T17:00:00.000Z", endTime: "2026-04-13T18:00:00.000Z", status: "cancelled",
      }).run();
      const result = await completeAppointment(1);
      expect(result.success).toBe(false);
    });
  });
});
