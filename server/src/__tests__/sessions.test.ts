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
// Mock the db module so services use our in-memory DB
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

// Mock generateForClient so addSessions does not trigger real recurring logic
vi.mock("../services/recurring.js", () => ({
  generateForClient: vi.fn().mockResolvedValue({ created: 0, skipped: 0 }),
}));

// Import services AFTER mocks are registered
const { decrementSession, addSessions, getBalance } = await import(
  "../services/sessions.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function insertClient(
  overrides: Partial<typeof schema.clients.$inferInsert> = {}
) {
  const values = {
    name: "Test Client",
    phone: `555-${Math.random().toString().slice(2, 8)}`,
    sessionsRemaining: 5,
    ...overrides,
  };
  testDb.insert(schema.clients).values(values).run();
  return testDb
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.phone, values.phone))
    .get()!;
}

function insertAppointment(clientId: number) {
  testDb.insert(schema.appointments).values({
    clientId,
    startTime: "2026-04-20T17:00:00.000Z",
    endTime: "2026-04-20T18:00:00.000Z",
    status: "confirmed",
  }).run();
  return testDb.select().from(schema.appointments).all().pop()!;
}

// ---------------------------------------------------------------------------
// decrementSession
// ---------------------------------------------------------------------------
describe("decrementSession", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("decrements the session balance by 1", async () => {
    const client = insertClient({ sessionsRemaining: 5 });
    const appt = insertAppointment(client.id);
    const result = await decrementSession(client.id, appt.id);

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(4);

    const updated = testDb
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, client.id))
      .get()!;
    expect(updated.sessionsRemaining).toBe(4);
  });

  it("creates a ledger entry with changeAmount -1", async () => {
    const client = insertClient({ sessionsRemaining: 3 });
    const appt = insertAppointment(client.id);
    await decrementSession(client.id, appt.id);

    const ledger = testDb
      .select()
      .from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, client.id))
      .all();

    expect(ledger).toHaveLength(1);
    expect(ledger[0].changeAmount).toBe(-1);
    expect(ledger[0].balanceAfter).toBe(2);
    expect(ledger[0].appointmentId).toBe(appt.id);
    expect(ledger[0].reason).toBe("Session completed");
  });

  it("clamps balance to 0 when already at 0", async () => {
    const client = insertClient({ sessionsRemaining: 0 });
    const appt = insertAppointment(client.id);
    const result = await decrementSession(client.id, appt.id);

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(0);
  });

  it("treats null sessionsRemaining as 0 and clamps", async () => {
    const client = insertClient({
      sessionsRemaining: null as unknown as number,
    });
    const appt = insertAppointment(client.id);
    const result = await decrementSession(client.id, appt.id);

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(0);
  });

  it("returns error for nonexistent client", async () => {
    const result = await decrementSession(9999, 1);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Client not found");
  });
});

// ---------------------------------------------------------------------------
// addSessions
// ---------------------------------------------------------------------------
describe("addSessions", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("adds the specified amount to the balance", async () => {
    const client = insertClient({ sessionsRemaining: 2 });
    const result = await addSessions(client.id, 10, "Bought 10-pack");

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(12);

    const updated = testDb
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, client.id))
      .get()!;
    expect(updated.sessionsRemaining).toBe(12);
  });

  it("creates a ledger entry with the correct values", async () => {
    const client = insertClient({ sessionsRemaining: 0 });
    await addSessions(client.id, 5, "Gift sessions");

    const ledger = testDb
      .select()
      .from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, client.id))
      .all();

    expect(ledger).toHaveLength(1);
    expect(ledger[0].changeAmount).toBe(5);
    expect(ledger[0].balanceAfter).toBe(5);
    expect(ledger[0].reason).toBe("Gift sessions");
  });

  it("rejects amount of 0", async () => {
    const client = insertClient({ sessionsRemaining: 5 });
    const result = await addSessions(client.id, 0, "nope");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Amount must be positive");
  });

  it("rejects negative amount", async () => {
    const client = insertClient({ sessionsRemaining: 5 });
    const result = await addSessions(client.id, -3, "nope");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Amount must be positive");
  });

  it("returns error for nonexistent client", async () => {
    const result = await addSessions(9999, 5, "nope");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Client not found");
  });
});

// ---------------------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------------------
describe("getBalance", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("returns the correct session balance", async () => {
    const client = insertClient({ sessionsRemaining: 7 });
    const result = await getBalance(client.id);

    expect(result.balance).toBe(7);
    expect(result.error).toBeUndefined();
  });

  it("returns 0 when sessionsRemaining is null", async () => {
    const client = insertClient({
      sessionsRemaining: null as unknown as number,
    });
    const result = await getBalance(client.id);

    expect(result.balance).toBe(0);
  });

  it("returns error for nonexistent client", async () => {
    const result = await getBalance(9999);

    expect(result.balance).toBe(0);
    expect(result.error).toBe("Client not found");
  });
});
