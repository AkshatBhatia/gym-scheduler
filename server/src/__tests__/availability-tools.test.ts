import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for availability management tools:
 *   - set_availability: set regular weekly hours
 *   - list_availability: view all rules + overrides
 *   - override_availability: one-off date override (isBlocked=0, overrideDate=date)
 *   - remove_block: delete a blocked time entry
 *   - Cascading: when availability shrinks, conflicting appointments are cancelled,
 *     instructor is informed, and clients are notified via SMS.
 *
 * Expected service functions:
 *   setAvailability(rules: { dayOfWeek: number; startTime: string; endTime: string }[]): Promise<...>
 *   listAvailability(): Promise<{ recurring: ...; overrides: ...; blocks: ... }>
 *   overrideAvailability(date: string, startTime: string, endTime: string): Promise<...>
 *   removeBlock(blockId: number): Promise<{ success: boolean; error?: string }>
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

// Mock SMS so we can verify client notifications
const mockSendSms = vi.fn().mockResolvedValue({ sid: "SM_test" });
vi.mock("../services/sms.js", () => ({
  sendSms: mockSendSms,
}));

// TODO: update imports once service functions are implemented
const {
  setAvailability,
  listAvailability,
  overrideAvailability,
  removeBlock,
} = await import("../services/availability.js");

describe("set_availability", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("creates weekly availability rules for multiple days", async () => {
    // Clear existing availability first
    testDb.db.delete(schema.availability).run();

    const rules = [
      { dayOfWeek: 1, startTime: "08:00", endTime: "18:00" }, // Monday
      { dayOfWeek: 2, startTime: "08:00", endTime: "18:00" }, // Tuesday
      { dayOfWeek: 3, startTime: "08:00", endTime: "18:00" }, // Wednesday
    ];

    const result = await setAvailability(rules);
    expect(result.success).toBe(true);

    const all = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate === null && a.isBlocked === 0);
    expect(all.length).toBe(3);
  });

  it("replaces existing weekly rules for the same day", async () => {
    const result = await setAvailability([
      { dayOfWeek: 1, startTime: "10:00", endTime: "14:00" },
    ]);
    expect(result.success).toBe(true);

    const mondayRules = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.dayOfWeek === 1 && a.overrideDate === null && a.isBlocked === 0);

    expect(mondayRules.length).toBe(1);
    expect(mondayRules[0].startTime).toBe("10:00");
    expect(mondayRules[0].endTime).toBe("14:00");
  });

  it("rejects if startTime >= endTime", async () => {
    const result = await setAvailability([
      { dayOfWeek: 1, startTime: "18:00", endTime: "08:00" },
    ]);
    expect(result.success).toBe(false);
  });

  it("does NOT affect date-specific overrides or blocks", async () => {
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-15", startTime: "09:00", endTime: "12:00", isBlocked: 1,
    }).run();

    const blocksBefore = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate !== null);

    await setAvailability([
      { dayOfWeek: 1, startTime: "10:00", endTime: "14:00" },
    ]);

    const blocksAfter = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate !== null);

    expect(blocksAfter.length).toBe(blocksBefore.length);
  });
});

describe("list_availability", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns recurring rules, overrides, and blocks separately", async () => {
    // Add an override and a block
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-19", startTime: "09:00", endTime: "12:00", isBlocked: 0,
    }).run();
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-20", startTime: "10:00", endTime: "11:00", isBlocked: 1,
    }).run();

    const result = await listAvailability();

    expect(result.recurring).toBeDefined();
    expect(result.recurring.length).toBeGreaterThan(0);
    expect(result.overrides).toBeDefined();
    expect(result.overrides.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("recurring rules include day of week and time range", async () => {
    const result = await listAvailability();

    for (const rule of result.recurring) {
      expect(rule).toHaveProperty("dayOfWeek");
      expect(rule).toHaveProperty("startTime");
      expect(rule).toHaveProperty("endTime");
    }
  });
});

