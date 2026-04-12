import { Router, Request, Response } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import db from "../db/index.js";
import { availability, appointments } from "../db/schema.js";
import { getAvailableSlots } from "../services/scheduling.js";
import { localToUTC, utcToLocal } from "../services/timezone.js";

const router = Router();

// GET /api/availability — get all availability rules
router.get("/", (_req: Request, res: Response) => {
  try {
    const results = db.select().from(availability).all();
    res.json(results);
  } catch (error) {
    console.error("Error fetching availability:", error);
    res.status(500).json({ error: "Failed to fetch availability" });
  }
});

// GET /api/availability/slots?date=YYYY-MM-DD — get available slots for a date
router.get("/slots", async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "Valid date parameter (YYYY-MM-DD) is required" });
      return;
    }

    const slots = await getAvailableSlots(date);
    res.json(slots);
  } catch (error) {
    console.error("Error fetching available slots:", error);
    res.status(500).json({ error: "Failed to fetch available slots" });
  }
});

// POST /api/availability — create availability rule or override
router.post("/", (req: Request, res: Response) => {
  try {
    const { dayOfWeek, startTime, endTime, isBlocked, overrideDate } = req.body;

    if (startTime === undefined || endTime === undefined) {
      res.status(400).json({ error: "startTime and endTime are required" });
      return;
    }

    if (dayOfWeek === undefined && !overrideDate) {
      res.status(400).json({ error: "Either dayOfWeek or overrideDate is required" });
      return;
    }

    // Validate time format
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      res.status(400).json({ error: "Times must be in HH:MM format" });
      return;
    }

    if (startTime >= endTime) {
      res.status(400).json({ error: "startTime must be before endTime" });
      return;
    }

    const result = db
      .insert(availability)
      .values({
        dayOfWeek: dayOfWeek ?? null,
        startTime,
        endTime,
        isBlocked: isBlocked ? 1 : 0,
        overrideDate: overrideDate || null,
      })
      .returning()
      .get();

    // Check for conflicting confirmed appointments when blocking time
    let warning: string | undefined;
    if (isBlocked && overrideDate) {
      // Convert local day boundaries to UTC for proper query
      const dayStartUTC = localToUTC(overrideDate + "T00:00:00");
      const dayEndUTC = localToUTC(overrideDate + "T23:59:59");

      const dayAppointments = db
        .select()
        .from(appointments)
        .where(
          and(
            gte(appointments.startTime, dayStartUTC),
            lte(appointments.startTime, dayEndUTC),
            eq(appointments.status, "confirmed")
          )
        )
        .all();

      const conflicting = dayAppointments.filter((appt) => {
        // Convert appointment UTC time to local for comparison with block times
        const localStart = utcToLocal(appt.startTime);
        const localEnd = utcToLocal(appt.endTime);
        const apptStart = localStart.slice(11, 16);
        const apptEnd = localEnd.slice(11, 16);
        return apptStart < endTime && apptEnd > startTime;
      });

      if (conflicting.length > 0) {
        warning = `Warning: ${conflicting.length} confirmed appointment(s) overlap with this blocked time.`;
      }
    }

    res.status(201).json({ ...result, ...(warning && { warning }) });
  } catch (error) {
    console.error("Error creating availability:", error);
    res.status(500).json({ error: "Failed to create availability rule" });
  }
});

// PUT /api/availability/:id — update rule
router.put("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid availability ID" });
      return;
    }

    const existing = db
      .select()
      .from(availability)
      .where(eq(availability.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Availability rule not found" });
      return;
    }

    const { dayOfWeek, startTime, endTime, isBlocked, overrideDate } = req.body;

    if (startTime && endTime && startTime >= endTime) {
      res.status(400).json({ error: "startTime must be before endTime" });
      return;
    }

    const result = db
      .update(availability)
      .set({
        ...(dayOfWeek !== undefined && { dayOfWeek }),
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(isBlocked !== undefined && { isBlocked: isBlocked ? 1 : 0 }),
        ...(overrideDate !== undefined && { overrideDate }),
      })
      .where(eq(availability.id, id))
      .returning()
      .get();

    res.json(result);
  } catch (error) {
    console.error("Error updating availability:", error);
    res.status(500).json({ error: "Failed to update availability rule" });
  }
});

// DELETE /api/availability/:id — delete rule
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid availability ID" });
      return;
    }

    const existing = db
      .select()
      .from(availability)
      .where(eq(availability.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Availability rule not found" });
      return;
    }

    db.delete(availability).where(eq(availability.id, id)).run();
    res.json({ message: "Availability rule deleted successfully" });
  } catch (error) {
    console.error("Error deleting availability:", error);
    res.status(500).json({ error: "Failed to delete availability rule" });
  }
});

export default router;
