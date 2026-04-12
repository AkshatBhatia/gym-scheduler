import { Router, Request, Response } from "express";
import { eq, and, gte, lte, desc, ne } from "drizzle-orm";
import db from "../db/index.js";
import { appointments, clients } from "../db/schema.js";
import {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
} from "../services/scheduling.js";
import { decrementSession } from "../services/sessions.js";
import { utcToLocal, localToUTC, todayLocal } from "../services/timezone.js";

/** Convert appointment times from UTC to instructor's local timezone */
function localizeAppointment<T extends { startTime: string; endTime: string }>(appt: T): T {
  return {
    ...appt,
    startTime: utcToLocal(appt.startTime),
    endTime: utcToLocal(appt.endTime),
  };
}

/** Convert wrapped appointment rows */
function localizeRow(row: { appointment: any; clientName: string | null; clientPhone: string | null }) {
  return {
    ...row,
    appointment: localizeAppointment(row.appointment),
  };
}

const router = Router();

// GET /api/appointments — list appointments with filters
router.get("/", (req: Request, res: Response) => {
  try {
    const { date, week, clientId, status } = req.query;

    let results;

    if (date) {
      const dayStart = localToUTC(`${date}T00:00:00`);
      const dayEnd = localToUTC(`${date}T23:59:59`);
      results = db
        .select({
          appointment: appointments,
          clientName: clients.name,
          clientPhone: clients.phone,
        })
        .from(appointments)
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .where(
          and(
            gte(appointments.startTime, dayStart),
            lte(appointments.startTime, dayEnd),
            ...(status ? [eq(appointments.status, status as "confirmed" | "cancelled" | "no-show" | "completed")] : []),
            ...(clientId
              ? [eq(appointments.clientId, parseInt(String(clientId), 10))]
              : [])
          )
        )
        .orderBy(appointments.startTime)
        .all();
    } else if (week) {
      // week param is the start date of the week (Monday) in local time
      const weekStart = localToUTC(`${week}T00:00:00`);
      const weekEndDate = new Date(
        new Date(String(week)).getTime() + 6 * 24 * 60 * 60 * 1000
      );
      const weekEndStr = localToUTC(`${weekEndDate.toISOString().slice(0, 10)}T23:59:59`);

      results = db
        .select({
          appointment: appointments,
          clientName: clients.name,
          clientPhone: clients.phone,
        })
        .from(appointments)
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .where(
          and(
            gte(appointments.startTime, weekStart),
            lte(appointments.startTime, weekEndStr),
            ...(status ? [eq(appointments.status, status as "confirmed" | "cancelled" | "no-show" | "completed")] : []),
            ...(clientId
              ? [eq(appointments.clientId, parseInt(String(clientId), 10))]
              : [])
          )
        )
        .orderBy(appointments.startTime)
        .all();
    } else {
      results = db
        .select({
          appointment: appointments,
          clientName: clients.name,
          clientPhone: clients.phone,
        })
        .from(appointments)
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .where(
          and(
            ...(status ? [eq(appointments.status, status as "confirmed" | "cancelled" | "no-show" | "completed")] : []),
            ...(clientId
              ? [eq(appointments.clientId, parseInt(String(clientId), 10))]
              : [])
          )
        )
        .orderBy(desc(appointments.startTime))
        .all();
    }

    res.json(results.map(localizeRow));
  } catch (error) {
    console.error("Error fetching appointments:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// GET /api/appointments/today — today's appointments
router.get("/today", (_req: Request, res: Response) => {
  try {
    const today = todayLocal();
    const dayStart = localToUTC(`${today}T00:00:00`);
    const dayEnd = localToUTC(`${today}T23:59:59`);

    const results = db
      .select({
        appointment: appointments,
        clientName: clients.name,
        clientPhone: clients.phone,
      })
      .from(appointments)
      .leftJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, dayStart),
          lte(appointments.startTime, dayEnd),
          ne(appointments.status, "cancelled")
        )
      )
      .orderBy(appointments.startTime)
      .all();

    res.json(results.map(localizeRow));
  } catch (error) {
    console.error("Error fetching today's appointments:", error);
    res.status(500).json({ error: "Failed to fetch today's appointments" });
  }
});

// GET /api/appointments/week — this week's appointments
router.get("/week", (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStartDate = monday.toISOString().slice(0, 10);
    const weekEndDate = sunday.toISOString().slice(0, 10);
    const weekStart = localToUTC(`${weekStartDate}T00:00:00`);
    const weekEnd = localToUTC(`${weekEndDate}T23:59:59`);

    const results = db
      .select({
        appointment: appointments,
        clientName: clients.name,
        clientPhone: clients.phone,
      })
      .from(appointments)
      .leftJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, weekStart),
          lte(appointments.startTime, weekEnd),
          ne(appointments.status, "cancelled")
        )
      )
      .orderBy(appointments.startTime)
      .all();

    res.json(results.map(localizeRow));
  } catch (error) {
    console.error("Error fetching week's appointments:", error);
    res.status(500).json({ error: "Failed to fetch week's appointments" });
  }
});

