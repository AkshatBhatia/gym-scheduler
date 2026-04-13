import { eq, and, gte, lte, ne } from "drizzle-orm";
import db from "../db/index.js";
import { availability, appointments, clients } from "../db/schema.js";
import { localToUTC, utcToLocal } from "./timezone.js";
import { sendSms } from "./sms.js";

interface CancelledAppointment {
  appointmentId: number;
  clientId: number;
  clientName: string;
  clientPhone: string;
  startTime: string;
}

/**
 * Cancel confirmed appointments that conflict with new availability rules.
 * Sends SMS to each affected client.
 * Pre-fetches clients in batch and uses Promise.allSettled for SMS sends.
 */
async function cancelConflictingAppointments(
  conflicting: Array<{
    id: number;
    clientId: number;
    startTime: string;
    endTime: string;
  }>
): Promise<CancelledAppointment[]> {
  if (conflicting.length === 0) return [];

  // Cancel all appointments
  for (const appt of conflicting) {
    db.update(appointments)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, appt.id))
      .run();
  }

  // Pre-fetch all relevant clients in one query
  const uniqueClientIds = [...new Set(conflicting.map((a) => a.clientId))];
  const allClients = db.select().from(clients).all();
  const clientMap = new Map(allClients.filter((c) => uniqueClientIds.includes(c.id)).map((c) => [c.id, c]));

  const cancelled: CancelledAppointment[] = [];
  const smsPromises: Promise<void>[] = [];

  for (const appt of conflicting) {
    const client = clientMap.get(appt.clientId);
    if (!client) continue;

    const localTime = utcToLocal(appt.startTime);
    const dateStr = localTime.slice(0, 10);
    const timeStr = localTime.slice(11, 16);

    cancelled.push({
      appointmentId: appt.id,
      clientId: client.id,
      clientName: client.name,
      clientPhone: client.phone,
      startTime: localTime,
    });

    smsPromises.push(
      sendSms(
        client.phone,
        `Your appointment on ${dateStr} at ${timeStr} has been cancelled due to a schedule change. Please reach out to rebook.`
      ).catch((err) => {
        console.error(`Failed to send cancellation SMS to ${client.phone}:`, err);
      }) as Promise<void>
    );
  }

  // Send all SMS in parallel, don't fail on individual errors
  await Promise.allSettled(smsPromises);

  return cancelled;
}

/**
 * Set regular weekly availability hours. Replaces existing recurring rules
 * for the specified days. Cascades: cancels appointments that fall outside
 * the new hours.
 */
export async function setAvailability(
  rules: Array<{ dayOfWeek: number; startTime: string; endTime: string }>
): Promise<{ success: boolean; cancelledAppointments: CancelledAppointment[]; error?: string }> {
  // Validate times
  for (const rule of rules) {
    if (rule.startTime >= rule.endTime) {
      return { success: false, cancelledAppointments: [], error: "startTime must be before endTime" };
    }
  }

  const newDays = new Set(rules.map((r) => r.dayOfWeek));

  // Delete ALL existing recurring non-blocked, non-override entries.
  // setAvailability is a full replacement: days not in the input lose their availability.
  const existingRecurring = db
    .select()
    .from(availability)
    .all()
    .filter(
      (a) =>
        a.overrideDate === null &&
        a.isBlocked === 0
    );

  for (const row of existingRecurring) {
    db.delete(availability).where(eq(availability.id, row.id)).run();
  }

  // Insert new rules
  for (const rule of rules) {
    db.insert(availability)
      .values({
        dayOfWeek: rule.dayOfWeek,
        startTime: rule.startTime,
        endTime: rule.endTime,
        isBlocked: 0,
      })
      .run();
  }

  // Cascading: find future confirmed appointments that now fall outside availability
  const now = new Date().toISOString();
  const allFutureConfirmed = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "confirmed"),
        gte(appointments.startTime, now)
      )
    )
    .all();

  // Build a map of the new availability by day (this is the FULL set -- days not listed have no availability)
  const newAvailByDay = new Map<number, Array<{ startTime: string; endTime: string }>>();
  for (const rule of rules) {
    if (!newAvailByDay.has(rule.dayOfWeek)) {
      newAvailByDay.set(rule.dayOfWeek, []);
    }
    newAvailByDay.get(rule.dayOfWeek)!.push({ startTime: rule.startTime, endTime: rule.endTime });
  }

  // Pre-fetch all date overrides once to avoid N+1 in the filter callback
  const allDateOverrides = db.select().from(availability).all().filter(
    (a) => a.overrideDate !== null && !a.isBlocked
  );
  const overrideDates = new Set(allDateOverrides.map((a) => a.overrideDate));

  const conflicting = allFutureConfirmed.filter((appt) => {
    const localTime = utcToLocal(appt.startTime);
    const localEnd = utcToLocal(appt.endTime);
    const apptDate = new Date(localTime.slice(0, 10) + "T00:00:00");
    const dayOfWeek = apptDate.getDay();
    const apptStart = localTime.slice(11, 16);
    const apptEndTime = localEnd.slice(11, 16);

    // Check if there's a date-specific override for this date -- if so, skip (override takes precedence)
    const dateStr = localTime.slice(0, 10);
    if (overrideDates.has(dateStr)) return false; // date override handles this day

    const windows = newAvailByDay.get(dayOfWeek) || [];
    if (windows.length === 0) return true; // no availability for this day

    return !windows.some(
      (w) => apptStart >= w.startTime && apptEndTime <= w.endTime
    );
  });

  const cancelled = await cancelConflictingAppointments(conflicting);

  return { success: true, cancelledAppointments: cancelled };
}

