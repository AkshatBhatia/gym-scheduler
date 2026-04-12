# 01 — Data Model

## What

Core database schema for the Gym Scheduling Assistant. SQLite database accessed via **better-sqlite3** with **Drizzle ORM** for type-safe queries and migrations.

## How

### Tables

#### clients

| Column             | Type        | Constraints                                                    |
|--------------------|-------------|----------------------------------------------------------------|
| id                 | INTEGER     | PRIMARY KEY, autoincrement                                     |
| name               | TEXT        | NOT NULL                                                       |
| phone              | TEXT        | NOT NULL, UNIQUE (E.164 format)                                |
| email              | TEXT        | NULLABLE                                                       |
| notes              | TEXT        | NULLABLE, free-form instructor notes                           |
| package_type       | TEXT        | NOT NULL, CHECK IN ('single','5-pack','10-pack','20-pack','monthly') |
| sessions_remaining | INTEGER     | NOT NULL, DEFAULT 0 (ignored for monthly)                      |
| created_at         | TEXT        | NOT NULL, ISO-8601 default CURRENT_TIMESTAMP                   |
| updated_at         | TEXT        | NOT NULL, ISO-8601 default CURRENT_TIMESTAMP                   |

#### availability

| Column        | Type    | Constraints                                              |
|---------------|---------|----------------------------------------------------------|
| id            | INTEGER | PRIMARY KEY, autoincrement                               |
| day_of_week   | INTEGER | NOT NULL, CHECK 0-6 (0 = Sunday)                        |
| start_time    | TEXT    | NOT NULL, HH:MM 24-hr                                   |
| end_time      | TEXT    | NOT NULL, HH:MM 24-hr                                   |
| is_blocked    | INTEGER | NOT NULL, DEFAULT 0 (boolean; 1 = time-off block)       |
| override_date | TEXT    | NULLABLE, YYYY-MM-DD (null = recurring, set = one-off)  |

- Recurring rows define weekly defaults (override_date IS NULL).
- One-off overrides or blocks use a specific override_date.

#### appointments

| Column     | Type    | Constraints                                                        |
|------------|---------|--------------------------------------------------------------------|
| id         | INTEGER | PRIMARY KEY, autoincrement                                         |
| client_id  | INTEGER | NOT NULL, FK → clients.id                                          |
| start_time | TEXT    | NOT NULL, ISO-8601 datetime                                        |
| end_time   | TEXT    | NOT NULL, ISO-8601 datetime                                        |
| status     | TEXT    | NOT NULL, CHECK IN ('confirmed','cancelled','no-show','completed') |
| notes      | TEXT    | NULLABLE                                                           |
| created_at | TEXT    | NOT NULL, default CURRENT_TIMESTAMP                                |
| updated_at | TEXT    | NOT NULL, default CURRENT_TIMESTAMP                                |

- Index on (start_time, end_time) for overlap queries.
- Index on client_id.

#### session_ledger

| Column         | Type    | Constraints                                    |
|----------------|---------|------------------------------------------------|
| id             | INTEGER | PRIMARY KEY, autoincrement                     |
| client_id      | INTEGER | NOT NULL, FK → clients.id                      |
| appointment_id | INTEGER | NULLABLE, FK → appointments.id                 |
| change_amount  | INTEGER | NOT NULL (+1 for purchase, -1 for completion)  |
| balance_after  | INTEGER | NOT NULL                                       |
| reason         | TEXT    | NOT NULL (e.g. 'completed', 'package_purchase', 'manual_adjustment') |
| created_at     | TEXT    | NOT NULL, default CURRENT_TIMESTAMP            |

- Append-only audit log; never update or delete rows.

#### messages

| Column      | Type    | Constraints                                           |
|-------------|---------|-------------------------------------------------------|
| id          | INTEGER | PRIMARY KEY, autoincrement                            |
| client_id   | INTEGER | NULLABLE, FK → clients.id (null for instructor msgs)  |
| direction   | TEXT    | NOT NULL, CHECK IN ('inbound','outbound')             |
| channel     | TEXT    | NOT NULL, CHECK IN ('sms','web','system')             |
| sender_type | TEXT    | NOT NULL, CHECK IN ('instructor','client','ai','system') |
| body        | TEXT    | NOT NULL                                              |
| created_at  | TEXT    | NOT NULL, default CURRENT_TIMESTAMP                   |

- Index on client_id + created_at for conversation views.

#### voice_profile

| Column          | Type    | Constraints                          |
|-----------------|---------|--------------------------------------|
| id              | INTEGER | PRIMARY KEY, autoincrement           |
| sample_messages | TEXT    | NOT NULL, JSON array of strings      |
| tone_analysis   | TEXT    | NOT NULL, JSON object                |
| preferences     | TEXT    | NOT NULL, JSON object                |
| updated_at      | TEXT    | NOT NULL, default CURRENT_TIMESTAMP  |

- Singleton table — only one row expected.

### Drizzle Configuration

- Schema defined in `src/db/schema.ts` using Drizzle's SQLite column builders.
- Migrations generated via `drizzle-kit generate` and applied with `drizzle-kit push`.
- Database file stored at `data/gym.db` (gitignored; seeded on first run).

## Validation Plan

1. **Unit tests**: Insert, read, update, delete for every table; verify FK constraints and CHECK constraints reject bad data.
2. **Migration test**: Run `drizzle-kit push` on a fresh DB file; assert all tables and indexes exist.
3. **Ledger integrity**: Insert ledger entries and confirm balance_after matches cumulative sum of change_amount per client.
4. **Concurrency**: Verify better-sqlite3 WAL mode handles concurrent reads without errors.