// POST /api/appointments — create appointment
router.post("/", async (req: Request, res: Response) => {
  try {
    const { clientId, startTime, notes } = req.body;

    if (!clientId || !startTime) {
      res.status(400).json({ error: "clientId and startTime are required" });
      return;
    }

    // Convert local time to UTC (frontend sends localized times from availability slots)
    const utcStart = localToUTC(startTime);
    const result = await bookAppointment(clientId, utcStart, notes);

    if (!result.success) {
      res.status(409).json({ error: result.error });
      return;
    }

    res.status(201).json(result.appointment);
  } catch (error) {
    console.error("Error creating appointment:", error);
    res.status(500).json({ error: "Failed to create appointment" });
  }
});

// PUT /api/appointments/:id — update appointment
router.put("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid appointment ID" });
      return;
    }

    const existing = db
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }

    const { startTime, endTime, notes } = req.body;

    const result = db
      .update(appointments)
      .set({
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(notes !== undefined && { notes }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appointments.id, id))
      .returning()
      .get();

    res.json(result);
  } catch (error) {
    console.error("Error updating appointment:", error);
    res.status(500).json({ error: "Failed to update appointment" });
  }
});

// PUT /api/appointments/:id/status — update status
router.put("/:id/status", async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid appointment ID" });
      return;
    }

    const { status, reason } = req.body;
    const validStatuses = ["confirmed", "cancelled", "no-show", "completed"];

    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    if (status === "cancelled") {
      const result = await cancelAppointment(id, reason);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
    } else if (status === "completed") {
      const result = await completeAppointment(id);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
    } else if (status === "no-show") {
      // No-show still consumes a session
      const existing = db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
        .get();

      if (!existing) {
        res.status(404).json({ error: "Appointment not found" });
        return;
      }

      if (existing.status !== "confirmed") {
        res.status(400).json({ error: `Cannot mark as no-show from status '${existing.status}'` });
        return;
      }

      db.update(appointments)
        .set({ status: "no-show", updatedAt: new Date().toISOString() })
        .where(eq(appointments.id, id))
        .run();

      await decrementSession(existing.clientId, id);
    } else {
      // For confirmed, just update directly
      const existing = db
        .select()
        .from(appointments)
        .where(eq(appointments.id, id))
        .get();

      if (!existing) {
        res.status(404).json({ error: "Appointment not found" });
        return;
      }

      db.update(appointments)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(appointments.id, id))
        .run();
    }

    // Return updated appointment
    const updated = db
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .get();

    res.json(updated);
  } catch (error) {
    console.error("Error updating appointment status:", error);
    res.status(500).json({ error: "Failed to update appointment status" });
  }
});

export default router;
