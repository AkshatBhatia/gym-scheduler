import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

/**
 * Run all migrations to ensure all tables exist.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */
export function runMigrations(dbPath?: string) {
  const resolvedPath = dbPath || process.env.DATABASE_URL || "./data/gym.db";
  const dbDir = path.dirname(resolvedPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
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

    CREATE TABLE IF NOT EXISTS availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week INTEGER,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_blocked INTEGER DEFAULT 0,
      override_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS appointments (
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

    CREATE TABLE IF NOT EXISTS session_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      appointment_id INTEGER REFERENCES appointments(id),
      change_amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recurring_schedules (
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

    CREATE TABLE IF NOT EXISTS instructor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      business_name TEXT,
      venmo_handle TEXT,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      avatar_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voice_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_messages TEXT,
      tone_analysis TEXT,
      preferences TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles');
  `);

  // Safe column additions for existing databases
  try { db.exec("ALTER TABLE recurring_schedules ADD COLUMN end_date TEXT"); } catch {}


  console.log("[DB] Migrations complete — all tables ready");
  db.close();
}
