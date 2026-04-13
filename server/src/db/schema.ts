import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").unique().notNull(),
  email: text("email"),
  notes: text("notes"),
  packageType: text("package_type", {
    enum: ["single", "5-pack", "10-pack", "20-pack", "monthly"],
  }),
  sessionsRemaining: integer("sessions_remaining").default(0),
  active: integer("active").default(1),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const availability = sqliteTable("availability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayOfWeek: integer("day_of_week"), // 0=Sunday, 6=Saturday
  startTime: text("start_time").notNull(), // HH:MM
  endTime: text("end_time").notNull(), // HH:MM
  isBlocked: integer("is_blocked").default(0),
  overrideDate: text("override_date"), // YYYY-MM-DD, nullable
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const appointments = sqliteTable("appointments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: integer("client_id")
    .notNull()
    .references(() => clients.id),
  startTime: text("start_time").notNull(), // ISO datetime
  endTime: text("end_time").notNull(), // ISO datetime
  status: text("status", {
    enum: ["confirmed", "cancelled", "no-show", "completed"],
  })
    .notNull()
    .default("confirmed"),
  recurringScheduleId: integer("recurring_schedule_id"),
  notes: text("notes"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const sessionLedger = sqliteTable("session_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: integer("client_id")
    .notNull()
    .references(() => clients.id),
  appointmentId: integer("appointment_id").references(() => appointments.id),
  changeAmount: integer("change_amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reason: text("reason"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: integer("client_id").references(() => clients.id),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  channel: text("channel", { enum: ["sms", "web", "system"] }).notNull(),
  senderType: text("sender_type", {
    enum: ["instructor", "client", "ai", "system"],
  }).notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const recurringSchedules = sqliteTable("recurring_schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: integer("client_id")
    .notNull()
    .references(() => clients.id),
  dayOfWeek: integer("day_of_week").notNull(), // 0=Sunday, 6=Saturday
  startTime: text("start_time").notNull(), // HH:MM
  endTime: text("end_time").notNull(), // HH:MM
  endDate: text("end_date"), // YYYY-MM-DD, nullable (null = no end)
  active: integer("active").default(1),
  notes: text("notes"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const instructor = sqliteTable("instructor", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").unique().notNull(),
  email: text("email"),
  businessName: text("business_name"),
  venmoHandle: text("venmo_handle"),
  timezone: text("timezone").default("America/Los_Angeles"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const otpCodes = sqliteTable("otp_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  phone: text("phone").notNull(),
  code: text("code").notNull(),
  expiresAt: text("expires_at").notNull(),
  used: integer("used").default(0),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const voiceProfile = sqliteTable("voice_profile", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sampleMessages: text("sample_messages"), // JSON string
  toneAnalysis: text("tone_analysis"), // JSON string
  preferences: text("preferences"), // JSON string
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});
