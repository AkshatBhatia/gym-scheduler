import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
    email TEXT, notes TEXT, package_type TEXT, sessions_remaining INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day_of_week INTEGER, start_time TEXT NOT NULL,
    end_time TEXT NOT NULL, is_blocked INTEGER DEFAULT 0, override_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
    start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
    recurring_schedule_id INTEGER, notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS session_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
    appointment_id INTEGER REFERENCES appointments(id), change_amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id),
    direction TEXT NOT NULL, channel TEXT NOT NULL, sender_type TEXT NOT NULL,
    body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS recurring_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
    day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    active INTEGER DEFAULT 1, notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS voice_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sample_messages TEXT, tone_analysis TEXT,
    preferences TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS instructor (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
    email TEXT, business_name TEXT, venmo_handle TEXT, timezone TEXT DEFAULT 'America/Los_Angeles',
    avatar_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, code TEXT NOT NULL,
    expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles');
`;

export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(MIGRATION_SQL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function seedTestData(db: ReturnType<typeof createTestDb>["db"]) {
  // Availability: Mon-Sat 6am-6pm
  for (let day = 1; day <= 6; day++) {
    db.insert(schema.availability).values({
      dayOfWeek: day, startTime: "06:00", endTime: "18:00", isBlocked: 0,
    }).run();
  }

  // Clients
  db.insert(schema.clients).values({
    name: "Sarah Johnson", phone: "+15551234567", packageType: "10-pack", sessionsRemaining: 7,
  }).run();
  db.insert(schema.clients).values({
    name: "Mike Chen", phone: "+15559876543", packageType: "monthly", sessionsRemaining: 20,
  }).run();
  db.insert(schema.clients).values({
    name: "Emily Rodriguez", phone: "+15555551234", packageType: "5-pack", sessionsRemaining: 4,
  }).run();
  // Inactive client
  db.insert(schema.clients).values({
    name: "Inactive Joe", phone: "+15550000000", active: 0, sessionsRemaining: 5,
  }).run();
}
