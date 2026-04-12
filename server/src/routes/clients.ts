import { Router, Request, Response } from "express";
import { eq, like, desc, and } from "drizzle-orm";
import db from "../db/index.js";
import { clients, appointments } from "../db/schema.js";

const router = Router();

// GET /api/clients — list all clients (with optional search)
router.get("/", (_req: Request, res: Response) => {
  try {
    const search = _req.query.search as string | undefined;

    let results;
    if (search) {
      results = db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.active, 1),
            like(clients.name, `%${search}%`)
          )
        )
        .orderBy(clients.name)
        .all();
    } else {
      results = db
        .select()
        .from(clients)
        .where(eq(clients.active, 1))
        .orderBy(clients.name)
        .all();
    }

    res.json(results);
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ error: "Failed to fetch clients" });
  }
});

// GET /api/clients/:id — get single client with appointment history
router.get("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const client = db
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .get();

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const appointmentHistory = db
      .select()
      .from(appointments)
      .where(eq(appointments.clientId, id))
      .orderBy(desc(appointments.startTime))
      .all();

    res.json({ ...client, appointments: appointmentHistory });
  } catch (error) {
    console.error("Error fetching client:", error);
    res.status(500).json({ error: "Failed to fetch client" });
  }
});

// POST /api/clients — create client
router.post("/", (req: Request, res: Response) => {
  try {
    const { name, phone, email, notes, packageType, sessionsRemaining } = req.body;

    if (!name || !phone) {
      res.status(400).json({ error: "Name and phone are required" });
      return;
    }

    // Check for duplicate phone
    const existing = db
      .select()
      .from(clients)
      .where(eq(clients.phone, phone))
      .get();

    if (existing) {
      res.status(409).json({ error: "A client with this phone number already exists" });
      return;
    }

    const result = db
      .insert(clients)
      .values({
        name,
        phone,
        email: email || null,
        notes: notes || null,
        packageType: packageType || null,
        sessionsRemaining: sessionsRemaining || 0,
      })
      .returning()
      .get();

    res.status(201).json(result);
  } catch (error) {
    console.error("Error creating client:", error);
    res.status(500).json({ error: "Failed to create client" });
  }
});

// PUT /api/clients/:id — update client
router.put("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const existing = db
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const { name, phone, email, notes, packageType, sessionsRemaining, active } = req.body;

    const result = db
      .update(clients)
      .set({
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(notes !== undefined && { notes }),
        ...(packageType !== undefined && { packageType }),
        ...(sessionsRemaining !== undefined && { sessionsRemaining }),
        ...(active !== undefined && { active }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(clients.id, id))
      .returning()
      .get();

    res.json(result);
  } catch (error) {
    console.error("Error updating client:", error);
    res.status(500).json({ error: "Failed to update client" });
  }
});

// DELETE /api/clients/:id — soft delete (set active=0)
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const existing = db
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    db.update(clients)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(clients.id, id))
      .run();

    res.json({ message: "Client deactivated successfully" });
  } catch (error) {
    console.error("Error deleting client:", error);
    res.status(500).json({ error: "Failed to delete client" });
  }
});

export default router;
