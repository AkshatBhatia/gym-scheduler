import { eq, and, ne } from "drizzle-orm";
import db from "../db/index.js";
import { recurringSchedules, appointments, clients, availability } from "../db/schema.js";
import { localDateTimeToUTC, todayLocal } from "./timezone.js";

/**
 * Generate recurring appointments for a specific client based on their
 * sessions remaining. Creates one appointment per recurring slot until
 * sessions are used up.
 *
 * Called when:
 * - A recurring schedule is created or updated
 * - Sessions are added to a client (package purchase)
 */
export async function generateForClient(
  clientId: number
): Promise<{ created: number; skipped: number }> {
  const client = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!client) return { created: 0, skipped: 0 };

  // Monthly clients get 12 weeks out; others get as many as sessions remaining
  const isMonthly = client.packageType === "monthly";
  const sessionsLeft = isMonthly ? 999 : (client.sessionsRemaining ?? 0);

  if (sessionsLeft <= 0) return { created: 0, skipped: 0 };

  const schedules = db
    .select()
    .from(recurringSchedules)
    .where(
      and(
        eq(recurringSchedules.clientId, clientId),
        eq(recurringSchedules.active, 1)
      )
    )
    .all();

  if (schedules.length === 0) return { created: 0, skipped: 0 };

  // Count ALL future confirmed appointments (recurring + one-off)
  // because each one will consume a session when completed
  const now = new Date().toISOString();
  const allFutureConfirmed = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, clientId),
        eq(appointments.status, "confirmed")
      )
    )
    .all()
    .filter((a) => a.startTime > now);

  const slotsToFill = isMonthly
    ? 12 * schedules.length
    : sessionsLeft;
  let slotsRemaining = slotsToFill - allFutureConfirmed.length;

  if (slotsRemaining <= 0) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate week by week, cycling through all recurring slots each week
  const maxWeeks = isMonthly ? 12 : Math.ceil(slotsToFill / schedules.length) + 1;

  for (let week = 0; week < maxWeeks && slotsRemaining > 0; week++) {
    for (const schedule of schedules) {
      if (slotsRemaining <= 0) break;

      const targetDate = getNextDayOfWeek(today, schedule.dayOfWeek, week);
      // Skip dates in the past
      if (targetDate < today) continue;

      const dateStr = formatDate(targetDate);
      // Convert local time to UTC for storage
      const startISO = localDateTimeToUTC(dateStr, schedule.startTime);
      const endISO = localDateTimeToUTC(dateStr, schedule.endTime);

      // Check if appointment already exists at this time
      const existing = db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.clientId, clientId),
            eq(appointments.startTime, startISO),
            ne(appointments.status, "cancelled")
          )
        )
        .get();

      if (existing) {
        skipped++;
        continue;
      }

      // Check if this slot overlaps with any blocked availability
      const localStart = schedule.startTime; // HH:MM
      const localEnd = schedule.endTime;     // HH:MM

      // Date-specific blocks for this date
      const dateBlocks = db
        .select()
        .from(availability)
        .where(
          and(
            eq(availability.overrideDate, dateStr),
            eq(availability.isBlocked, 1)
          )
        )
        .all();

      const isDateBlocked = dateBlocks.some(
        (b) => localStart < b.endTime && localEnd > b.startTime
      );

      if (isDateBlocked) {
        skipped++;
        continue;
      }

      // Recurring blocks for this day-of-week (no overrideDate)
      const recurringBlocks = db
        .select()
        .from(availability)
        .where(
          and(
            eq(availability.dayOfWeek, schedule.dayOfWeek),
            eq(availability.isBlocked, 1)
          )
        )
        .all()
        .filter((r) => !r.overrideDate);

      const isRecurringBlocked = recurringBlocks.some(
        (b) => localStart < b.endTime && localEnd > b.startTime
      );

      if (isRecurringBlocked) {
        skipped++;
        continue;
      }

      db.insert(appointments)
        .values({
          clientId,
          startTime: startISO,
          endTime: endISO,
          status: "confirmed",
          recurringScheduleId: schedule.id,
          notes: schedule.notes || null,
        })
        .run();

      created++;
      slotsRemaining--;
    }
  }

  console.log(
    `[Recurring] ${client.name}: generated ${created}, skipped ${skipped} (${sessionsLeft} sessions left, ${allFutureConfirmed.length} already booked)`
  );
  return { created, skipped };
}

/**
 * Generate recurring appointments for ALL active clients.
 * Useful as a catch-all / manual trigger.
 */
export async function generateAllRecurring(): Promise<{ created: number; skipped: number }> {
  const clientIds = db
    .select({ clientId: recurringSchedules.clientId })
    .from(recurringSchedules)
    .where(eq(recurringSchedules.active, 1))
    .all()
    .map((r) => r.clientId);

  const uniqueIds = [...new Set(clientIds)];
  let totalCreated = 0;
  let totalSkipped = 0;

  for (const cid of uniqueIds) {
    const result = await generateForClient(cid);
    totalCreated += result.created;
    totalSkipped += result.skipped;
  }

  return { created: totalCreated, skipped: totalSkipped };
}

function getNextDayOfWeek(baseDate: Date, dayOfWeek: number, weekOffset: number): Date {
  const result = new Date(baseDate);
  const currentDay = result.getDay();
  let daysUntil = dayOfWeek - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  result.setDate(result.getDate() + daysUntil + weekOffset * 7);
  return result;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
