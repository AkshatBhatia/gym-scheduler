import { Router, Request, Response } from "express";
import twilio from "twilio";
import { db } from "../db/index.js";
import { clients, messages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { chatAgent } from "../services/chat.js";

const router = Router();

// POST /api/sms/incoming — Twilio webhook for incoming SMS
router.post("/incoming", async (req: Request, res: Response) => {
  try {
    // Validate Twilio signature in production
    if (process.env.NODE_ENV === "production") {
      const twilioSignature = req.headers["x-twilio-signature"] as string;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const webhookUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

      if (authToken && twilioSignature) {
        const isValid = twilio.validateRequest(
          authToken,
          twilioSignature,
          webhookUrl,
          req.body
        );

        if (!isValid) {
          console.warn("[SMS Webhook] Invalid Twilio signature, rejecting.");
          res.status(403).send("Forbidden");
          return;
        }
      }
    }

    const from: string = req.body.From || "";
    const body: string = req.body.Body || "";
    const messageSid: string = req.body.MessageSid || "";

    if (!from || !body) {
      res.status(400).send("Missing From or Body");
      return;
    }

    console.log(`[SMS Webhook] From: ${from}, Body: ${body}`);

    // Look up if the sender is a known client
    const client = db
      .select()
      .from(clients)
      .where(eq(clients.phone, from))
      .get();

    // Determine sender type and store inbound message
    const instructorPhone = process.env.INSTRUCTOR_PHONE_NUMBER;
    const isInstructor = from === instructorPhone;
    const senderType = isInstructor
      ? ("instructor" as const)
      : client
        ? ("client" as const)
        : ("client" as const); // Unknown numbers treated as potential clients

    db.insert(messages)
      .values({
        clientId: client?.id || null,
        direction: "inbound",
        channel: "sms",
        senderType,
        body,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Route to appropriate handler
    let responseText: string;

    if (isInstructor) {
      // Instructor messages go to the AI chat agent
      responseText = await chatAgent.processInstructorMessage(body);
    } else if (client) {
      // Known client messages go to client handler
      responseText = await chatAgent.processClientMessage(from, body);
    } else {
      // Unknown number — public booking flow
      responseText = await chatAgent.processPublicMessage(from, body);
    }

    // Store the outbound AI response
    db.insert(messages)
      .values({
        clientId: client?.id || null,
        direction: "outbound",
        channel: "sms",
        senderType: "ai",
        body: responseText,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Return TwiML response
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(responseText)}</Message>
</Response>`;

    res.type("text/xml").send(twiml);
  } catch (error) {
    console.error("[SMS Webhook] Error processing incoming message:", error);

    // Return a friendly error message via TwiML
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Sorry, something went wrong. Please try again in a moment.</Message>
</Response>`;

    res.type("text/xml").send(twiml);
  }
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default router;
