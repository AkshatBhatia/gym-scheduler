import { eq, and, ne, gte, lte } from "drizzle-orm";
import db from "../db/index.js";
import { recurringSchedules, appointments, clients, availability } from "../db/schema.js";
import { localDateTimeToUTC, todayLocal, formatDateYMD } from "./timezone.js";

/**
 * Generate recurring appointments for a specific client on a 12-week
 * rolling horizon. Generation is NOT limited by sessionsRemaining --
 * recurring slots act as calendar holds to protect the client's time.
 *
 * Called when:
 * - A recurring schedule is created or updated
 * - Sessions are added to a client (package purchase)
 * - Background cron extends the horizon
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

  let created = 0;
  let skipped = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxWeeks = 12;

  // Compute the date range for the 12-week horizon
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + maxWeeks * 7);
  const horizonStartStr = formatDateYMD(today);
  const horizonEndStr = formatDateYMD(horizonEnd);

  // Hoist: fetch ALL availability rules once
  const allAvailRules = db.select().from(availability).all();

  // Hoist: fetch ALL non-cancelled appointments in the horizon
  // Use the earliest possible UTC start (midnight local on today) and latest possible end
  const horizonStartISO = new Date(horizonStartStr + "T00:00:00Z").toISOString();
  const horizonEndISO = new Date(horizonEndStr + "T23:59:59Z").toISOString();
  const allAppointments = db
    .select()
    .from(appointments)
    .where(
      and(
        ne(appointments.status, "cancelled"),
        gte(appointments.endTime, horizonStartISO),
        lte(appointments.startTime, horizonEndISO)
      )
    )
    .all();

  for (let week = 0; week < maxWeeks; week++) {
    for (const schedule of schedules) {
      const targetDate = getNextDayOfWeek(today, schedule.dayOfWeek, week);
      // Skip dates in the past
      if (targetDate < today) continue;
      // Skip dates past the schedule's end date
      if (schedule.endDate && formatDateYMD(targetDate) > schedule.endDate) continue;

      const dateStr = formatDateYMD(targetDate);
      const localStart = schedule.startTime; // HH:MM
      const localEnd = schedule.endTime;     // HH:MM

      // Check if slot falls within an availability window for this day
      // Date-specific availability overrides take precedence
      const dateAvailOverrides = allAvailRules.filter(
        (a) => a.overrideDate === dateStr && !a.isBlocked
      );

      const availWindows = dateAvailOverrides.length > 0
        ? dateAvailOverrides
        : allAvailRules.filter(
            (a) => a.dayOfWeek === schedule.dayOfWeek && !a.isBlocked && !a.overrideDate
          );

      const withinAvailability = availWindows.some(
        (w) => localStart >= w.startTime && localEnd <= w.endTime
      );

      if (!withinAvailability) {
        skipped++;
        continue;
      }

      // Convert local time to UTC for storage
      const startISO = localDateTimeToUTC(dateStr, schedule.startTime);
      const endISO = localDateTimeToUTC(dateStr, schedule.endTime);

      // Check if this client already has an appointment at this time
      const existingOwn = allAppointments.find(
        (a) => a.clientId === clientId && a.startTime === startISO
      );

      if (existingOwn) {
        skipped++;
        continue;
      }

      // Check for double-booking across ALL clients
      const hasConflict = allAppointments.some(
        (a) => a.startTime < endISO && a.endTime > startISO
      );

      if (hasConflict) {
        skipped++;
        continue;
      }

      // Check date-specific blocks
      const dateBlocks = allAvailRules.filter(
        (a) => a.overrideDate === dateStr && a.isBlocked === 1
      );

      const isDateBlocked = dateBlocks.some(
        (b) => localStart < b.endTime && localEnd > b.startTime
      );

      if (isDateBlocked) {
        skipped++;
        continue;
      }

      // Recurring blocks for this day-of-week (no overrideDate)
      const recurringBlocks = allAvailRules.filter(
        (a) => a.dayOfWeek === schedule.dayOfWeek && a.isBlocked === 1 && !a.overrideDate
      );

      const isRecurringBlocked = recurringBlocks.some(
        (b) => localStart < b.endTime && localEnd > b.startTime
      );

      if (isRecurringBlocked) {
        skipped++;
        continue;
      }

      const newAppt = {
        clientId,
        startTime: startISO,
        endTime: endISO,
        status: "confirmed" as const,
        recurringScheduleId: schedule.id,
        notes: schedule.notes || null,
      };

      db.insert(appointments)
        .values(newAppt)
        .run();

      // Add to in-memory list so subsequent iterations see it
      allAppointments.push({
        ...newAppt,
        id: 0, // placeholder; exact id not needed for conflict checks
        updatedAt: null,
        createdAt: new Date().toISOString(),
      });

      created++;
    }
  }

  return { created, skipped };
}

/**
 * List recurring schedules, optionally filtered by client.
 */
