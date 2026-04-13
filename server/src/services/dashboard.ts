import { eq, and, gte, lte, ne, count } from "drizzle-orm";
import db from "../db/index.js";
import { appointments, clients } from "../db/schema.js";
import { localToUTC, utcToLocal, todayLocal, formatDateYMD } from "./timezone.js";

/**
 * Get today's summary: appointment count, upcoming list, low-balance alerts.
 */
export async function getDailySummary(): Promise<{
  todayCount: number;
  upcoming: Array<{ clientName: string; startTime: string; endTime: string; status: string }>;
  lowBalanceClients: Array<{ id: number; name: string; sessionsRemaining: number; packageType: string | null }>;
}> {
  const today = todayLocal();
  const dayStart = localToUTC(`${today}T00:00:00`);
  const dayEnd = localToUTC(`${today}T23:59:59`);

  // Today's non-cancelled appointment count
  const countResult = db
    .select({ count: count() })
    .from(appointments)
    .where(
      and(
        gte(appointments.startTime, dayStart),
        lte(appointments.startTime, dayEnd),
        ne(appointments.status, "cancelled")
      )
    )
    .get();

  // Upcoming confirmed appointments with client names
  const upcoming = db
    .select({
      clientName: clients.name,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(clients, eq(appointments.clientId, clients.id))
    .where(
      and(
        gte(appointments.startTime, dayStart),
        lte(appointments.startTime, dayEnd),
        eq(appointments.status, "confirmed")
      )
    )
    .orderBy(appointments.startTime)
    .all()
    .map((row) => ({
      ...row,
      clientName: row.clientName ?? "Unknown",
      startTime: utcToLocal(row.startTime),
      endTime: utcToLocal(row.endTime),
    }));

  // Active clients with low balance (≤ 2)
  const lowBalanceClients = db
    .select()
    .from(clients)
    .where(eq(clients.active, 1))
    .all()
    .filter((c) => (c.sessionsRemaining ?? 0) <= 2)
    .map((c) => ({
      id: c.id,
      name: c.name,
      sessionsRemaining: c.sessionsRemaining ?? 0,
      packageType: c.packageType,
    }));

  return {
    todayCount: countResult?.count ?? 0,
    upcoming,
    lowBalanceClients,
  };
}

/**
 * Get weekly summary: appointments grouped by day, total count.
 */
export async function getWeeklySummary(
  weekStart?: string
): Promise<{
  days: Record<string, number>;
  totalCount: number;
}> {
  const today = todayLocal();
  const todayDate = new Date(today + "T00:00:00");
  const dayOfWeek = todayDate.getDay();

  let monday: Date;
  if (weekStart) {
    monday = new Date(weekStart + "T00:00:00");
  } else {
    monday = new Date(todayDate);
    monday.setDate(todayDate.getDate() - ((dayOfWeek + 6) % 7));
  }

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const mondayStr = formatDate(monday);
  const sundayStr = formatDate(sunday);
  const weekStartUTC = localToUTC(`${mondayStr}T00:00:00`);
  const weekEndUTC = localToUTC(`${sundayStr}T23:59:59`);

  const weekAppts = db
    .select()
    .from(appointments)
    .where(
      and(
        gte(appointments.startTime, weekStartUTC),
        lte(appointments.startTime, weekEndUTC),
        ne(appointments.status, "cancelled")
      )
    )
    .all();

  // Build 7-day structure
  const days: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    days[formatDate(day)] = 0;
  }

  for (const appt of weekAppts) {
    const localTime = utcToLocal(appt.startTime);
    const dateStr = localTime.slice(0, 10);
    if (days[dateStr] !== undefined) {
      days[dateStr]++;
    }
  }

  return {
    days,
    totalCount: weekAppts.length,
  };
}

// Use shared formatDateYMD from timezone.ts
const formatDate = formatDateYMD;
