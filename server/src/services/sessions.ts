import { eq } from "drizzle-orm";
import db from "../db/index.js";
import { clients, sessionLedger } from "../db/schema.js";
import { generateForClient } from "./recurring.js";

/**
 * Decrement a client's session balance by 1 and log to the ledger.
 */
export async function decrementSession(
  clientId: number,
  appointmentId: number,
  reason: string = "Session completed"
): Promise<{ success: boolean; newBalance: number; error?: string }> {
  const client = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!client) {
    return { success: false, newBalance: 0, error: "Client not found" };
  }

  const currentBalance = client.sessionsRemaining ?? 0;
  const newBalance = currentBalance - 1;

  // Update client balance
  db.update(clients)
    .set({
      sessionsRemaining: newBalance,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(clients.id, clientId))
    .run();

  // Create ledger entry
  db.insert(sessionLedger)
    .values({
      clientId,
      appointmentId,
      changeAmount: -1,
      balanceAfter: newBalance,
      reason,
    })
    .run();

  return { success: true, newBalance };
}

/**
 * Add sessions to a client's balance (e.g., package purchase).
 */
export async function addSessions(
  clientId: number,
  amount: number,
  reason: string
): Promise<{ success: boolean; newBalance: number; error?: string }> {
  if (amount <= 0) {
    return { success: false, newBalance: 0, error: "Amount must be positive" };
  }

  const client = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!client) {
    return { success: false, newBalance: 0, error: "Client not found" };
  }

  const currentBalance = client.sessionsRemaining ?? 0;
  const newBalance = currentBalance + amount;

  // Update client balance
  db.update(clients)
    .set({
      sessionsRemaining: newBalance,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(clients.id, clientId))
    .run();

  // Create ledger entry
  db.insert(sessionLedger)
    .values({
      clientId,
      changeAmount: amount,
      balanceAfter: newBalance,
      reason,
    })
    .run();

  // Auto-generate recurring appointments for the new balance
  await generateForClient(clientId);

  return { success: true, newBalance };
}

/**
 * Get current session balance for a client.
 */
export async function getBalance(
  clientId: number
): Promise<{ balance: number; error?: string }> {
  const client = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!client) {
    return { balance: 0, error: "Client not found" };
  }

  return { balance: client.sessionsRemaining ?? 0 };
}
