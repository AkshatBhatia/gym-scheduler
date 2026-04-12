import { db } from "../db/index.js";
import { appointments, clients, sessionLedger } from "../db/schema.js";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { smsProvider } from "./sms.js";

export class BriefingService {
  async sendDailyBriefing(): Promise<void> {
    const instructorPhone = process.env.INSTRUCTOR_PHONE_NUMBER;
    if (!instructorPhone) {
      console.error("[Briefing] INSTRUCTOR_PHONE_NUMBER not set, skipping briefing.");
      return;
    }

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const dayName = today.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    // 1. Get today's appointments
    const todayStart = `${todayStr}T00:00:00`;
    const todayEnd = `${todayStr}T23:59:59`;

    const todayAppointments = db
      .select({
        id: appointments.id,
        clientName: clients.name,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        notes: appointments.notes,
        sessionsRemaining: clients.sessionsRemaining,
        packageType: clients.packageType,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, todayStart),
          lte(appointments.startTime, todayEnd),
          eq(appointments.status, "confirmed")
        )
      )
      .all();

    // 2. Get unconfirmed/pending items (appointments in next 48h that haven't been confirmed)
    const twoDaysOut = new Date(
      today.getTime() + 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const upcomingUnconfirmed = db
      .select({
        clientName: clients.name,
        startTime: appointments.startTime,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, todayEnd),
          lte(appointments.startTime, twoDaysOut),
          eq(appointments.status, "confirmed")
        )
      )
      .all();

    // 3. Get clients with low session balances (2 or fewer)
    const lowBalanceClients = db
      .select({
        name: clients.name,
        sessionsRemaining: clients.sessionsRemaining,
        packageType: clients.packageType,
      })
      .from(clients)
      .where(eq(clients.active, 1))
      .all()
      .filter(
        (c) =>
          c.sessionsRemaining !== null &&
          c.sessionsRemaining <= 2 &&
          c.packageType !== "monthly"
      );

    // 4. Compose the briefing message
    let briefing = `Good morning! Here's your ${dayName} briefing:\n\n`;

    if (todayAppointments.length === 0) {
      briefing += "No sessions scheduled today.\n";
    } else {
      briefing += `${todayAppointments.length} session${todayAppointments.length === 1 ? "" : "s"} today:\n`;
      for (const appt of todayAppointments) {
        const start = new Date(appt.startTime).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const end = new Date(appt.endTime).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        briefing += `  ${start}-${end}: ${appt.clientName}`;
        if (appt.notes) briefing += ` (${appt.notes})`;
        briefing += "\n";
      }
    }

    if (upcomingUnconfirmed.length > 0) {
      briefing += `\nTomorrow: ${upcomingUnconfirmed.length} session${upcomingUnconfirmed.length === 1 ? "" : "s"} coming up.\n`;
    }

    if (lowBalanceClients.length > 0) {
      briefing += "\nLow session balances:\n";
      for (const client of lowBalanceClients) {
        briefing += `  ${client.name}: ${client.sessionsRemaining} session${client.sessionsRemaining === 1 ? "" : "s"} left (${client.packageType})\n`;
      }
    }

    briefing += "\nReply with any changes or questions!";

    // 5. Send via SMS
    try {
      await smsProvider.sendMessage(instructorPhone, briefing);
      console.log("[Briefing] Daily briefing sent successfully.");
    } catch (error) {
      console.error("[Briefing] Failed to send daily briefing:", error);
    }
  }
}

export const briefingService = new BriefingService();
