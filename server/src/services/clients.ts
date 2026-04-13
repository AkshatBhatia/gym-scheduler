import { eq, and, like, gte } from "drizzle-orm";
import db from "../db/index.js";
import { clients, appointments, recurringSchedules, sessionLedger, messages } from "../db/schema.js";

/**
 * List active clients, optionally filtered by name search.
 */
export async function listClients(
  search?: string
): Promise<Array<typeof clients.$inferSelect>> {
  if (search) {
    return db
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
  }

  return db
    .select()
    .from(clients)
    .where(eq(clients.active, 1))
    .orderBy(clients.name)
    .all();
}

/**
 * Update client details (name, phone, email, notes).
 * Does NOT allow updating sessionsRemaining — use update_client_sessions for that.
 */
export async function updateClient(
  clientId: number,
  updates: { name?: string; phone?: string; email?: string; notes?: string }
): Promise<{ success: boolean; error?: string }> {
  const existing = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!existing) {
    return { success: false, error: "Client not found" };
  }

  // Check for duplicate phone
  if (updates.phone && updates.phone !== existing.phone) {
    const dupe = db
      .select()
      .from(clients)
      .where(eq(clients.phone, updates.phone))
      .get();

    if (dupe) {
      return { success: false, error: "A client with this phone already exists" };
    }
  }

  // Strip sessionsRemaining if somehow passed
  const { name, phone, email, notes } = updates;

  db.update(clients)
    .set({
      ...(name !== undefined && { name }),
      ...(phone !== undefined && { phone }),
      ...(email !== undefined && { email }),
      ...(notes !== undefined && { notes }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(clients.id, clientId))
    .run();

  return { success: true };
}

/**
 * Reactivate a deactivated client.
 */
export async function reactivateClient(
  clientId: number
): Promise<{ success: boolean; error?: string }> {
  const existing = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!existing) {
    return { success: false, error: "Client not found" };
  }

  db.update(clients)
    .set({ active: 1, updatedAt: new Date().toISOString() })
    .where(eq(clients.id, clientId))
    .run();

  return { success: true };
}

/**
 * Permanently delete a client and all their related data.
 * Cascade: cancel future appointments → delete recurring schedules →
 * delete session ledger → delete messages → delete all appointments → delete client.
 * Returns the client record (for SMS before deletion).
 */
export async function deleteClient(
  clientId: number
): Promise<{ success: boolean; client?: typeof clients.$inferSelect; error?: string }> {
  const existing = db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();

  if (!existing) {
    return { success: false, error: "Client not found" };
  }

  const now = new Date().toISOString();

  // 1. Cancel all future confirmed appointments
  const futureAppts = db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, clientId),
        eq(appointments.status, "confirmed"),
        gte(appointments.startTime, now)
      )
    )
    .all();

  for (const appt of futureAppts) {
    db.update(appointments)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(appointments.id, appt.id))
      .run();
  }

  // 2. Delete all recurring schedules
  db.delete(recurringSchedules)
    .where(eq(recurringSchedules.clientId, clientId))
    .run();

  // 3. Delete all session ledger entries
  db.delete(sessionLedger)
    .where(eq(sessionLedger.clientId, clientId))
    .run();

  // 4. Delete all messages
  db.delete(messages)
    .where(eq(messages.clientId, clientId))
    .run();

  // 5. Delete all appointments (full history)
  db.delete(appointments)
    .where(eq(appointments.clientId, clientId))
    .run();

  // 6. Delete the client
  db.delete(clients)
    .where(eq(clients.id, clientId))
    .run();

  return { success: true, client: existing };
}
