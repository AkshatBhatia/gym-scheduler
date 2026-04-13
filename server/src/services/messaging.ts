import { eq } from "drizzle-orm";
import db from "../db/index.js";
import { clients, messages } from "../db/schema.js";
import { sendSms } from "./sms.js";

/**
 * Send an SMS message to a client and store it in the messages table.
 */
export async function sendMessageToClient(
  clientId: number,
  body: string
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  if (!body || body.trim().length === 0) {
    return { success: false, error: "Message body cannot be empty" };
  }

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

  try {
    await sendSms(client.phone, body);
  } catch (err) {
    return { success: false, error: "Failed to send SMS" };
  }

  // Store in messages table
  const result = db
    .insert(messages)
    .values({
      clientId,
      direction: "outbound",
      channel: "sms",
      senderType: "instructor",
      body: body.trim(),
    })
    .run();

  return { success: true, messageId: Number(result.lastInsertRowid) };
}
