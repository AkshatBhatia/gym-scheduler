import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for client management tools:
 *   - list_clients: list all active clients
 *   - update_client: edit name, phone, email, notes
 *   - reactivate_client: undo deactivation (set active=1)
 *
 * Expected service functions:
 *   listClients(search?: string): Promise<Client[]>
 *   updateClient(clientId: number, updates: Partial<Client>): Promise<{ success; error? }>
 *   reactivateClient(clientId: number): Promise<{ success; error? }>
 */

let testDb: ReturnType<typeof createTestDb>;

vi.mock("../db/index.js", () => ({
  get db() { return testDb.db; },
  get default() { return testDb.db; },
  get sqliteDb() { return testDb.sqlite; },
}));

// TODO: update imports once service functions are implemented
const { listClients, updateClient, reactivateClient, deleteClient } = await import("../services/clients.js");

describe("list_clients", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("returns all active clients", async () => {
    const result = await listClients();

    // Seed has 3 active + 1 inactive
    expect(result.length).toBe(3);
    for (const client of result) {
      expect(client.active).toBe(1);
    }
  });

  it("filters by search term (case-insensitive)", async () => {
    const result = await listClients("sarah");
    expect(result.length).toBe(1);
    expect(result[0].name).toContain("Sarah");
  });

  it("returns empty array when no clients match search", async () => {
    const result = await listClients("nonexistent");
    expect(result).toEqual([]);
  });

  it("does NOT include inactive clients", async () => {
    const result = await listClients();
    const inactive = result.find(c => c.name === "Inactive Joe");
    expect(inactive).toBeUndefined();
  });
});

describe("update_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("updates client name", async () => {
    const result = await updateClient(1, { name: "Sarah J." });
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.name).toBe("Sarah J.");
  });

  it("updates client phone", async () => {
    const result = await updateClient(1, { phone: "+15559999999" });
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.phone).toBe("+15559999999");
  });

  it("updates client email", async () => {
    const result = await updateClient(1, { email: "sarah@example.com" });
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.email).toBe("sarah@example.com");
  });

  it("updates client notes", async () => {
    const result = await updateClient(1, { notes: "Prefers morning sessions" });
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.notes).toBe("Prefers morning sessions");
  });

  it("updates multiple fields at once", async () => {
    const result = await updateClient(1, {
      name: "Sarah J.",
      email: "sarah@example.com",
      notes: "Updated",
    });
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.name).toBe("Sarah J.");
    expect(client.email).toBe("sarah@example.com");
    expect(client.notes).toBe("Updated");
  });

  it("does NOT allow updating sessionsRemaining via this tool", async () => {
    // Session balance should only be managed via update_client_sessions
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    const result = await updateClient(1, { sessionsRemaining: 999 } as any);

    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    // Balance should not change
    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
  });

  it("rejects if client does not exist", async () => {
    const result = await updateClient(999, { name: "Nobody" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects duplicate phone number", async () => {
    // Try to set Sarah's phone to Mike's phone
    const result = await updateClient(1, { phone: "+15559876543" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/duplicate|already exists|phone/i);
  });

  it("sets updatedAt timestamp", async () => {
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    await updateClient(1, { notes: "test" });
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;

    expect(after.updatedAt).not.toBe(before.updatedAt);
  });
});

describe("reactivate_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
  });

  it("sets active=1 on an inactive client", async () => {
    // Inactive Joe is client 4
    const result = await reactivateClient(4);
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 4)).get()!;
    expect(client.active).toBe(1);
  });

  it("is a no-op if client is already active", async () => {
    const result = await reactivateClient(1); // Sarah is already active
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get()!;
    expect(client.active).toBe(1);
  });

  it("rejects if client does not exist", async () => {
    const result = await reactivateClient(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("preserves existing session balance and data", async () => {
    const before = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 4)).get()!;
    await reactivateClient(4);
    const after = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 4)).get()!;

    expect(after.sessionsRemaining).toBe(before.sessionsRemaining);
    expect(after.name).toBe(before.name);
    expect(after.phone).toBe(before.phone);
  });
});

describe("delete_client", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);

    // Give Sarah (client 1) some related data
    testDb.db.insert(schema.recurringSchedules).values({
      clientId: 1, dayOfWeek: 1, startTime: "09:00", endTime: "10:00", active: 1,
    }).run();
    testDb.db.insert(schema.appointments).values([
      { clientId: 1, startTime: "2026-04-13T10:00:00.000Z", endTime: "2026-04-13T11:00:00.000Z", status: "confirmed" },
      { clientId: 1, startTime: "2026-04-06T10:00:00.000Z", endTime: "2026-04-06T11:00:00.000Z", status: "completed" },
    ]).run();
    testDb.db.insert(schema.sessionLedger).values({
      clientId: 1, changeAmount: -1, balanceAfter: 6, reason: "Session completed",
    }).run();
    testDb.db.insert(schema.messages).values({
      clientId: 1, direction: "inbound", channel: "sms", senderType: "client", body: "Hello",
    }).run();
  });

  it("deletes the client record", async () => {
    const result = await deleteClient(1);
    expect(result.success).toBe(true);

    const client = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 1)).get();
    expect(client).toBeUndefined();
  });

  it("returns the client record for SMS before deletion", async () => {
    const result = await deleteClient(1);
    expect(result.client).toBeDefined();
    expect(result.client!.name).toBe("Sarah Johnson");
    expect(result.client!.phone).toBe("+15551234567");
  });

  it("deletes all recurring schedules for the client", async () => {
    await deleteClient(1);

    const schedules = testDb.db.select().from(schema.recurringSchedules)
      .where(eq(schema.recurringSchedules.clientId, 1)).all();
    expect(schedules.length).toBe(0);
  });

  it("deletes all appointments (history) for the client", async () => {
    await deleteClient(1);

    const appts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 1)).all();
    expect(appts.length).toBe(0);
  });

  it("deletes all session ledger entries for the client", async () => {
    await deleteClient(1);

    const ledger = testDb.db.select().from(schema.sessionLedger)
      .where(eq(schema.sessionLedger.clientId, 1)).all();
    expect(ledger.length).toBe(0);
  });

  it("deletes all messages for the client", async () => {
    await deleteClient(1);

    const msgs = testDb.db.select().from(schema.messages)
      .where(eq(schema.messages.clientId, 1)).all();
    expect(msgs.length).toBe(0);
  });

  it("does NOT affect other clients' data", async () => {
    // Give Mike an appointment
    testDb.db.insert(schema.appointments).values({
      clientId: 2, startTime: "2026-04-13T14:00:00.000Z", endTime: "2026-04-13T15:00:00.000Z", status: "confirmed",
    }).run();

    await deleteClient(1);

    // Mike's data should be untouched
    const mike = testDb.db.select().from(schema.clients).where(eq(schema.clients.id, 2)).get();
    expect(mike).toBeDefined();

    const mikeAppts = testDb.db.select().from(schema.appointments)
      .where(eq(schema.appointments.clientId, 2)).all();
    expect(mikeAppts.length).toBe(1);
  });

  it("rejects if client does not exist", async () => {
    const result = await deleteClient(999);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
