import { Router, Request, Response } from "express";
import { eq, and, gte, lte, ne, count, lte as ltEq } from "drizzle-orm";
import db from "../db/index.js";
import { appointments, clients } from "../db/schema.js";
import { localToUTC, utcToLocal, todayLocal } from "../services/timezone.js";

const router = Router();

// GET /api/dashboard/summary — today's stats
router.get("/summary", (_req: Request, res: Response) => {
  try {
    const today = todayLocal();
    const dayStart = localToUTC(`${today}T00:00:00`);
    const dayEnd = localToUTC(`${today}T23:59:59`);

    // Today's appointment count (non-cancelled)
    const todayAppointments = db
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

    // Total active clients
    const totalClients = db
      .select({ count: count() })
      .from(clients)
      .where(eq(clients.active, 1))
      .get();

    // This week's sessions (completed)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStart = localToUTC(monday.toISOString().slice(0, 10) + "T00:00:00");
    const weekEnd = localToUTC(sunday.toISOString().slice(0, 10) + "T23:59:59");

    const weekSessions = db
      .select({ count: count() })
      .from(appointments)
      .where(
        and(
          gte(appointments.startTime, weekStart),
          lte(appointments.startTime, weekEnd),
          ne(appointments.status, "cancelled")
        )
      )
      .get();

    // Upcoming appointments today (not yet completed/cancelled)
    const upcomingToday = db
      .select({
        appointment: appointments,
        clientName: clients.name,
      })
      .from(appointments)
      .leftJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, dayStart),
          lte(appointments.startTime, dayEnd),
          eq(appointments.status, "confirmed")
        )
      )
      .orderBy(appointments.startTime)
      .all();

    // Clients with 2 or fewer sessions remaining
    const lowBalanceClients = db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.active, 1),
          lte(clients.sessionsRemaining, 2)
        )
      )
      .all()
      .filter((c) => c.packageType !== 'monthly');

    res.json({
      todayAppointments: todayAppointments?.count ?? 0,
      totalClients: totalClients?.count ?? 0,
      weekSessions: weekSessions?.count ?? 0,
      upcomingToday: upcomingToday.map((row) => ({
        ...row,
        appointment: {
          ...row.appointment,
          startTime: utcToLocal(row.appointment.startTime),
          endTime: utcToLocal(row.appointment.endTime),
        },
      })),
      lowBalanceClients,
    });
  } catch (error) {
    console.error("Error fetching dashboard summary:", error);
    res.status(500).json({ error: "Failed to fetch dashboard summary" });
  }
});

// GET /api/dashboard/weekly — weekly calendar data
router.get("/weekly", (req: Request, res: Response) => {
  try {
    const startDate = req.query.start as string;
    const now = new Date();

    let monday: Date;
    if (startDate) {
      monday = new Date(startDate);
    } else {
      const dayOfWeek = now.getDay();
      monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    }

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStart = localToUTC(monday.toISOString().slice(0, 10) + "T00:00:00");
    const weekEnd = localToUTC(sunday.toISOString().slice(0, 10) + "T23:59:59");

    const weekAppointments = db
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
          lte(appointments.startTime, weekEnd)
        )
      )
      .orderBy(appointments.startTime)
      .all();

    // Group by day
    const days: Record<string, typeof weekAppointments> = {};
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      const dateStr = day.toISOString().slice(0, 10);
      days[dateStr] = [];
    }

    for (const appt of weekAppointments) {
      // Create a copy to avoid mutating the DB query result in-place
      const localizedAppt = {
        ...appt,
        appointment: {
          ...appt.appointment,
          startTime: utcToLocal(appt.appointment.startTime),
          endTime: utcToLocal(appt.appointment.endTime),
        },
      };
      const dateStr = localizedAppt.appointment.startTime.slice(0, 10);
      if (days[dateStr]) {
        days[dateStr].push(localizedAppt);
      }
    }

    res.json({
      weekStart: monday.toISOString().slice(0, 10),
      weekEnd: sunday.toISOString().slice(0, 10),
      days,
    });
  } catch (error) {
    console.error("Error fetching weekly data:", error);
    res.status(500).json({ error: "Failed to fetch weekly data" });
  }
});

export default router;
