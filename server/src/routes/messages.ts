import { Router, Request, Response } from "express";
import { eq, desc, like, and } from "drizzle-orm";
import db from "../db/index.js";
import { messages, clients } from "../db/schema.js";

const router = Router();

// GET /api/messages — list messages with filters
router.get("/", (req: Request, res: Response) => {
  try {
    const {
      clientId,
      search,
      limit: limitParam,
      offset: offsetParam,
    } = req.query;

    const limit = parseInt((limitParam as string) || "50", 10);
    const offset = parseInt((offsetParam as string) || "0", 10);

    let results;

    if (clientId) {
      const cid = parseInt(clientId as string, 10);
      if (search) {
        results = db
          .select({
            message: messages,
            clientName: clients.name,
          })
          .from(messages)
          .leftJoin(clients, eq(messages.clientId, clients.id))
          .where(
            and(
              eq(messages.clientId, cid),
              like(messages.body, `%${search}%`)
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      } else {
        results = db
          .select({
            message: messages,
            clientName: clients.name,
          })
          .from(messages)
          .leftJoin(clients, eq(messages.clientId, clients.id))
          .where(eq(messages.clientId, cid))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      }
    } else if (search) {
      results = db
        .select({
          message: messages,
          clientName: clients.name,
        })
        .from(messages)
        .leftJoin(clients, eq(messages.clientId, clients.id))
        .where(like(messages.body, `%${search}%`))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    } else {
      results = db
        .select({
          message: messages,
          clientName: clients.name,
        })
        .from(messages)
        .leftJoin(clients, eq(messages.clientId, clients.id))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    }

    res.json(results);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// GET /api/messages/client/:clientId — get conversation with client
router.get("/client/:clientId", (req: Request, res: Response) => {
  try {
    const clientId = parseInt(String(req.params.clientId), 10);
    if (isNaN(clientId)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const limit = parseInt((req.query.limit as string) || "100", 10);
    const offset = parseInt((req.query.offset as string) || "0", 10);

    const results = db
      .select()
      .from(messages)
      .where(eq(messages.clientId, clientId))
      .orderBy(messages.createdAt)
      .limit(limit)
      .offset(offset)
      .all();

    res.json(results);
  } catch (error) {
    console.error("Error fetching client messages:", error);
    res.status(500).json({ error: "Failed to fetch client messages" });
  }
});

// POST /api/messages — store a message
router.post("/", (req: Request, res: Response) => {
  try {
    const { clientId, direction, channel, senderType, body } = req.body;

    if (!direction || !channel || !senderType || !body) {
      res.status(400).json({
        error: "direction, channel, senderType, and body are required",
      });
      return;
    }

    const validDirections = ["inbound", "outbound"];
    const validChannels = ["sms", "web", "system"];
    const validSenderTypes = ["instructor", "client", "ai", "system"];

    if (!validDirections.includes(direction)) {
      res.status(400).json({ error: `direction must be one of: ${validDirections.join(", ")}` });
      return;
    }
    if (!validChannels.includes(channel)) {
      res.status(400).json({ error: `channel must be one of: ${validChannels.join(", ")}` });
      return;
    }
    if (!validSenderTypes.includes(senderType)) {
      res.status(400).json({ error: `senderType must be one of: ${validSenderTypes.join(", ")}` });
      return;
    }

    const result = db
      .insert(messages)
      .values({
        clientId: clientId || null,
        direction,
        channel,
        senderType,
        body,
      })
      .returning()
      .get();

    res.status(201).json(result);
  } catch (error) {
    console.error("Error storing message:", error);
    res.status(500).json({ error: "Failed to store message" });
  }
});

export default router;
