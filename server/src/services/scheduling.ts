import { eq, and, gte, lte, ne } from "drizzle-orm";
import db from "../db/index.js";
import { availability, appointments, clients, sessionLedger } from "../db/schema.js";
import { decrementSession } from "./sessions.js";
import { getTimezone } from "./timezone.js";
import { DateTime } from "luxon";

interface TimeSlot {
  startTime: string;
  endTime: string;
  available: boolean;
}

/**
 * Get available 1-hour time slots for a given date.
 */
export async function getAvailableSlots(date: string): Promise<TimeSlot[]> {
  const dateObj = new Date(date + "T00:00:00");
  const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat

  // Get recurring availability rules for this day of week
  const recurringRules = db
    .select()
    .from(availability)
    .where(
      and(
        eq(availability.dayOfWeek, dayOfWeek),
        eq(availability.isBlocked, 0)
      )
    )
    .all();

  // Get date-specific overrides
  const overrides = db
    .select()
    .from(availability)
    .where(eq(availability.overrideDate, date))
    .all();

  // Separate overrides into availability overrides and blocks
  const availOverrides = overrides.filter((o) => !o.isBlocked);
  const blockedOverrides = overrides.filter((o) => o.isBlocked);
  const blockedRanges = blockedOverrides.map((b) => ({
    start: b.startTime,
    end: b.endTime,
  }));

  // Use availability overrides if present; otherwise use recurring rules.
  // Blocked overrides are always additive (they subtract from whatever base is used).
  const baseRules = availOverrides.length > 0 ? availOverrides : recurringRules;

  // Build available time ranges from base rules
  const availableRanges = baseRules.map((r) => ({
    start: r.startTime,
    end: r.endTime,
  }));

  if (availableRanges.length === 0) {
    return [];
  }

  // Generate 1-hour slots from available ranges
  const slots: TimeSlot[] = [];
  for (const range of availableRanges) {
    const [startHour, startMin] = range.start.split(":").map(Number);
    const [endHour, endMin] = range.end.split(":").map(Number);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    for (let mins = startMinutes; mins + 60 <= endMinutes; mins += 60) {
      const slotStartHour = Math.floor(mins / 60);
      const slotStartMin = mins % 60;
      const slotEndHour = Math.floor((mins + 60) / 60);
      const slotEndMin = (mins + 60) % 60;

      const slotStart = `${String(slotStartHour).padStart(2, "0")}:${String(slotStartMin).padStart(2, "0")}`;
      const slotEnd = `${String(slotEndHour).padStart(2, "0")}:${String(slotEndMin).padStart(2, "0")}`;

      // Check if slot is blocked
      const isBlocked = blockedRanges.some(
        (b) => slotStart < b.end && slotEnd > b.start
      );

      if (!isBlocked) {
        const slotStartISO = `${date}T${slotStart}:00`;
        const slotEndISO = `${date}T${slotEnd}:00`;

        slots.push({
          startTime: slotStartISO,
          endTime: slotEndISO,
          available: true,
        });
      }
    }
  }

  // Check existing appointments and mark slots as unavailable
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const existingAppointments = db
    .select()
    .from(appointments)
    .where(
      and(
        gte(appointments.startTime, dayStart),
        lte(appointments.startTime, dayEnd),
        ne(appointments.status, "cancelled")
      )
    )
    .all();

  for (const slot of slots) {
    const hasConflict = existingAppointments.some(
      (appt) => slot.startTime < appt.endTime && slot.endTime > appt.startTime
    );
    if (hasConflict) {
      slot.available = false;
    }
  }

  return slots;
}

/**
 * Book an appointment for a client.
 */
