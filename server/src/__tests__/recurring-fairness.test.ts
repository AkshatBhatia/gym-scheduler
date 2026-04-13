import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";

/**
 * Fair distribution tests for recurring schedule generation.
 *
 * Spec says: "distribute generated appointments evenly across all active
 * schedules via round-robin by date. Start from the next available date."
 *
 * These tests verify the round-robin distribution algorithm, which is
 * the core scheduling fairness invariant.
 */

// ---------------------------------------------------------------------------
// In-memory DB (self-contained, same pattern as recurring.test.ts)
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
      email TEXT, notes TEXT, package_type TEXT, sessions_remaining INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
      recurring_schedule_id INTEGER, notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE session_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
      appointment_id INTEGER REFERENCES appointments(id), change_amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE recurring_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
      day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      active INTEGER DEFAULT 1, notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day_of_week INTEGER, start_time TEXT NOT NULL,
      end_time TEXT NOT NULL, is_blocked INTEGER DEFAULT 0, override_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles');
  `);

  return drizzle(sqlite, { schema });
}

let testDb: ReturnType<typeof createTestDb>;
let phoneSeq = 0;

vi.mock("../db/index.js", () => ({
  __esModule: true,
  get default() { return testDb; },
  get db() { return testDb; },
}));

vi.mock("../services/timezone.js", () => ({
  localDateTimeToUTC: (date: string, time: string) => `${date}T${time}:00.000Z`,
  todayLocal: () => "2026-04-12", // Sunday
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

const { generateForClient } = await import("../services/recurring.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function insertClient(overrides: Partial<typeof schema.clients.$inferInsert> = {}) {
  phoneSeq++;
  const values = {
    name: "Test Client",
    phone: `555-${String(phoneSeq).padStart(6, "0")}`,
    sessionsRemaining: 10,
    ...overrides,
  };
  testDb.insert(schema.clients).values(values).run();
  return testDb.select().from(schema.clients)
    .where(eq(schema.clients.phone, values.phone)).get()!;
}

function insertSchedule(clientId: number, overrides: Partial<typeof schema.recurringSchedules.$inferInsert> = {}) {
  const values = {
    clientId,
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "10:00",
    active: 1,
    ...overrides,
  };
  testDb.insert(schema.recurringSchedules).values(values).run();
}

function insertAvailability(dayOfWeek: number, startTime = "06:00", endTime = "18:00") {
  testDb.insert(schema.availability).values({
    dayOfWeek, startTime, endTime, isBlocked: 0,
  }).run();
}

function getAppointments(clientId: number) {
  return testDb.select().from(schema.appointments)
    .where(eq(schema.appointments.clientId, clientId))
    .all();
}

function getDayOfWeekFromISO(iso: string): number {
  return new Date(iso).getUTCDay(); // 0=Sun, 6=Sat
}

// =========================================================================
// FAIR DISTRIBUTION TESTS
// =========================================================================

describe("Recurring: fair distribution across schedules", () => {
  beforeEach(() => {
    testDb = createTestDb();
    phoneSeq = 0;

    // Full-week availability Mon-Sat
    for (let day = 1; day <= 6; day++) {
      insertAvailability(day);
    }
  });

  it("distributes evenly between 2 schedules over 12 weeks", async () => {
    const client = insertClient({ sessionsRemaining: 10 });
    insertSchedule(client.id, { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" }); // Monday
    insertSchedule(client.id, { dayOfWeek: 3, startTime: "09:00", endTime: "10:00" }); // Wednesday

    const result = await generateForClient(client.id);
    // 2 schedules x 12 weeks = 24
    expect(result.created).toBe(24);

    const appts = getAppointments(client.id);
    const mondays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 1);
    const wednesdays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 3);

    expect(mondays.length).toBe(12);
    expect(wednesdays.length).toBe(12);
  });

  it("distributes evenly across 2 schedules (same count per day)", async () => {
    const client = insertClient({ sessionsRemaining: 7 });
    insertSchedule(client.id, { dayOfWeek: 1 }); // Monday
    insertSchedule(client.id, { dayOfWeek: 3 }); // Wednesday

    const result = await generateForClient(client.id);
    expect(result.created).toBe(24); // 12 per schedule

    const appts = getAppointments(client.id);
    const mondays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 1);
    const wednesdays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 3);

    // Both get 12 weeks each
    expect(mondays.length).toBe(12);
    expect(wednesdays.length).toBe(12);
  });

  it("distributes across 3 schedules (Tue/Thu/Sat)", async () => {
    const client = insertClient({ sessionsRemaining: 9 });
    insertSchedule(client.id, { dayOfWeek: 2 }); // Tuesday
    insertSchedule(client.id, { dayOfWeek: 4 }); // Thursday
    insertSchedule(client.id, { dayOfWeek: 6 }); // Saturday

    const result = await generateForClient(client.id);
    expect(result.created).toBe(36); // 3 schedules x 12 weeks

    const appts = getAppointments(client.id);
    const tue = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 2);
    const thu = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 4);
    const sat = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 6);

    expect(tue.length).toBe(12);
    expect(thu.length).toBe(12);
    expect(sat.length).toBe(12);
  });

  it("round-robin fills by date order, not by schedule order", async () => {
    // Today is Sunday 2026-04-12. With Mon(1) + Wed(3) schedules:
    // Expected order: Mon 04-13, Wed 04-15, Mon 04-20, Wed 04-22, ...
    const client = insertClient({ sessionsRemaining: 4 });
    insertSchedule(client.id, { dayOfWeek: 1 }); // Monday
    insertSchedule(client.id, { dayOfWeek: 3 }); // Wednesday

    await generateForClient(client.id);

    const appts = getAppointments(client.id);
    const dates = appts.map(a => a.startTime.slice(0, 10)).sort();

    // First 4 should alternate: Mon, Wed, Mon, Wed
    expect(getDayOfWeekFromISO(dates[0] + "T10:00:00Z")).toBe(1); // Monday
    expect(getDayOfWeekFromISO(dates[1] + "T10:00:00Z")).toBe(3); // Wednesday
    expect(getDayOfWeekFromISO(dates[2] + "T10:00:00Z")).toBe(1); // Monday
    expect(getDayOfWeekFromISO(dates[3] + "T10:00:00Z")).toBe(3); // Wednesday
  });

  it("single schedule gets 12 weeks", async () => {
    const client = insertClient({ sessionsRemaining: 5 });
    insertSchedule(client.id, { dayOfWeek: 1 }); // Monday only

    const result = await generateForClient(client.id);
    expect(result.created).toBe(12);

    const appts = getAppointments(client.id);
    for (const a of appts) {
      expect(getDayOfWeekFromISO(a.startTime)).toBe(1); // all Mondays
    }
  });

  it("skips inactive schedules during distribution", async () => {
    const client = insertClient({ sessionsRemaining: 6 });
    insertSchedule(client.id, { dayOfWeek: 1, active: 1 }); // Monday — active
    insertSchedule(client.id, { dayOfWeek: 3, active: 0 }); // Wednesday — inactive

    const result = await generateForClient(client.id);
    expect(result.created).toBe(12); // only Monday schedule, 12 weeks

    const appts = getAppointments(client.id);
    for (const a of appts) {
      expect(getDayOfWeekFromISO(a.startTime)).toBe(1); // all Mondays
    }
  });

  it("skips conflicting weeks from other clients", async () => {
    // Insert a blocker client and appointment
    testDb.insert(schema.clients).values({
      name: "Blocker", phone: "+15550001111", sessionsRemaining: 0,
    }).run();
    const blocker = testDb.select().from(schema.clients)
      .where(eq(schema.clients.phone, "+15550001111")).get()!;

    testDb.insert(schema.appointments).values({
      clientId: blocker.id,
      startTime: "2026-04-13T09:00:00.000Z",
      endTime: "2026-04-13T10:00:00.000Z",
      status: "confirmed",
    }).run();

    const client = insertClient({ sessionsRemaining: 3 });
    insertSchedule(client.id, { dayOfWeek: 1 }); // Monday 09:00

    const result = await generateForClient(client.id);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.created).toBe(11); // 12 - 1 blocked = 11
  });
});

// =========================================================================
// REGENERATION ON CHANGES
// =========================================================================

describe("Recurring: regeneration after schedule changes", () => {
  beforeEach(() => {
    testDb = createTestDb();
    phoneSeq = 0;

    for (let day = 1; day <= 6; day++) {
      insertAvailability(day);
    }
  });

  it("adding a second schedule redistributes existing appointments", async () => {
    const client = insertClient({ sessionsRemaining: 6 });
    insertSchedule(client.id, { dayOfWeek: 1 }); // Monday

    // Generate: all 12 on Monday (indefinite horizon)
    await generateForClient(client.id);
    let appts = getAppointments(client.id);
    expect(appts.length).toBe(12);
    expect(appts.every(a => getDayOfWeekFromISO(a.startTime) === 1)).toBe(true);

    // Add Wednesday schedule
    insertSchedule(client.id, { dayOfWeek: 3 });

    // Delete future recurring and regenerate (simulating what the tool does)
    const futureRecurring = appts.filter(
      a => a.recurringScheduleId != null && a.startTime > new Date().toISOString()
    );
    for (const a of futureRecurring) {
      testDb.delete(schema.appointments).where(eq(schema.appointments.id, a.id)).run();
    }

    await generateForClient(client.id);

    appts = getAppointments(client.id);
    const mondays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 1);
    const wednesdays = appts.filter(a => getDayOfWeekFromISO(a.startTime) === 3);

    // Should be 12 each (indefinite horizon)
    expect(mondays.length).toBe(12);
    expect(wednesdays.length).toBe(12);
  });
});
