import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";

// ---------------------------------------------------------------------------
// In-memory SQLite database factory
// ---------------------------------------------------------------------------
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      notes TEXT,
      package_type TEXT,
      sessions_remaining INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      recurring_schedule_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE session_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      appointment_id INTEGER REFERENCES appointments(id),
      change_amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE recurring_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      end_date TEXT,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week INTEGER,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_blocked INTEGER DEFAULT 0,
      override_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles');
  `);

  return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// Mock the db module
// ---------------------------------------------------------------------------
let testDb: ReturnType<typeof createTestDb>;

vi.mock("../db/index.js", () => ({
  __esModule: true,
  get default() {
    return testDb;
  },
  get db() {
    return testDb;
  },
}));

// Mock timezone helpers so tests are deterministic (no real tz DB needed)
vi.mock("../services/timezone.js", () => ({
  localDateTimeToUTC(date: string, time: string): string {
    // Return a predictable ISO string: treat as UTC for simplicity
    return `${date}T${time}:00.000Z`;
  },
  todayLocal(): string {
    // Fixed "today" so tests are reproducible
    return "2026-04-12";
  },
  formatDateYMD: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
}));

// Import AFTER mocks
const { generateForClient, generateAllRecurring } = await import(
  "../services/recurring.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let phoneSeq = 0;

function insertClient(
  overrides: Partial<typeof schema.clients.$inferInsert> = {}
) {
  phoneSeq++;
  const values = {
    name: "Test Client",
    phone: `555-${String(phoneSeq).padStart(6, "0")}`,
    sessionsRemaining: 3,
    ...overrides,
  };
  testDb.insert(schema.clients).values(values).run();
  return testDb
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.phone, values.phone))
    .get()!;
}

function insertSchedule(
  clientId: number,
  overrides: Partial<typeof schema.recurringSchedules.$inferInsert> = {}
) {
  const values = {
    clientId,
    dayOfWeek: 1, // Monday
    startTime: "09:00",
    endTime: "10:00",
    active: 1,
    ...overrides,
  };
  testDb.insert(schema.recurringSchedules).values(values).run();
}

function insertAppointment(
  clientId: number,
  overrides: Partial<typeof schema.appointments.$inferInsert> = {}
) {
  const values = {
    clientId,
    startTime: "2026-04-20T09:00:00.000Z",
    endTime: "2026-04-20T10:00:00.000Z",
    status: "confirmed" as const,
    ...overrides,
  };
  testDb.insert(schema.appointments).values(values).run();
}

function insertAvailability(
  overrides: Partial<typeof schema.availability.$inferInsert> = {}
) {
  const values = {
    startTime: "09:00",
    endTime: "10:00",
    isBlocked: 1,
    ...overrides,
  };
  testDb.insert(schema.availability).values(values).run();
}

function countAppointments(clientId: number) {
  return testDb
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.clientId, clientId))
    .all().length;
}

// ---------------------------------------------------------------------------
// generateForClient
// ---------------------------------------------------------------------------
describe("generateForClient (indefinite, 12-week horizon)", () => {
  beforeEach(() => {
    testDb = createTestDb();
    phoneSeq = 0;
    // Set up availability Mon-Sat 06:00-18:00 (Sun is off)
    for (let day = 0; day <= 6; day++) {
      insertAvailability({ dayOfWeek: day, startTime: "06:00", endTime: "18:00", isBlocked: 0 });
    }
  });

  it("generates 12 weeks of appointments for a single schedule", async () => {
    const client = insertClient({ sessionsRemaining: 3 });
    insertSchedule(client.id, { dayOfWeek: 1 });

    const result = await generateForClient(client.id);

    // 12-week horizon, 1 schedule = 12 appointments (not limited by sessions)
    expect(result.created).toBe(12);
    expect(countAppointments(client.id)).toBe(12);
  });

  it("generates 12 weeks per schedule across multiple schedules", async () => {
    const client = insertClient({ sessionsRemaining: 4 });
    insertSchedule(client.id, { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });
    insertSchedule(client.id, { dayOfWeek: 3, startTime: "11:00", endTime: "12:00" });

    const result = await generateForClient(client.id);

    // 2 schedules x 12 weeks = 24
    expect(result.created).toBe(24);
    expect(countAppointments(client.id)).toBe(24);
  });

  it("skips days blocked by a date-specific availability block", async () => {
    const client = insertClient({ sessionsRemaining: 2 });
    insertSchedule(client.id, { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });

    insertAvailability({
      overrideDate: "2026-04-13",
      startTime: "08:00",
      endTime: "11:00",
      isBlocked: 1,
    });

    const result = await generateForClient(client.id);

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // 12 weeks minus 1 blocked = 11
    expect(result.created).toBe(11);
  });

  it("skips days blocked by a recurring day-of-week block", async () => {
    const client = insertClient({ sessionsRemaining: 2 });
    insertSchedule(client.id, { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });

    insertAvailability({
      dayOfWeek: 1,
      startTime: "08:00",
      endTime: "11:00",
      isBlocked: 1,
    });

    const result = await generateForClient(client.id);

    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("generates for today if schedule matches today's day", async () => {
    // "Today" is 2026-04-12 (Sunday, day 0)
    const client = insertClient({ sessionsRemaining: 1 });
    insertSchedule(client.id, { dayOfWeek: 0 }); // Sunday

    const result = await generateForClient(client.id);

    // Should generate for today + 11 more Sundays = 12
    expect(result.created).toBe(12);
  });

  it("generates even when sessionsRemaining is 0 (holds calendar slot)", async () => {
    const client = insertClient({ sessionsRemaining: 0 });
    insertSchedule(client.id, { dayOfWeek: 1 });

    const result = await generateForClient(client.id);

    // Indefinite: still generates 12 weeks
    expect(result.created).toBe(12);
  });

  it("generates 12 weeks regardless of package type", async () => {
    const client = insertClient({ sessionsRemaining: 0, packageType: "monthly" });
    insertSchedule(client.id, { dayOfWeek: 1 });

    const result = await generateForClient(client.id);

    expect(result.created).toBe(12);
    expect(countAppointments(client.id)).toBe(12);
  });

  it("does not double-create if appointments already exist at those times", async () => {
    const client = insertClient({ sessionsRemaining: 3 });
    insertSchedule(client.id, { dayOfWeek: 1, startTime: "09:00", endTime: "10:00" });

    // Pre-insert an appointment at the first Monday's recurring slot
    insertAppointment(client.id, {
      startTime: "2026-04-13T09:00:00.000Z",
      endTime: "2026-04-13T10:00:00.000Z",
      status: "confirmed",
    });

    const result = await generateForClient(client.id);

    // 12 weeks - 1 existing = 11 new
    expect(result.created).toBe(11);
    expect(countAppointments(client.id)).toBe(12); // 1 pre-existing + 11 new
  });

  it("returns { created: 0, skipped: 0 } for nonexistent client", async () => {
    const result = await generateForClient(9999);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateAllRecurring
// ---------------------------------------------------------------------------
describe("generateAllRecurring", () => {
  beforeEach(() => {
    testDb = createTestDb();
    phoneSeq = 0;
    for (let day = 0; day <= 6; day++) {
      insertAvailability({ dayOfWeek: day, startTime: "06:00", endTime: "18:00", isBlocked: 0 });
    }
  });

  it("generates for each unique client with active schedules", async () => {
    const clientA = insertClient({ sessionsRemaining: 2, name: "A" });
    const clientB = insertClient({ sessionsRemaining: 1, name: "B" });

    insertSchedule(clientA.id, { dayOfWeek: 1 });
    insertSchedule(clientB.id, { dayOfWeek: 3 });

    const result = await generateAllRecurring();

    // Both get 12 weeks each
    expect(result.created).toBe(24);
    expect(countAppointments(clientA.id)).toBe(12);
    expect(countAppointments(clientB.id)).toBe(12);
  });

  it("deduplicates clients that have multiple active schedules", async () => {
    const client = insertClient({ sessionsRemaining: 4 });
    insertSchedule(client.id, { dayOfWeek: 1 });
    insertSchedule(client.id, { dayOfWeek: 3 });

    const result = await generateAllRecurring();

    // 2 schedules x 12 weeks = 24
    expect(result.created).toBe(24);
    expect(countAppointments(client.id)).toBe(24);
  });
});