export async function bookAppointment(
  clientId: number,
  startTime: string,
  notes?: string
): Promise<{ success: boolean; appointment?: typeof appointments.$inferSelect; error?: string }> {
  // Validate client exists
  const client = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!client) {
    return { success: false, error: "Client not found" };
  }

  if (!client.active) {
    return { success: false, error: "Client is inactive" };
  }

  // Calculate end time (1 hour after start)
  const startDate = new Date(startTime);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  // BUG FIX #2: Always use full ISO with Z suffix for consistent UTC storage
  const normalizedStart = startDate.toISOString();
  const endTimeISO = endDate.toISOString();

  // BUG FIX #3: Reject bookings in the past
  if (startDate.getTime() < Date.now()) {
    return { success: false, error: "Cannot book appointments in the past" };
  }

  // Check for double booking
  const conflicts = db
    .select()
    .from(appointments)
    .where(
      and(
        ne(appointments.status, "cancelled"),
      )
    )
    .all()
    .filter(
      (appt) => appt.startTime < endTimeISO && appt.endTime > normalizedStart
    );

  if (conflicts.length > 0) {
    return { success: false, error: "Time slot is already booked" };
  }

  // BUG FIX #1: Check for blocked availability overrides
  const tz = getTimezone();
  const localDt = DateTime.fromISO(normalizedStart, { zone: "utc" }).setZone(tz);
  const dateStr = localDt.toISODate()!;
  const localStartTime = localDt.toFormat("HH:mm");
  const localEndTime = DateTime.fromISO(endTimeISO, { zone: "utc" }).setZone(tz).toFormat("HH:mm");

  // Check date-specific blocks
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

  for (const block of dateBlocks) {
    if (localStartTime < block.endTime && localEndTime > block.startTime) {
      return { success: false, error: `This time overlaps with blocked time (${block.startTime}-${block.endTime} on ${dateStr})` };
    }
  }

  // Check recurring blocks for this day of week
  const dayOfWeek = localDt.weekday % 7; // luxon: 1=Mon..7=Sun → 0=Sun
  const recurringBlocks = db
    .select()
    .from(availability)
    .where(
      and(
        eq(availability.dayOfWeek, dayOfWeek),
        eq(availability.isBlocked, 1)
      )
    )
    .all()
    .filter((r) => !r.overrideDate);

  for (const block of recurringBlocks) {
    if (localStartTime < block.endTime && localEndTime > block.startTime) {
      return { success: false, error: `This time overlaps with a recurring block (${block.startTime}-${block.endTime})` };
    }
  }

  // Check that appointment falls within an availability window
  // First check date-specific availability overrides (non-blocked)
  const dateAvailOverrides = db
    .select()
    .from(availability)
    .where(
      and(
        eq(availability.overrideDate, dateStr),
        eq(availability.isBlocked, 0)
      )
    )
    .all();

  // If there are date-specific availability overrides, use those; otherwise use recurring rules
  const availWindows = dateAvailOverrides.length > 0
    ? dateAvailOverrides
    : db
        .select()
        .from(availability)
        .where(
          and(
            eq(availability.dayOfWeek, dayOfWeek),
            eq(availability.isBlocked, 0)
          )
        )
        .all()
        .filter((r) => !r.overrideDate);

  // The appointment must be fully contained within at least one availability window
  const withinAvailability = availWindows.some(
    (w) => localStartTime >= w.startTime && localEndTime <= w.endTime
  );

  if (!withinAvailability) {
    return { success: false, error: "This time is outside available hours" };
  }

  // Create appointment with consistent UTC format
  const result = db
    .insert(appointments)
    .values({
      clientId,
      startTime: normalizedStart,
      endTime: endTimeISO,
      status: "confirmed",
      notes: notes || null,
    })
    .returning()
    .get();

  return { success: true, appointment: result };
}

/**
 * Cancel an appointment.
 */
export async function cancelAppointment(
  appointmentId: number,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const appointment = db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .get();

  if (!appointment) {
    return { success: false, error: "Appointment not found" };
  }

  if (appointment.status === "cancelled") {
    return { success: false, error: "Appointment is already cancelled" };
  }

  db.update(appointments)
    .set({
      status: "cancelled",
      notes: reason ? `${appointment.notes || ""}\nCancelled: ${reason}`.trim() : appointment.notes,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(appointments.id, appointmentId))
    .run();

  // Only refund session if the appointment was already completed
  // (since sessions are deducted on completion, not on booking)
  if (appointment.status === "completed") {
    const client = db
      .select()
      .from(clients)
      .where(eq(clients.id, appointment.clientId))
      .get();

    if (client && client.sessionsRemaining !== null) {
      const newBalance = (client.sessionsRemaining ?? 0) + 1;
      db.update(clients)
        .set({
          sessionsRemaining: newBalance,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(clients.id, client.id))
        .run();

      db.insert(sessionLedger)
        .values({
          clientId: client.id,
          appointmentId: appointmentId,
          changeAmount: 1,
          balanceAfter: newBalance,
          reason: "Cancellation refund",
        })
        .run();
    }
  }

  return { success: true };
}

/**
 * Complete an appointment and decrement session balance.
 */
export async function completeAppointment(
  appointmentId: number
): Promise<{ success: boolean; error?: string }> {
  const appointment = db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .get();

  if (!appointment) {
    return { success: false, error: "Appointment not found" };
  }

  if (appointment.status !== "confirmed") {
    return { success: false, error: `Cannot complete appointment with status '${appointment.status}'` };
  }

  db.update(appointments)
    .set({
      status: "completed",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(appointments.id, appointmentId))
    .run();

  // Decrement session
  await decrementSession(appointment.clientId, appointmentId);

  return { success: true };
}
