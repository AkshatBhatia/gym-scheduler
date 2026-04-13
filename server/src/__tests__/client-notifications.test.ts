import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Client notification tests — verifies that client-initiated actions
 * send the correct SMS to both the client AND the instructor.
 *
 * Spec says:
 *   - book_appointment: client gets confirmation, instructor gets notification
 *   - cancel_appointment: client gets cancellation, instructor gets notification
 *   - reschedule_appointment: client gets rescheduled notice, instructor notified
 *   - create_recurring_schedule: client gets confirmation, instructor notified
 *   - skip_recurring_instance: client gets per-week notice, instructor notified
 *   - delete_recurring_schedule: client gets cancellation, instructor notified
 *
 * Most SMS is sent at the chat layer (not service layer), so these are
 * primarily placeholders for when we wire notifications into the client flow.
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
  listRecurringSchedules: vi.fn().mockResolvedValue([]),
  updateRecurringSchedule: vi.fn().mockResolvedValue({ success: true }),
  deleteRecurringSchedule: vi.fn().mockResolvedValue({ success: true }),
}));

describe("Client notifications: booking", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  // SMS is sent at the chat tool layer. These document expected behavior.
  it.todo("sends confirmation SMS to client after booking");
  it.todo("sends notification SMS to instructor after client books");
  it.todo("does NOT send SMS if booking fails");
});

describe("Client notifications: cancellation", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("sends cancellation SMS to client");
  it.todo("sends notification SMS to instructor when client cancels");
  it.todo("does NOT send SMS if cancellation fails");
});

describe("Client notifications: reschedule", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("sends rescheduled SMS to client with old and new times");
  it.todo("sends notification SMS to instructor with old and new times");
  it.todo("does NOT send SMS if reschedule fails");
});

describe("Client notifications: recurring", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("sends confirmation SMS to client when recurring created");
  it.todo("sends notification to instructor when client creates recurring");
  it.todo("sends per-week SMS to client when skipping");
  it.todo("sends notification to instructor when client skips");
  it.todo("sends cancellation SMS to client when recurring deleted");
  it.todo("sends notification to instructor when client deletes recurring");
});

describe("Client notifications: read-only tools send nothing", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSendSms.mockClear();
  });

  it.todo("list_appointments sends no SMS");
  it.todo("get_available_slots sends no SMS");
  it.todo("get_my_info sends no SMS");
  it.todo("get_session_balance sends no SMS");
  it.todo("list_recurring_schedules sends no SMS");
  it.todo("get_payment_info sends no SMS");
});
