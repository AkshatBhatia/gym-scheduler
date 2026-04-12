import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import {
  clients,
  appointments,
  availability,
  sessionLedger,
  messages,
  recurringSchedules,
} from "../db/schema.js";
import { generateForClient } from "./recurring.js";
import { eq, and, gte, lte, like, desc, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  getTimezone,
  todayLocal,
  formatLocalTimeShort,
  utcToLocal,
  localToUTC,
} from "./timezone.js";
import { bookAppointment, cancelAppointment, getAvailableSlots } from "./scheduling.js";

export class ChatAgent {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  /**
   * Load recent message history from the DB for a given phone/client,
   * formatted as alternating user/assistant turns for Claude.
   */
  private getConversationHistory(
    phone: string,
    clientId: number | null,
    limit: number = 20
  ): Anthropic.MessageParam[] {
    // Query recent messages for this conversation partner
    const conditions = [];
    if (clientId) {
      conditions.push(eq(messages.clientId, clientId));
    }

    const recentMessages = clientId
      ? db
          .select()
          .from(messages)
          .where(eq(messages.clientId, clientId))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all()
          .reverse() // oldest first
      : db
          .select()
          .from(messages)
          .where(eq(messages.channel, "sms"))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all()
          .filter((m) => m.senderType === 'instructor' || m.senderType === 'ai')
          .reverse();

    // Convert to Claude message format, merging consecutive same-role messages
    const history: Anthropic.MessageParam[] = [];
    for (const msg of recentMessages) {
      const role: "user" | "assistant" =
        msg.direction === "inbound" ? "user" : "assistant";

      // Merge consecutive messages with the same role
      const last = history[history.length - 1];
      if (last && last.role === role) {
        last.content = `${last.content}\n${msg.body}`;
      } else {
        history.push({ role, content: msg.body });
      }
    }

    // Claude requires the conversation to start with "user" and alternate
    // Trim leading assistant messages
    while (history.length > 0 && history[0].role === "assistant") {
      history.shift();
    }

    return history;
  }

