import { Router, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import db from "../db/index.js";
import { recurringSchedules, clients } from "../db/schema.js";
import { generateForClient, generateAllRecurring } from "../services/recurring.js";

const router = Router();

// GET /api/recurring — list all recurring schedules
router.get("/", (_req: Request, res: Response) => {
  try {
    const results = db
      .select({
        schedule: recurringSchedules,
        clientName: clients.name,
        clientPhone: clients.phone,
      })
      .from(recurringSchedules)
      .leftJoin(clients, eq(recurringSchedules.clientId, clients.id))
      .orderBy(recurringSchedules.dayOfWeek, recurringSchedules.startTime)
      .all();

    res.json(results);
  } catch (error) {
    console.error("Error fetching recurring schedules:", error);
    res.status(500).json({ error: "Failed to fetch recurring schedules" });
  }
});

// GET /api/recurring/client/:clientId — get recurring schedules for a client
router.get("/client/:clientId", (req: Request, res: Response) => {
  try {
    const clientId = parseInt(String(req.params.clientId), 10);
    if (isNaN(clientId)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const results = db
      .select()
      .from(recurringSchedules)
      .where(eq(recurringSchedules.clientId, clientId))
      .orderBy(recurringSchedules.dayOfWeek, recurringSchedules.startTime)
      .all();

    res.json(results);
  } catch (error) {
    console.error("Error fetching client recurring schedules:", error);
    res.status(500).json({ error: "Failed to fetch recurring schedules" });
  }
});

// POST /api/recurring — create recurring schedule
router.post("/", async (req: Request, res: Response) => {
  try {
    const { clientId, dayOfWeek, startTime, endTime, notes } = req.body;

    if (clientId === undefined || dayOfWeek === undefined || !startTime || !endTime) {
      res.status(400).json({ error: "clientId, dayOfWeek, startTime, and endTime are required" });
      return;
    }

    // Validate client exists
    const client = db.select().from(clients).where(eq(clients.id, clientId)).get();
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Check for duplicate (same client, same day, same time)
    const existing = db
      .select()
      .from(recurringSchedules)
      .where(
        and(
          eq(recurringSchedules.clientId, clientId),
          eq(recurringSchedules.dayOfWeek, dayOfWeek),
          eq(recurringSchedules.startTime, startTime)
        )
      )
      .get();

    if (existing) {
      res.status(409).json({ error: "This client already has a recurring schedule at this time" });
      return;
    }

    const result = db
      .insert(recurringSchedules)
      .values({
        clientId,
        dayOfWeek,
        startTime,
        endTime,
        notes: notes || null,
        active: 1,
      })
      .returning()
      .get();

    // Auto-generate appointments based on client's remaining sessions
    const generated = await generateForClient(clientId);

    res.status(201).json({ schedule: result, generated });
  } catch (error) {
    console.error("Error creating recurring schedule:", error);
    res.status(500).json({ error: "Failed to create recurring schedule" });
  }
});

// PUT /api/recurring/:id — update recurring schedule
router.put("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid schedule ID" });
      return;
    }

    const existing = db
      .select()
      .from(recurringSchedules)
      .where(eq(recurringSchedules.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Recurring schedule not found" });
      return;
    }

    const { dayOfWeek, startTime, endTime, active, notes } = req.body;

    const result = db
      .update(recurringSchedules)
      .set({
        ...(dayOfWeek !== undefined && { dayOfWeek }),
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(active !== undefined && { active: active ? 1 : 0 }),
        ...(notes !== undefined && { notes }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(recurringSchedules.id, id))
      .returning()
      .get();

    res.json(result);
  } catch (error) {
    console.error("Error updating recurring schedule:", error);
    res.status(500).json({ error: "Failed to update recurring schedule" });
  }
});

// DELETE /api/recurring/:id — delete recurring schedule
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid schedule ID" });
      return;
    }

    const existing = db
      .select()
      .from(recurringSchedules)
      .where(eq(recurringSchedules.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Recurring schedule not found" });
      return;
    }

    db.delete(recurringSchedules).where(eq(recurringSchedules.id, id)).run();
    res.json({ message: "Recurring schedule deleted" });
  } catch (error) {
    console.error("Error deleting recurring schedule:", error);
    res.status(500).json({ error: "Failed to delete recurring schedule" });
  }
});

// POST /api/recurring/generate — manually generate appointments for all or specific client
router.post("/generate", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.body;
    const result = clientId
      ? await generateForClient(clientId)
      : await generateAllRecurring();
    res.json(result);
  } catch (error) {
    console.error("Error generating recurring appointments:", error);
    res.status(500).json({ error: "Failed to generate appointments" });
  }
});

export default router;
