import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { appointments, clients, messages } from "../db/schema.js";
import { eq, and, gte, lte } from "drizzle-orm";
import { smsProvider } from "./sms.js";
import { voiceProfileService } from "./voice.js";

export class ConfirmationService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  async sendConfirmations(): Promise<void> {
    // Calculate tomorrow's date range
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];
    const tomorrowStart = `${tomorrowStr}T00:00:00`;
    const tomorrowEnd = `${tomorrowStr}T23:59:59`;

    // 1. Get tomorrow's confirmed appointments
    const tomorrowAppointments = db
      .select({
        appointmentId: appointments.id,
        clientId: clients.id,
        clientName: clients.name,
        clientPhone: clients.phone,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        notes: appointments.notes,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, tomorrowStart),
          lte(appointments.startTime, tomorrowEnd),
          eq(appointments.status, "confirmed")
        )
      )
      .all();

    if (tomorrowAppointments.length === 0) {
      console.log("[Confirmations] No appointments tomorrow to confirm.");
      return;
    }

    console.log(
      `[Confirmations] Sending ${tomorrowAppointments.length} confirmation(s)...`
    );

    // Get voice profile for message composition
    const profile = await voiceProfileService.getProfile();

    // 2. Send confirmation to each client
    for (const appt of tomorrowAppointments) {
      try {
        const startTime = new Date(appt.startTime);
        const timeStr = startTime.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const dayStr = startTime.toLocaleDateString("en-US", {
          weekday: "long",
        });

        // 3. Compose a natural confirmation message
        const messageBody = await this.composeConfirmation(
          appt.clientName.split(" ")[0], // Use first name
          timeStr,
          dayStr,
          profile?.toneAnalysis
        );

        // Send SMS
        await smsProvider.sendMessage(appt.clientPhone, messageBody);

        // 4. Store outbound message
        db.insert(messages)
          .values({
            clientId: appt.clientId,
            direction: "outbound",
            channel: "sms",
            senderType: "ai",
            body: messageBody,
            createdAt: new Date().toISOString(),
          })
          .run();

        console.log(
          `[Confirmations] Sent to ${appt.clientName} (${appt.clientPhone})`
        );
      } catch (error) {
        console.error(
          `[Confirmations] Failed to send to ${appt.clientName}:`,
          error
        );
      }
    }
  }

  private async composeConfirmation(
    clientFirstName: string,
    time: string,
    day: string,
    voiceAnalysis?: unknown
  ): Promise<string> {
    let voiceInstructions: string;
    if (voiceAnalysis && typeof voiceAnalysis === "object") {
      const analysis = voiceAnalysis as Record<string, unknown>;
      voiceInstructions = `Match this voice style:
- Tone: ${analysis.tone}
- Formality: ${analysis.formality}
- Emoji usage: ${analysis.emojiUsage}
- Use greetings like: ${Array.isArray(analysis.greetingPatterns) ? analysis.greetingPatterns.join(", ") : "Hey"}`;
    } else {
      voiceInstructions = `Use a friendly, casual gym-bro/sis tone. Keep it real and approachable like a text from a friend who happens to be your trainer.`;
    }

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `${voiceInstructions}

Write a brief appointment confirmation text message to ${clientFirstName} for their session at ${time} on ${day} (tomorrow).

Requirements:
- Keep it SHORT (1-2 sentences max, this is a text message)
- Ask them to confirm or let you know if they need to reschedule
- Sound natural and varied (don't use a template feel)
- Do NOT include any sign-off name

Respond with ONLY the message text.`,
        },
      ],
    });

    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : `Hey ${clientFirstName}, just confirming your session at ${time} tomorrow. Still good?`;
  }
}

export const confirmationService = new ConfirmationService();