  async processInstructorMessage(message: string): Promise<string> {
    const systemPrompt = await this.buildInstructorSystemPrompt();
    const tools = this.getTools();

    // Load recent conversation history for continuity
    const history = this.getConversationHistory(
      process.env.INSTRUCTOR_PHONE_NUMBER || "",
      null,
      20
    );

    // Append the new message
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: message },
    ];

    let response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Agentic loop: keep processing tool calls until we get a final text response
    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          const result = await this.executeTool(
            block.name,
            block.input as Record<string, unknown>
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });
    }

    // Extract final text response
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("\n") || "Done.";
  }

  async processClientMessage(
    clientPhone: string,
    message: string
  ): Promise<string> {
    // Look up client by phone
    const client = db
      .select()
      .from(clients)
      .where(eq(clients.phone, clientPhone))
      .get();

    if (!client) {
      return this.processPublicMessage(clientPhone, message);
    }

    // Check for upcoming appointments that might need confirmation
    const now = new Date().toISOString();
    const twoDaysFromNow = new Date(
      Date.now() + 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const upcomingAppointments = db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, client.id),
          eq(appointments.status, "confirmed"),
          gte(appointments.startTime, now),
          lte(appointments.startTime, twoDaysFromNow)
        )
      )
      .all();

    const lowerMsg = message.toLowerCase().trim();

    // Interpret confirmation replies
    const affirmativePatterns =
      /^(yes|yeah|yep|yup|sure|ok|okay|confirmed|absolutely|def|definitely|of course|you bet|see you|see ya|sounds good|works for me|i'll be there|good|great|perfect)$/i;
    const negativePatterns =
      /^(no|nope|nah|can't|cannot|cancel|won't make it|have to cancel|not going|not coming)$/i;
    const reschedulePatterns =
      /reschedule|move|change|different time|another time|switch/i;

    if (
      upcomingAppointments.length > 0 &&
      affirmativePatterns.test(lowerMsg)
    ) {
      const appt = upcomingAppointments[0];
      const timeStr = formatLocalTimeShort(appt.startTime);
      const tz = getTimezone();
      const dateStr = DateTime.fromISO(appt.startTime, { zone: "utc" }).setZone(tz).toFormat("cccc");
      return `Great, you're confirmed for ${dateStr} at ${timeStr}. See you then!`;
    }

    if (upcomingAppointments.length > 0 && negativePatterns.test(lowerMsg)) {
      const appt = upcomingAppointments[0];
      await cancelAppointment(appt.id, "Client cancelled via text");

      return `No problem, I've cancelled your upcoming appointment. Just text us when you'd like to rebook!`;
    }

    if (reschedulePatterns.test(lowerMsg) && upcomingAppointments.length > 0) {
      return `Sure, I can help you reschedule. What day and time work better for you?`;
    }

    // General message - use AI with tools for booking, with conversation history
    const tz = getTimezone();
    const history = this.getConversationHistory(clientPhone, client.id, 20);
    const clientTools = this.getTools().filter((t) =>
      ["get_available_slots", "book_appointment", "cancel_appointment", "list_appointments", "create_recurring_schedule"].includes(t.name)
    );

    // Get all future appointments for this client to provide context
    const allUpcoming = db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, client.id),
          eq(appointments.status, "confirmed"),
          gte(appointments.startTime, new Date().toISOString())
        )
      )
      .all();

    const upcomingList = allUpcoming.length > 0
      ? allUpcoming.map((a) => `- ${formatLocalTimeShort(a.startTime)} on ${utcToLocal(a.startTime).slice(0, 10)}`).join("\n")
      : "None";

    const systemPrompt = `You are a friendly gym scheduling assistant responding to a client named ${client.name}.
They currently have ${client.sessionsRemaining ?? 0} sessions remaining on their ${client.packageType || "pay-per-session"} plan.
Today is ${todayLocal()}. Timezone: ${tz}.

Their upcoming appointments:
${upcomingList}

You CAN book, cancel, and check available slots for this client using the tools provided.
When booking, use "${client.name}" as the clientName.
Keep responses brief and text-message friendly.
IMPORTANT: All times are in ${tz}. Pass local times to tools.

IMPORTANT BOOKING RULE: Before confirming a new booking, ALWAYS use list_appointments to check if the client already has another appointment on the SAME DAY. If they do, ask them to confirm: "You already have a session at [time] that day. Do you want to keep both appointments?" Do NOT book until they confirm.`;

    const aiMessages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: message },
    ];

    let response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: clientTools,
      messages: aiMessages,
    });

    // Agentic tool-use loop (same as instructor)
    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      aiMessages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          const result = await this.executeTool(
            block.name,
            block.input as Record<string, unknown>
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      aiMessages.push({ role: "user", content: toolResults });

      response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        tools: clientTools,
        messages: aiMessages,
      });
    }

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("\n") || "";
  }

  async processPublicMessage(
    phone: string,
    message: string
  ): Promise<string> {
    // Check if we're mid-conversation by looking at recent messages from this number
    const recentMessages = db
      .select()
      .from(messages)
      .where(eq(messages.body, phone))
      .all();

    const lowerMsg = message.toLowerCase().trim();
    const wantsToBook =
      /book|schedule|appointment|session|train|sign up|available|slot|open/i.test(
        lowerMsg
      );

    if (wantsToBook) {
      // Show available slots for the next few days
      const availableSlots = await this.getAvailableSlotsForDays(3);
      if (availableSlots.length === 0) {
        return `Thanks for reaching out! We're fully booked for the next few days. Can I take your name and get back to you with availability?`;
      }

      let slotText = "Here are some available times:\n\n";
      for (const day of availableSlots) {
        slotText += `${day.date}: ${day.slots.join(", ")}\n`;
      }
      slotText += `\nJust reply with your preferred time and your name, and I'll get you booked!`;
      return slotText;
    }

    // Check if they're providing a name and time (likely responding to available slots)
    const nameTimeMatch = message.match(
      /(?:i'm|im|my name is|name's|this is)\s+(\w+)/i
    );
    if (nameTimeMatch) {
      const name = nameTimeMatch[1];
      return `Nice to meet you, ${name}! What day and time would work best for your session? You can also just tell me when you're free and I'll find something that works.`;
    }

    // Default greeting
    return `Hey there! Welcome to the gym. Are you looking to book a training session? Just let me know and I'll show you what's available!`;
  }

  private async buildInstructorSystemPrompt(): Promise<string> {
    const tz = getTimezone();
    const todayStr = todayLocal();
    // luxon imported statically at top of file
    const now = DateTime.now().setZone(tz);
    const dayName = now.toFormat("cccc");

    // Get today's schedule — query using UTC bounds for the local day
    const todayStartUTC = localToUTC(`${todayStr}T00:00:00`);
    const todayEndUTC = localToUTC(`${todayStr}T23:59:59`);
    const todayAppointments = db
      .select({
        id: appointments.id,
        clientName: clients.name,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        notes: appointments.notes,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, todayStartUTC),
          lte(appointments.startTime, todayEndUTC),
          eq(appointments.status, "confirmed")
        )
      )
      .all();

    const clientCount = db.select().from(clients).where(eq(clients.active, 1)).all().length;

    let scheduleText: string;
    if (todayAppointments.length === 0) {
      scheduleText = "No appointments scheduled for today.";
    } else {
      scheduleText = todayAppointments
        .map((a) => {
          const start = formatLocalTimeShort(a.startTime);
          const end = formatLocalTimeShort(a.endTime);
          return `- ${start}-${end}: ${a.clientName}${a.notes ? ` (${a.notes})` : ""}`;
        })
        .join("\n");
    }

    return `You are a friendly, efficient gym scheduling assistant for a personal trainer. You help manage their schedule, clients, and sessions via text message.

Today is ${dayName}, ${todayStr}. Timezone: ${tz} (current time: ${now.toFormat("h:mm a")}).

TODAY'S SCHEDULE:
${scheduleText}

You have ${clientCount} active client(s) in the system.

KEY BEHAVIORS:
- Be concise — this is SMS, keep responses short and actionable.
- When booking, always confirm the date, time, and client name.
- When cancelling, offer to rebook if appropriate.
- Proactively mention low session balances when relevant.
- Use natural, conversational language.
- If something is ambiguous, ask a clarifying question rather than guessing.
- For dates, interpret relative references like "tomorrow", "next Monday", etc. relative to today's date.
- Default appointment duration is 1 hour unless specified otherwise.
- IMPORTANT: All times the user mentions are in ${tz}. When calling tools that take dateTime params, pass the LOCAL time as ISO format (e.g., 2026-04-08T15:00:00). The system will handle UTC conversion.`;
  }

  private getTools(): Anthropic.Tool[] {
    return [
      {
        name: "list_appointments",
        description:
          "List appointments for a given date. If no date provided, shows today's appointments.",
        input_schema: {
          type: "object" as const,
          properties: {
            date: {
              type: "string",
              description: "Date in YYYY-MM-DD format. Defaults to today.",
            },
          },
        },
      },
      {
        name: "book_appointment",
        description:
          "Book a new appointment for a client. Deducts a session from their balance if applicable.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name (case-insensitive search).",
            },
            dateTime: {
              type: "string",
              description:
                "Start date and time in ISO format (e.g., 2025-01-15T10:00:00).",
            },
            duration: {
              type: "number",
              description: "Duration in minutes. Defaults to 60.",
            },
            notes: {
              type: "string",
              description: "Optional notes for the appointment.",
            },
          },
          required: ["clientName", "dateTime"],
        },
      },
      {
        name: "cancel_appointment",
        description:
          "Cancel an appointment by ID. Refunds the session to the client's balance.",
        input_schema: {
          type: "object" as const,
          properties: {
            appointmentId: {
              type: "number",
              description: "The appointment ID to cancel.",
            },
            reason: {
              type: "string",
              description: "Optional reason for cancellation.",
            },
          },
          required: ["appointmentId"],
        },
      },
      {
        name: "get_client_info",
        description:
          "Look up client details by name. Returns contact info, package, session balance, and notes.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name (partial match supported).",
            },
          },
          required: ["clientName"],
        },
      },
      {
        name: "get_session_balance",
        description:
          "Check a client's remaining session balance and package type.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
          },
          required: ["clientName"],
        },
      },
      {
        name: "add_client",
        description: "Add a new client to the system.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Client's full name.",
            },
            phone: {
              type: "string",
              description: "Client's phone number in E.164 format (e.g., +15551234567).",
            },
            email: {
              type: "string",
              description: "Client's email address (optional).",
            },
            packageType: {
              type: "string",
              description:
                "Package type: single, 5-pack, 10-pack, 20-pack, or monthly.",
              enum: ["single", "5-pack", "10-pack", "20-pack", "monthly"],
            },
            sessions: {
              type: "number",
              description: "Initial number of sessions to credit.",
            },
            notes: {
              type: "string",
              description: "Optional notes about the client.",
            },
          },
          required: ["name", "phone"],
        },
      },
      {
        name: "block_time",
        description:
          "Block off a time range so no appointments can be booked during it.",
        input_schema: {
          type: "object" as const,
          properties: {
            date: {
              type: "string",
              description: "Date in YYYY-MM-DD format.",
            },
            startTime: {
              type: "string",
              description: "Start time in HH:MM format (24-hour).",
            },
            endTime: {
              type: "string",
              description: "End time in HH:MM format (24-hour).",
            },
          },
          required: ["date", "startTime", "endTime"],
        },
      },
      {
        name: "get_available_slots",
        description:
          "Get available time slots for a given date based on availability and existing appointments.",
        input_schema: {
          type: "object" as const,
          properties: {
            date: {
              type: "string",
              description: "Date in YYYY-MM-DD format.",
            },
          },
          required: ["date"],
        },
      },
      {
        name: "search_messages",
        description:
          "Search message history by client name and/or keyword.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "Filter messages by client name.",
            },
            keyword: {
              type: "string",
              description: "Search keyword in message body.",
            },
          },
        },
      },
      {
        name: "deactivate_client",
        description:
          "Deactivate (soft-delete) a client. Their data is kept but they won't appear in active lists.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
          },
          required: ["clientName"],
        },
      },
      {
        name: "update_client_sessions",
        description:
          "Update a client's session balance. Use when a client purchases a new package or needs a balance adjustment.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
            sessions: {
              type: "number",
              description: "The new total session count to set, OR a positive number to add sessions.",
            },
            mode: {
              type: "string",
              description: "Either 'set' (set exact balance) or 'add' (add to current balance). Defaults to 'set'.",
              enum: ["set", "add"],
            },
            packageType: {
              type: "string",
              description: "Optionally update the package type.",
              enum: ["single", "5-pack", "10-pack", "20-pack", "monthly"],
            },
          },
          required: ["clientName", "sessions"],
        },
      },
      {
        name: "create_recurring_schedule",
        description:
          "Set up a recurring weekly appointment for a client. This creates the recurring rule and auto-generates appointments based on their remaining sessions.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
            dayOfWeek: {
              type: "string",
              description: "Day of the week (e.g., 'Monday', 'Tuesday', 'Friday').",
              enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            },
            startTime: {
              type: "string",
              description: "Start time in HH:MM format (24-hour), e.g., '08:00', '14:00'.",
            },
            endTime: {
              type: "string",
              description: "End time in HH:MM format (24-hour). Defaults to 1 hour after start.",
            },
          },
          required: ["clientName", "dayOfWeek", "startTime"],
        },
      },
    ];
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case "list_appointments":
        return this.toolListAppointments(input.date as string | undefined);

      case "book_appointment":
        return this.toolBookAppointment(
          input.clientName as string,
          input.dateTime as string,
          (input.duration as number) || 60,
          input.notes as string | undefined
        );

      case "cancel_appointment":
        return this.toolCancelAppointment(
          input.appointmentId as number,
          input.reason as string | undefined
        );

      case "get_client_info":
        return this.toolGetClientInfo(input.clientName as string);

      case "get_session_balance":
        return this.toolGetSessionBalance(input.clientName as string);

      case "add_client":
        return this.toolAddClient(
          input.name as string,
          input.phone as string,
          input.email as string | undefined,
          input.packageType as string | undefined,
          input.sessions as number | undefined,
          input.notes as string | undefined
        );

      case "block_time":
        return this.toolBlockTime(
          input.date as string,
          input.startTime as string,
          input.endTime as string
        );

      case "get_available_slots":
        return this.toolGetAvailableSlots(input.date as string);

      case "search_messages":
        return this.toolSearchMessages(
          input.clientName as string | undefined,
          input.keyword as string | undefined
        );

      case "deactivate_client":
        return this.toolDeactivateClient(input.clientName as string);

      case "update_client_sessions":
        return this.toolUpdateClientSessions(
          input.clientName as string,
          input.sessions as number,
          (input.mode as string) || "set",
          input.packageType as string | undefined
        );

      case "create_recurring_schedule":
        return this.toolCreateRecurring(
          input.clientName as string,
          input.dayOfWeek as string,
          input.startTime as string,
          input.endTime as string | undefined
        );

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  // ---- Tool implementations ----

  private async toolListAppointments(date?: string): Promise<string> {
    const targetDate = date || todayLocal();
    // Convert local day boundaries to UTC for querying
    const dayStart = localToUTC(`${targetDate}T00:00:00`);
    const dayEnd = localToUTC(`${targetDate}T23:59:59`);

    const appts = db
      .select({
        id: appointments.id,
        clientName: clients.name,
        clientPhone: clients.phone,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        notes: appointments.notes,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(
        and(
          gte(appointments.startTime, dayStart),
          lte(appointments.startTime, dayEnd)
        )
      )
      .all();

    if (appts.length === 0) {
      return JSON.stringify({
        date: targetDate,
        appointments: [],
        message: "No appointments scheduled for this date.",
      });
    }

    return JSON.stringify({
      date: targetDate,
      count: appts.length,
      appointments: appts.map((a) => ({
        id: a.id,
        client: a.clientName,
        phone: a.clientPhone,
        start: utcToLocal(a.startTime),
        startFormatted: formatLocalTimeShort(a.startTime),
        end: utcToLocal(a.endTime),
        endFormatted: formatLocalTimeShort(a.endTime),
        status: a.status,
        notes: a.notes,
      })),
    });
  }

  private async toolBookAppointment(
    clientName: string,
    dateTime: string,
    duration: number,
    notes?: string
  ): Promise<string> {
    // Find client by name (case-insensitive partial match)
    const allClients = db.select().from(clients).where(eq(clients.active, 1)).all();
    const matchedClient = allClients.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );

    if (!matchedClient) {
      return JSON.stringify({
        error: `No client found matching "${clientName}". Available clients: ${allClients.map((c) => c.name).join(", ")}`,
      });
    }

    // Convert local time to UTC for storage
    const startUTC = localToUTC(dateTime);

    // Delegate to scheduling service (handles past check, availability, conflicts, UTC format)
    const result = await bookAppointment(matchedClient.id, startUTC, notes);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    const appt = result.appointment!;

    // Show current session balance (sessions are deducted on completion, not booking)
    let sessionInfo = "";
    if (matchedClient.sessionsRemaining !== null) {
      sessionInfo = ` Sessions remaining: ${matchedClient.sessionsRemaining}.`;
      if (matchedClient.sessionsRemaining <= 2) {
        sessionInfo += ` WARNING: Low session balance!`;
      }
    }

    const startFormatted = formatLocalTimeShort(appt.startTime);

    return JSON.stringify({
      success: true,
      appointmentId: appt.id,
      client: matchedClient.name,
      start: appt.startTime,
      end: appt.endTime,
      formatted: `Booked ${matchedClient.name} for ${startFormatted}.${sessionInfo}`,
    });
  }

  private async toolCancelAppointment(
    appointmentId: number,
    reason?: string
  ): Promise<string> {
    const appt = db
      .select({
        id: appointments.id,
        clientId: appointments.clientId,
        startTime: appointments.startTime,
        status: appointments.status,
        clientName: clients.name,
        sessionsRemaining: clients.sessionsRemaining,
      })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(eq(appointments.id, appointmentId))
      .get();

    if (!appt) {
      return JSON.stringify({ error: `No appointment found with ID ${appointmentId}.` });
    }

    if (appt.status === "cancelled") {
      return JSON.stringify({ error: "This appointment is already cancelled." });
    }

    // Delegate to scheduling service (handles status update + session refund)
    const result = await cancelAppointment(appointmentId, reason);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // Re-read client to get updated balance for response
    let refundInfo = "";
    if (appt.sessionsRemaining !== null) {
      const updatedClient = db
        .select()
        .from(clients)
        .where(eq(clients.id, appt.clientId))
        .get();
      const newBalance = updatedClient?.sessionsRemaining ?? 0;
      refundInfo = ` Session refunded (balance: ${newBalance}).`;
    }

    return JSON.stringify({
      success: true,
      message: `Cancelled ${appt.clientName}'s appointment on ${formatLocalTimeShort(appt.startTime)}.${refundInfo}`,
    });
  }

  private async toolGetClientInfo(clientName: string): Promise<string> {
    const allClients = db.select().from(clients).all();
    const matched = allClients.filter((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );

    if (matched.length === 0) {
      return JSON.stringify({
        error: `No client found matching "${clientName}".`,
      });
    }

    const results = [];
    for (const client of matched) {
      // Get upcoming appointments
      const upcoming = db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.clientId, client.id),
            eq(appointments.status, "confirmed"),
            gte(appointments.startTime, new Date().toISOString())
          )
        )
        .all();

      results.push({
        id: client.id,
        name: client.name,
        phone: client.phone,
        email: client.email,
        packageType: client.packageType,
        sessionsRemaining: client.sessionsRemaining,
        notes: client.notes,
        active: client.active === 1,
        upcomingAppointments: upcoming.map((a) => ({
          id: a.id,
          start: a.startTime,
          end: a.endTime,
        })),
      });
    }

    return JSON.stringify(results.length === 1 ? results[0] : results);
  }

  private async toolGetSessionBalance(clientName: string): Promise<string> {
    const allClients = db.select().from(clients).all();
    const matched = allClients.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );

    if (!matched) {
      return JSON.stringify({
        error: `No client found matching "${clientName}".`,
      });
    }

    // Get recent ledger entries
    const ledger = db
      .select()
      .from(sessionLedger)
      .where(eq(sessionLedger.clientId, matched.id))
      .orderBy(desc(sessionLedger.createdAt))
      .limit(5)
      .all();

    return JSON.stringify({
      client: matched.name,
      packageType: matched.packageType,
      sessionsRemaining: matched.sessionsRemaining,
      recentActivity: ledger.map((l) => ({
        change: l.changeAmount,
        balance: l.balanceAfter,
        reason: l.reason,
        date: l.createdAt,
      })),
    });
  }

  private async toolAddClient(
    name: string,
    phone: string,
    email?: string,
    packageType?: string,
    sessions?: number,
    notes?: string
  ): Promise<string> {
    // Check for duplicate phone
    const existing = db
      .select()
      .from(clients)
      .where(eq(clients.phone, phone))
      .get();

    if (existing) {
      return JSON.stringify({
        error: `A client with phone ${phone} already exists: ${existing.name}.`,
      });
    }

    const validPackages = ["single", "5-pack", "10-pack", "20-pack", "monthly"];
    const pkg = packageType && validPackages.includes(packageType)
      ? (packageType as "single" | "5-pack" | "10-pack" | "20-pack" | "monthly")
      : undefined;

    const sessionCount = sessions ?? 0;

    const result = db
      .insert(clients)
      .values({
        name,
        phone,
        email: email || null,
        packageType: pkg,
        sessionsRemaining: sessionCount,
        notes: notes || null,
        active: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const clientId = Number(result.lastInsertRowid);

    // Create initial ledger entry if sessions > 0
    if (sessionCount > 0) {
      db.insert(sessionLedger)
        .values({
          clientId,
          changeAmount: sessionCount,
          balanceAfter: sessionCount,
          reason: "Initial package purchase",
        })
        .run();
    }

    return JSON.stringify({
      success: true,
      clientId,
      message: `Added ${name} (${phone})${pkg ? ` with ${pkg} package (${sessionCount} sessions)` : ""}.`,
    });
  }

  private async toolBlockTime(
    date: string,
    startTime: string,
    endTime: string
  ): Promise<string> {
    db.insert(availability)
      .values({
        overrideDate: date,
        startTime,
        endTime,
        isBlocked: 1,
        createdAt: new Date().toISOString(),
      })
      .run();

    return JSON.stringify({
      success: true,
      message: `Blocked ${date} from ${startTime} to ${endTime}. No appointments can be booked during this time.`,
    });
  }

  private async toolGetAvailableSlots(date: string): Promise<string> {
    const tz = getTimezone();
    const targetDate = DateTime.fromISO(date, { zone: tz });
    const dayOfWeek = targetDate.weekday % 7; // luxon: 1=Mon..7=Sun → 0=Sun

    const slots = await getAvailableSlots(date);
    const availableSlots = slots
      .filter((s) => s.available)
      .map((s) => {
        const time = s.startTime.split("T")[1]?.slice(0, 5) || s.startTime;
        return time;
      });

    if (availableSlots.length === 0) {
      return JSON.stringify({
        date,
        slots: [],
        message: "No availability set for this day of the week.",
      });
    }

    return JSON.stringify({
      date,
      dayOfWeek: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ][dayOfWeek],
      availableSlots,
      count: availableSlots.length,
    });
  }

  private async toolSearchMessages(
    clientName?: string,
    keyword?: string
  ): Promise<string> {
    let clientId: number | null = null;

    if (clientName) {
      const allClients = db.select().from(clients).all();
      const matched = allClients.find((c) =>
        c.name.toLowerCase().includes(clientName.toLowerCase())
      );
      if (matched) {
        clientId = matched.id;
      } else {
        return JSON.stringify({
          error: `No client found matching "${clientName}".`,
        });
      }
    }

    let query = db
      .select({
        id: messages.id,
        clientId: messages.clientId,
        direction: messages.direction,
        senderType: messages.senderType,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages);

    const conditions = [];
    if (clientId !== null) {
      conditions.push(eq(messages.clientId, clientId));
    }
    if (keyword) {
      conditions.push(like(messages.body, `%${keyword}%`));
    }

    const results =
      conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(messages.createdAt)).limit(20).all()
        : query.orderBy(desc(messages.createdAt)).limit(20).all();

    return JSON.stringify({
      count: results.length,
      messages: results.map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        body: m.body,
        date: m.createdAt,
      })),
    });
  }

  private async toolDeactivateClient(clientName: string): Promise<string> {
    const allClients = db.select().from(clients).where(eq(clients.active, 1)).all();
    const matched = allClients.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );
    if (!matched) {
      return JSON.stringify({ error: `No active client found matching "${clientName}".` });
    }

    db.update(clients)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(clients.id, matched.id))
      .run();

    // Deactivate their recurring schedules too
    db.update(recurringSchedules)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(recurringSchedules.clientId, matched.id))
      .run();

    return JSON.stringify({
      success: true,
      message: `Deactivated ${matched.name}. They won't appear in active client lists. Their appointment history is preserved.`,
    });
  }

  private async toolUpdateClientSessions(
    clientName: string,
    sessions: number,
    mode: string,
    packageType?: string
  ): Promise<string> {
    const allClients = db.select().from(clients).where(eq(clients.active, 1)).all();
    const matched = allClients.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );
    if (!matched) {
      return JSON.stringify({ error: `No client found matching "${clientName}".` });
    }

    const currentBalance = matched.sessionsRemaining ?? 0;
    const newBalance = mode === "add" ? currentBalance + sessions : sessions;

    const updateData: Record<string, unknown> = {
      sessionsRemaining: newBalance,
      updatedAt: new Date().toISOString(),
    };
    if (packageType) {
      updateData.packageType = packageType;
    }

    db.update(clients)
      .set(updateData)
      .where(eq(clients.id, matched.id))
      .run();

    // Log to session ledger
    const change = newBalance - currentBalance;
    if (change !== 0) {
      db.insert(sessionLedger)
        .values({
          clientId: matched.id,
          changeAmount: change,
          balanceAfter: newBalance,
          reason: mode === "add" ? "Sessions added" : "Balance updated",
        })
        .run();
    }

    // Auto-generate recurring appointments for the new balance
    await generateForClient(matched.id);

    return JSON.stringify({
      success: true,
      client: matched.name,
      previousBalance: currentBalance,
      newBalance,
      packageType: packageType || matched.packageType,
      message: `Updated ${matched.name}'s sessions from ${currentBalance} to ${newBalance}.${packageType ? ` Package: ${packageType}.` : ""}`,
    });
  }

  private async toolCreateRecurring(
    clientName: string,
    dayOfWeekStr: string,
    startTime: string,
    endTime?: string
  ): Promise<string> {
    const dayMap: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
      Thursday: 4, Friday: 5, Saturday: 6,
    };
    const dayOfWeek = dayMap[dayOfWeekStr];
    if (dayOfWeek === undefined) {
      return JSON.stringify({ error: `Invalid day: ${dayOfWeekStr}` });
    }

    // Find client
    const allClients = db.select().from(clients).where(eq(clients.active, 1)).all();
    const matched = allClients.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );
    if (!matched) {
      return JSON.stringify({ error: `No client found matching "${clientName}".` });
    }

    // Calculate end time (default 1 hour)
    const actualEnd = endTime || (() => {
      const [h, m] = startTime.split(":").map(Number);
      return `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    })();

    // Check for duplicate
    const existing = db
      .select()
      .from(recurringSchedules)
      .where(
        and(
          eq(recurringSchedules.clientId, matched.id),
          eq(recurringSchedules.dayOfWeek, dayOfWeek),
          eq(recurringSchedules.startTime, startTime)
        )
      )
      .get();

    if (existing) {
      return JSON.stringify({
        error: `${matched.name} already has a recurring ${dayOfWeekStr} at ${startTime}.`,
      });
    }

    // Create the recurring schedule
    db.insert(recurringSchedules)
      .values({
        clientId: matched.id,
        dayOfWeek,
        startTime,
        endTime: actualEnd,
        active: 1,
      })
      .run();

    // Delete existing recurring appointments for this client and regenerate
    // so all schedules get fair distribution of sessions
    const existingRecurring = db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, matched.id),
          eq(appointments.status, "confirmed")
        )
      )
      .all()
      .filter((a) => a.recurringScheduleId != null && a.startTime > new Date().toISOString());

    for (const appt of existingRecurring) {
      db.delete(appointments).where(eq(appointments.id, appt.id)).run();
    }

    // Regenerate all recurring appointments with fair distribution
    const generated = await generateForClient(matched.id);

    return JSON.stringify({
      success: true,
      message: `Created recurring ${dayOfWeekStr} at ${startTime} for ${matched.name}. Generated ${generated.created} upcoming appointments across all recurring days based on their ${matched.sessionsRemaining ?? 0} remaining sessions.`,
    });
  }

  private async getAvailableSlotsForDays(
    numDays: number
  ): Promise<{ date: string; slots: string[] }[]> {
    const result: { date: string; slots: string[] }[] = [];
    const today = new Date();

    for (let i = 1; i <= numDays; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split("T")[0];

      const slotsJson = await this.toolGetAvailableSlots(dateStr);
      const parsed = JSON.parse(slotsJson);
      if (parsed.availableSlots && parsed.availableSlots.length > 0) {
        // Format times nicely
        const formatted = parsed.availableSlots.map((s: string) => {
          const hour = parseInt(s.split(":")[0]);
          const ampm = hour >= 12 ? "PM" : "AM";
          const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
          return `${displayHour}${ampm}`;
        });
        result.push({
          date: date.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
          slots: formatted,
        });
      }
    }

    return result;
  }
}

export const chatAgent = new ChatAgent();
