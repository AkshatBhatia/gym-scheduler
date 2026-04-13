import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createTestDb, seedTestData } from "./setup.js";

/**
 * Tests for send_message tool:
 *   - Sends SMS to a client via Twilio
 *   - Stores the outbound message in the messages table
 *   - Rejects if client not found or inactive
 *
 * Expected service function:
 *   sendMessageToClient(clientId: number, body: string):
 *     Promise<{ success: boolean; messageId?: number; error?: string }>
 */

let testDb: ReturnType<typeof createTestDb>;

vi.mock("../db/index.js", () => ({
  get db() { return testDb.db; },
  get default() { return testDb.db; },
  get sqliteDb() { return testDb.sqlite; },
}));

// Mock Twilio so we don't actually send SMS
const mockSend = vi.fn().mockResolvedValue({ sid: "SM_test_123" });
vi.mock("../services/sms.js", () => ({
  sendSms: mockSend,
}));

// TODO: update import once service function is implemented
const { sendMessageToClient } = await import("../services/messaging.js");

describe("send_message", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedTestData(testDb.db);
    mockSend.mockClear();
  });

  it("sends SMS to the client's phone number", async () => {
    const result = await sendMessageToClient(1, "Running 10 min late!");
    expect(result.success).toBe(true);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("+1555"), // Sarah's phone
      expect.stringContaining("Running 10 min late!")
    );
  });

  it("stores the message in the messages table", async () => {
    await sendMessageToClient(1, "See you tomorrow!");

    const msgs = testDb.db.select().from(schema.messages)
      .where(eq(schema.messages.clientId, 1))
      .all();

    const outbound = msgs.filter(m => m.direction === "outbound");
    expect(outbound.length).toBeGreaterThanOrEqual(1);

    const latest = outbound[outbound.length - 1];
    expect(latest.body).toContain("See you tomorrow!");
    expect(latest.senderType).toBe("instructor");
    expect(latest.channel).toBe("sms");
  });

  it("rejects if client does not exist", async () => {
    const result = await sendMessageToClient(999, "Hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects if client is inactive", async () => {
    const result = await sendMessageToClient(4, "Hello"); // Inactive Joe
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inactive|not found/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects if message body is empty", async () => {
    const result = await sendMessageToClient(1, "");
    expect(result.success).toBe(false);
  });

  it("returns error if Twilio send fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("Twilio error"));

    const result = await sendMessageToClient(1, "Test message");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/send|twilio|failed/i);
  });
});