export async function listRecurringSchedules(
  clientId?: number
): Promise<Array<typeof recurringSchedules.$inferSelect & { clientName?: string | null }>> {
  if (clientId) {
    return db
      .select({
        id: recurringSchedules.id,
        clientId: recurringSchedules.clientId,
        clientName: clients.name,
        dayOfWeek: recurringSchedules.dayOfWeek,
        startTime: recurringSchedules.startTime,
        endTime: recurringSchedules.endTime,
        endDate: recurringSchedules.endDate,
        active: recurringSchedules.active,
        notes: recurringSchedules.notes,
        createdAt: recurringSchedules.createdAt,
        updatedAt: recurringSchedules.updatedAt,
      })
      .from(recurringSchedules)
      .leftJoin(clients, eq(recurringSchedules.clientId, clients.id))
      .where(eq(recurringSchedules.clientId, clientId))
      .orderBy(recurringSchedules.dayOfWeek, recurringSchedules.startTime)
      .all();
  }

  return db
    .select({
      id: recurringSchedules.id,
      clientId: recurringSchedules.clientId,
      clientName: clients.name,
      dayOfWeek: recurringSchedules.dayOfWeek,
      startTime: recurringSchedules.startTime,
      endTime: recurringSchedules.endTime,
      endDate: recurringSchedules.endDate,
      active: recurringSchedules.active,
      notes: recurringSchedules.notes,
      createdAt: recurringSchedules.createdAt,
      updatedAt: recurringSchedules.updatedAt,
    })
    .from(recurringSchedules)
    .leftJoin(clients, eq(recurringSchedules.clientId, clients.id))
    .orderBy(recurringSchedules.dayOfWeek, recurringSchedules.startTime)
    .all();
}

/**
 * Update a recurring schedule's day/time. Validates against availability,
 * then regenerates future appointments.
 */
export async function updateRecurringSchedule(
  id: number,
  updates: { dayOfWeek?: number; startTime?: string; endTime?: string }
): Promise<{ success: boolean; error?: string }> {
  const existing = db
    .select()
    .from(recurringSchedules)
    .where(eq(recurringSchedules.id, id))
    .get();

  if (!existing) {
    return { success: false, error: "Recurring schedule not found" };
  }

  const newDay = updates.dayOfWeek ?? existing.dayOfWeek;
  const newStart = updates.startTime ?? existing.startTime;
  const newEnd = updates.endTime ?? existing.endTime;

  // Availability gate: check the new day/time falls within availability
  const availWindows = db
    .select()
    .from(availability)
    .where(
      and(
        eq(availability.dayOfWeek, newDay),
        eq(availability.isBlocked, 0)
      )
    )
    .all()
    .filter((r) => !r.overrideDate);

  const withinAvail = availWindows.some(
    (w) => newStart >= w.startTime && newEnd <= w.endTime
  );

  if (!withinAvail) {
    return { success: false, error: "No availability for this day/time. Set your hours first." };
  }

  // Update the schedule
  db.update(recurringSchedules)
    .set({
      ...(updates.dayOfWeek !== undefined && { dayOfWeek: updates.dayOfWeek }),
      ...(updates.startTime !== undefined && { startTime: updates.startTime }),
      ...(updates.endTime !== undefined && { endTime: updates.endTime }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(recurringSchedules.id, id))
    .run();

  // Delete future confirmed recurring appointments for this client and regenerate
  const now = new Date().toISOString();
  const futureRecurring = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, existing.clientId),
        eq(appointments.status, "confirmed")
      )
    )
    .all()
    .filter((a) => a.recurringScheduleId != null && a.startTime > now);

  for (const appt of futureRecurring) {
    db.delete(appointments).where(eq(appointments.id, appt.id)).run();
  }

  await generateForClient(existing.clientId);

  return { success: true };
}

/**
 * Delete a recurring schedule and cancel all its future appointments.
 */
export async function deleteRecurringSchedule(
  id: number
): Promise<{ success: boolean; error?: string }> {
  const existing = db
    .select()
    .from(recurringSchedules)
    .where(eq(recurringSchedules.id, id))
    .get();

  if (!existing) {
    return { success: false, error: "Recurring schedule not found" };
  }

  // Cancel all future confirmed appointments for this schedule
  const now = new Date().toISOString();
  const futureAppts = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.recurringScheduleId, id),
        eq(appointments.status, "confirmed")
      )
    )
    .all()
    .filter((a) => a.startTime > now);

  for (const appt of futureAppts) {
    db.update(appointments)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, appt.id))
      .run();
  }

  // Delete the schedule
  db.delete(recurringSchedules).where(eq(recurringSchedules.id, id)).run();

  return { success: true };
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