/**
 * List all availability rules, separated into recurring, overrides, and blocks.
 */
export async function listAvailability(): Promise<{
  recurring: Array<typeof availability.$inferSelect>;
  overrides: Array<typeof availability.$inferSelect>;
  blocks: Array<typeof availability.$inferSelect>;
}> {
  const all = db.select().from(availability).all();

  return {
    recurring: all.filter((a) => a.overrideDate === null && !a.isBlocked),
    overrides: all.filter((a) => a.overrideDate !== null && !a.isBlocked),
    blocks: all.filter((a) => a.isBlocked === 1),
  };
}

/**
 * Create a one-off availability override for a specific date.
 * Replaces existing non-blocked overrides for that date.
 * Cascades: cancels appointments outside the new window.
 */
export async function overrideAvailability(
  date: string,
  startTime: string,
  endTime: string
): Promise<{ success: boolean; cancelledAppointments: CancelledAppointment[]; error?: string }> {
  if (startTime >= endTime) {
    return { success: false, cancelledAppointments: [], error: "startTime must be before endTime" };
  }

  // Delete existing non-blocked overrides for this date
  const existing = db
    .select()
    .from(availability)
    .all()
    .filter(
      (a) => a.overrideDate === date && a.isBlocked === 0
    );

  for (const row of existing) {
    db.delete(availability).where(eq(availability.id, row.id)).run();
  }

  // Insert new override
  db.insert(availability)
    .values({
      overrideDate: date,
      startTime,
      endTime,
      isBlocked: 0,
    })
    .run();

  // Cascading: find confirmed appointments on this date outside the new window
  const dayStart = localToUTC(`${date}T00:00:00`);
  const dayEnd = localToUTC(`${date}T23:59:59`);

  const dayAppts = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "confirmed"),
        gte(appointments.startTime, dayStart),
        lte(appointments.startTime, dayEnd)
      )
    )
    .all();

  const conflicting = dayAppts.filter((appt) => {
    const localTime = utcToLocal(appt.startTime);
    const localEndTime = utcToLocal(appt.endTime);
    const apptStart = localTime.slice(11, 16);
    const apptEnd = localEndTime.slice(11, 16);

    return !(apptStart >= startTime && apptEnd <= endTime);
  });

  const cancelled = await cancelConflictingAppointments(conflicting);

  return { success: true, cancelledAppointments: cancelled };
}

/**
 * Remove a blocked time entry. Only works on isBlocked=1 entries.
 */
export async function removeBlock(
  blockId: number
): Promise<{ success: boolean; error?: string }> {
  const existing = db
    .select()
    .from(availability)
    .where(eq(availability.id, blockId))
    .get();

  if (!existing) {
    return { success: false, error: "Block not found" };
  }

  if (!existing.isBlocked) {
    return { success: false, error: "This is not a blocked time entry" };
  }

  db.delete(availability).where(eq(availability.id, blockId)).run();

  return { success: true };
}
