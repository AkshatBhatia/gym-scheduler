import twilio from "twilio";

export interface SmsProvider {
  sendMessage(to: string, body: string): Promise<{ sid: string }>;
}

export class TwilioProvider implements SmsProvider {
  private client: twilio.Twilio;
  private fromNumber: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !phoneNumber) {
      throw new Error(
        "Missing Twilio credentials. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
      );
    }

    this.client = twilio(accountSid, authToken);
    this.fromNumber = phoneNumber;
  }

  async sendMessage(to: string, body: string): Promise<{ sid: string }> {
    const message = await this.client.messages.create({
      to,
      from: this.fromNumber,
      body,
    });
    return { sid: message.sid };
  }
}

export class MockSmsProvider implements SmsProvider {
  async sendMessage(to: string, body: string): Promise<{ sid: string }> {
    const sid = `MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[MockSMS] To: ${to}`);
    console.log(`[MockSMS] Body: ${body}`);
    console.log(`[MockSMS] SID: ${sid}`);
    console.log("---");
    return { sid };
  }
}

function createSmsProvider(): SmsProvider {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const phone = process.env.TWILIO_PHONE_NUMBER;

  if (sid && token && phone && sid !== "xxx" && token !== "xxx") {
    console.log("[SMS] Using Twilio SMS provider");
    return new TwilioProvider();
  }
  console.log("[SMS] Using mock SMS provider (set TWILIO credentials to enable real SMS)");
  return new MockSmsProvider();
}

export const smsProvider = createSmsProvider();

/**
 * Convenience wrapper for sending SMS. Tests mock this named export.
 */
export async function sendSms(to: string, body: string): Promise<{ sid: string }> {
  return smsProvider.sendMessage(to, body);
}
