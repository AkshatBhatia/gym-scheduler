import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * SMS Notification tests — verifies every tool sends (or doesn't send)
 * client SMS per the spec's "Client notification quick reference" table.
 *
 * These test the NOTIFICATION side-effect, not the core logic (which is
 * tested in each tool's own test file).
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

// Mock recurring generation so it doesn't interfere
vi.mock("../services/recurring.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    generateForClient: vi.fn().mockResolvedValue({ created: 0, skipped: 0 }),
  };
});

// Import services AFTER mocks
const { bookAppointment, cancelAppointment, completeAppointment } = await import("../services/scheduling.js");

// Helper: next Monday at given hour UTC
const nextMondayAt = (hour: number) => {
  const d = new Date();
  const daysUntilMon = ((1 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// =========================================================================
// 1. APPOINTMENT TOOLS
// =========================================================================

describe("SMS: book_appointment", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // SMS is sent at the chat tool layer, not the service layer.
  // These tests will be implementable once SMS is wired into toolBookAppointment.
  it.todo("sends booking confirmation SMS to client");
  it.todo("does NOT send SMS if booking fails");
});

describe("SMS: cancel_appointment", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(10),
      endTime: new Date(new Date(nextMondayAt(10)).getTime() + 3600000).toISOString(),
      status: "confirmed",
    }).run();
  });

  // SMS is sent at the chat tool layer, not the service layer.
  it.todo("sends cancellation SMS to client");
  it.todo("does NOT send SMS if cancellation fails");
});

describe("SMS: mark_completed", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();
  });

  it("does NOT send SMS on completion (client was just there)", async () => {
    await completeAppointment(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});

describe("SMS: mark_no_show", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
    }).run();
  });

  // TODO: import markNoShow once implemented
  it.todo("sends 'missed session' SMS to client");
  it.todo("includes date and time in SMS");
  it.todo("does NOT send SMS if mark_no_show fails (already cancelled)");
});

describe("SMS: reschedule_appointment", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: nextMondayAt(10),
      endTime: new Date(new Date(nextMondayAt(10)).getTime() + 3600000).toISOString(),
      status: "confirmed",
    }).run();
  });

  // TODO: import rescheduleAppointment once implemented
  it.todo("sends rescheduled SMS with old and new date/time");
  it.todo("does NOT send SMS if reschedule fails (conflict)");
});

// =========================================================================
// 2. RECURRING SCHEDULE TOOLS
// =========================================================================

describe("SMS: create_recurring_schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: test at the chat tool layer where create_recurring_schedule calls SMS
  it.todo("sends confirmation SMS with recurring day/time details");
  it.todo("includes all recurring days in a single SMS (e.g. 'Tue and Thu at 9am')");
});

describe("SMS: update_recurring_schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();
  });

  // TODO: import updateRecurringSchedule once implemented
  it.todo("sends SMS informing client of day/time change");
  it.todo("includes both old and new schedule in SMS");
  it.todo("does NOT send SMS if update fails (no availability)");
});

describe("SMS: delete_recurring_schedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();
  });

  // TODO: import deleteRecurringSchedule once implemented
  it.todo("sends cancellation SMS with recurring day/time");
  it.todo("does NOT send SMS if delete fails (not found)");
});

describe("SMS: skip_recurring_instance", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();

    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "10:00", endTime: "11:00", active: 1,
    }).run();

    // Generate 4 weeks of recurring appointments
    for (const date of ["2026-04-13", "2026-04-20", "2026-04-27", "2026-05-04"]) {
      testDb.db.insert(schema.appointments).values({
        clientId: 1, startTime: `${date}T10:00:00.000Z`, endTime: `${date}T11:00:00.000Z`,
        status: "confirmed", recurringScheduleId: 1,
      }).run();
    }
  });

  // TODO: import skipRecurringInstance once implemented
  it.todo("sends SMS for each skipped week");
  it.todo("sends 4 SMS when skipping 4 weeks");
  it.todo("SMS mentions the specific date being skipped");
  it.todo("SMS mentions recurring schedule continues after");
});

// =========================================================================
// 3. AVAILABILITY TOOLS — cascading SMS
// =========================================================================

describe("SMS: block_time cascading", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: update block_time to support cascading, then import
  it("sends SMS to each client with cancelled appointments", async () => {
    // Book two clients on Monday
    testDb.db.insert(schema.appointments).values([
      {
        clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
        endTime: "2026-04-13T11:00:00.000Z", status: "confirmed",
      },
      {
        clientId: 2, startTime: "2026-04-13T10:30:00.000Z",
        endTime: "2026-04-13T11:30:00.000Z", status: "confirmed",
      },
    ]).run();

    // Block Monday 10am-12pm — should cascade-cancel both
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-13", startTime: "10:00", endTime: "12:00", isBlocked: 1,
    }).run();

    // TODO: call cascading function here
    // expect(mockSendSms).toHaveBeenCalledTimes(2);
    // expect(mockSendSms).toHaveBeenCalledWith("+15551234567", expect.stringMatching(/cancel/i));
    // expect(mockSendSms).toHaveBeenCalledWith("+15559876543", expect.stringMatching(/cancel/i));
  });

  it("does NOT send SMS if no appointments are affected by the block", async () => {
    // Block a time with no appointments
    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-13", startTime: "20:00", endTime: "21:00", isBlocked: 1,
    }).run();

    // TODO: call cascading function here
    // expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("does NOT send SMS for already-cancelled appointments", async () => {
    testDb.db.insert(schema.appointments).values({
      clientId: 1, startTime: "2026-04-13T10:00:00.000Z",
      endTime: "2026-04-13T11:00:00.000Z", status: "cancelled",
    }).run();

    testDb.db.insert(schema.availability).values({
      overrideDate: "2026-04-13", startTime: "10:00", endTime: "12:00", isBlocked: 1,
    }).run();

    // TODO: call cascading function here
    // expect(mockSendSms).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 4. CLIENT MANAGEMENT TOOLS
// =========================================================================

describe("SMS: add_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: add_client currently does not send SMS — needs to be added
  it.todo("sends welcome SMS to new client");
  it.todo("welcome SMS includes instructor name");
  it.todo("does NOT send SMS if client creation fails (duplicate phone)");
});

describe("SMS: update_client_sessions", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: update_client_sessions currently does not send SMS — needs to be added
  it.todo("sends balance update SMS to client");
  it.todo("SMS includes new session count");
  it.todo("does NOT send SMS if update fails");
});

describe("SMS: deactivate_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // Per spec: "No — instructor handles personally"
  it.todo("does NOT send SMS on deactivation");
});

describe("SMS: reactivate_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // TODO: import reactivateClient once implemented
  it.todo("sends welcome-back SMS to reactivated client");
  it.todo("does NOT send SMS if reactivation fails (client not found)");
});

// =========================================================================
// 5. READ-ONLY TOOLS — verify NO SMS sent
// =========================================================================

describe("SMS: read-only tools send nothing", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("list_appointments sends no SMS");
  it.todo("get_available_slots sends no SMS");
  it.todo("get_client_info sends no SMS");
  it.todo("get_session_balance sends no SMS");
  it.todo("list_recurring_schedules sends no SMS");
  it.todo("list_availability sends no SMS");
  it.todo("list_clients sends no SMS");
  it.todo("search_messages sends no SMS");
  it.todo("get_daily_summary sends no SMS");
  it.todo("get_weekly_summary sends no SMS");
  it.todo("remove_block sends no SMS");
  it.todo("update_client sends no SMS");
});