describe("override_availability", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("creates a date-specific availability override (isBlocked=0)", async () => {
    // Saturday normally has availability in seed, but let's add a Sunday override
    const result = await overrideAvailability("2026-04-19", "09:00", "12:00");
    expect(result.success).toBe(true);

    const overrides = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate === "2026-04-19" && a.isBlocked === 0);
    expect(overrides.length).toBe(1);
    expect(overrides[0].startTime).toBe("09:00");
    expect(overrides[0].endTime).toBe("12:00");
  });

  it("rejects if startTime >= endTime", async () => {
    const result = await overrideAvailability("2026-04-19", "14:00", "10:00");
    expect(result.success).toBe(false);
  });

  it("replaces existing override for the same date", async () => {
    await overrideAvailability("2026-04-19", "09:00", "12:00");
    await overrideAvailability("2026-04-19", "10:00", "15:00");

    const overrides = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate === "2026-04-19" && a.isBlocked === 0);

    // Should have replaced, not duplicated
    expect(overrides.length).toBe(1);
    expect(overrides[0].startTime).toBe("10:00");
  });
});

describe("remove_block", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("deletes a blocked time entry", async () => {
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-15", startTime: "10:00", endTime: "12:00", isBlocked: 1,
    }).run();

    const block = testDb.db.select().from(schema.availability)
      .all()
      .filter(a => a.overrideDate === "2026-04-15" && a.isBlocked === 1)[0];

    const result = await removeBlock(block.id);
    expect(result.success).toBe(true);

    const after = testDb.db.select().from(schema.availability)
      .where(eq(schema.availability.id, block.id)).get();
    expect(after).toBeUndefined();
  });

  it("rejects if block does not exist", async () => {
    const result = await removeBlock(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects if ID refers to a non-blocked availability rule", async () => {
    // Try to remove a regular availability rule (isBlocked=0)
    const rule = testDb.db.select().from(schema.availability)
      .all()
      .find(a => a.isBlocked === 0);

    if (rule) {
      const result = await removeBlock(rule.id);
      expect(result.success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cascading: availability changes cancel conflicting appointments
// ---------------------------------------------------------------------------
describe("availability change cascading", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // --- block_time cascading ---
  // Note: block_time already exists but may need cascading logic added.
  // These tests cover the expected behavior from the spec.

  describe("block_time cancels conflicting appointments", () => {
    it("cancels confirmed appointments that overlap the blocked range", async () => {
      // Sarah has an appointment Monday 10am (within seed availability 06:00-18:00)
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
      }).run();

      // Block Monday 9am-12pm — overlaps the 10am appointment
      // This uses the existing block_time or a new blockTime service function
      testDb.db.insert(schema.availability).values({
        overrideDate: "2026-04-13", startTime: "09:00", endTime: "12:00", isBlocked: 1,
      }).run();

      // TODO: call the cascading function that block_time should trigger
      // For now, test the expected outcome:
      // The appointment should be cancelled
      // The client should receive an SMS notification
    });
  });

  describe("set_availability cancels appointments outside new hours", () => {
    it("cancels future appointments on a removed day", async () => {
      // Appointments on Fridays (day 5): 2026-04-18 and 2026-04-25 are Fridays
      testDb.db.insert(schema.appointments).values([
        { clientId: 1, startTime: "2026-04-18T10:00:00.000Z", endTime: "2026-04-18T11:00:00.000Z", status: "confirmed" },
        { clientId: 2, startTime: "2026-04-25T10:00:00.000Z", endTime: "2026-04-25T11:00:00.000Z", status: "confirmed" },
      ]).run();

      // Set availability to Mon-Thu only (remove Friday)
      const result = await setAvailability([
        { dayOfWeek: 1, startTime: "06:00", endTime: "18:00" },
        { dayOfWeek: 2, startTime: "06:00", endTime: "18:00" },
        { dayOfWeek: 3, startTime: "06:00", endTime: "18:00" },
        { dayOfWeek: 4, startTime: "06:00", endTime: "18:00" },
        // Friday (5) and Saturday (6) removed
      ]);

      expect(result.success).toBe(true);
      expect(result.cancelledAppointments).toBeDefined();
      expect(result.cancelledAppointments.length).toBe(2);

      // Both Friday appointments should be cancelled
      const fridayAppts = testDb.db.select().from(schema.appointments).all();
      for (const appt of fridayAppts) {
        expect(appt.status).toBe("cancelled");
      }
    });

    it("cancels appointments outside narrowed hours", async () => {
      // Appointment at 7am Monday (within current 06:00-18:00)
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T07:00:00.000Z", endTime: "2026-04-13T08:00:00.000Z", status: "confirmed",
      }).run();
      // Appointment at 10am Monday (within new hours too)
      testDb.db.insert(schema.appointments).values({
        clientId: 2, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
      }).run();

      // Narrow Monday to 09:00-17:00 (was 06:00-18:00)
      await setAvailability([
        { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      ]);

      // 7am appointment should be cancelled (outside new window)
      const early = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get()!;
      expect(early.status).toBe("cancelled");

      // 10am appointment should remain confirmed (inside new window)
      const mid = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 2)).get()!;
      expect(mid.status).toBe("confirmed");
    });

    it("does NOT cancel past or completed appointments", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-06T10:00:00.000Z", endTime: "2026-04-06T11:00:00.000Z", status: "completed",
      }).run();

      await setAvailability([
        { dayOfWeek: 1, startTime: "14:00", endTime: "18:00" }, // narrows hours past 10am
      ]);

      const completed = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get()!;
      expect(completed.status).toBe("completed"); // untouched
    });

    it("does NOT deduct sessions for cascaded cancellations", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T07:00:00.000Z", endTime: "2026-04-13T08:00:00.000Z", status: "confirmed",
      }).run();

      const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
      await setAvailability([
        { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      ]);
      const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

      expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
    });

    it("sends SMS to each affected client", async () => {
      testDb.db.insert(schema.appointments).values([
        { clientId: 1, startTime: "2026-04-13T07:00:00.000Z", endTime: "2026-04-13T08:00:00.000Z", status: "confirmed" },
        { clientId: 2, startTime: "2026-04-13T07:30:00.000Z", endTime: "2026-04-13T08:30:00.000Z", status: "confirmed" },
      ]).run();

      await setAvailability([
        { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      ]);

      // Should have sent 2 SMS notifications (one per client)
      expect(mockSendSms).toHaveBeenCalledTimes(2);
    });
  });

  describe("override_availability cancels appointments outside new window", () => {
    it("cancels appointments on the override date that fall outside new hours", async () => {
      // Appointments on Monday 2026-04-13
      testDb.db.insert(schema.appointments).values([
        { clientId: 1, startTime: "2026-04-13T09:00:00.000Z", endTime: "2026-04-13T10:00:00.000Z", status: "confirmed" },
        { clientId: 2, startTime: "2026-04-13T15:00:00.000Z", endTime: "2026-04-13T16:00:00.000Z", status: "confirmed" },
        { clientId: 3, startTime: "2026-04-13T11:00:00.000Z", endTime: "2026-04-13T12:00:00.000Z", status: "confirmed" },
      ]).run();

      // Override: Monday only 10:00-14:00 (normally 06:00-18:00)
      const result = await overrideAvailability("2026-04-13", "10:00", "14:00");
      expect(result.success).toBe(true);

      // 9am and 3pm appointments should be cancelled (outside 10-14)
      const appt9am = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get()!;
      expect(appt9am.status).toBe("cancelled");

      const appt3pm = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 2)).get()!;
      expect(appt3pm.status).toBe("cancelled");

      // 11am appointment should remain (inside 10-14)
      const appt11am = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 3)).get()!;
      expect(appt11am.status).toBe("confirmed");
    });

    it("returns the list of cancelled appointments to the instructor", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T09:00:00.000Z", endTime: "2026-04-13T10:00:00.000Z", status: "confirmed",
      }).run();

      const result = await overrideAvailability("2026-04-13", "10:00", "14:00");
      expect(result.cancelledAppointments).toBeDefined();
      expect(result.cancelledAppointments.length).toBe(1);
      expect(result.cancelledAppointments[0]).toHaveProperty("clientName");
      expect(result.cancelledAppointments[0]).toHaveProperty("startTime");
    });

    it("sends SMS to affected clients", async () => {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-13T09:00:00.000Z", endTime: "2026-04-13T10:00:00.000Z", status: "confirmed",
      }).run();

      await overrideAvailability("2026-04-13", "10:00", "14:00");

      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(mockSendSms).toHaveBeenCalledWith(
        expect.stringContaining("+1555"), // Sarah's phone
        expect.stringContaining("cancelled"),
      );
    });

    it("does NOT affect appointments on other dates", async () => {
      // Tuesday appointment
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: "2026-04-14T09:00:00.000Z", endTime: "2026-04-14T10:00:00.000Z", status: "confirmed",
      }).run();

      // Override only Monday
      await overrideAvailability("2026-04-13", "10:00", "14:00");

      // Tuesday appointment should be untouched
      const tue = testDb.db.select().from(schema.appointments).where(eq(schema.appointments.id, 1)).get()!;
      expect(tue.status).toBe("confirmed");
    });
  });
});
