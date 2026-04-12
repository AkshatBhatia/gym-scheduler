import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import path from "path";
import fs from "fs";

const dbPath = process.env.DATABASE_URL || "./data/gym.db";
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, { schema });

function seed() {
  console.log("Seeding database...");

  // Create tables if they don't exist
  sqlite.exec(`
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

    CREATE TABLE IF NOT EXISTS voice_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_messages TEXT,
      tone_analysis TEXT,
      preferences TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default availability: Mon-Sat (1-6), 6am-6pm
  const existingAvailability = db
    .select()
    .from(schema.availability)
    .all();

  if (existingAvailability.length === 0) {
    console.log("Seeding default availability (Mon-Sat 6am-6pm)...");
    for (let day = 1; day <= 6; day++) {
      db.insert(schema.availability)
        .values({
          dayOfWeek: day,
          startTime: "06:00",
          endTime: "18:00",
          isBlocked: 0,
        })
        .run();
    }
  }

  // Seed sample clients
  const existingClients = db.select().from(schema.clients).all();

  if (existingClients.length === 0) {
    console.log("Seeding sample clients...");
    const sampleClients = [
      {
        name: "Sarah Johnson",
        phone: "+15551234567",
        email: "sarah@example.com",
        notes: "Prefers morning sessions. Working on upper body strength.",
        packageType: "10-pack" as const,
        sessionsRemaining: 7,
      },
      {
        name: "Mike Chen",
        phone: "+15559876543",
        email: "mike@example.com",
        notes: "Training for marathon. Focus on endurance.",
        packageType: "monthly" as const,
        sessionsRemaining: 20,
      },
      {
        name: "Emily Rodriguez",
        phone: "+15555551234",
        email: "emily@example.com",
        notes: "New client, initial assessment completed.",
        packageType: "5-pack" as const,
        sessionsRemaining: 4,
      },
      {
        name: "James Wilson",
        phone: "+15554443333",
        email: "james@example.com",
        notes: "Recovering from knee injury. Modified exercises only.",
        packageType: "20-pack" as const,
        sessionsRemaining: 15,
      },
    ];

    for (const client of sampleClients) {
      db.insert(schema.clients).values(client).run();
    }

    // Add session ledger entries for initial balances
    const insertedClients = db.select().from(schema.clients).all();
    for (const client of insertedClients) {
      db.insert(schema.sessionLedger)
        .values({
          clientId: client.id,
          changeAmount: client.sessionsRemaining ?? 0,
          balanceAfter: client.sessionsRemaining ?? 0,
          reason: "Initial package purchase",
        })
        .run();
    }
  }

  console.log("Seed complete!");
  sqlite.close();
}

seed();
