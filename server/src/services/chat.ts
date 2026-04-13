import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import {
  clients,
  appointments,
  availability,
  sessionLedger,
  messages,
  recurringSchedules,
  instructor,
} from "../db/schema.js";
import { generateForClient, listRecurringSchedules, updateRecurringSchedule, deleteRecurringSchedule } from "./recurring.js";
import { eq, and, gte, lte, like, desc, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  getTimezone,
  todayLocal,
  formatLocalTimeShort,
  utcToLocal,
  localToUTC,
} from "./timezone.js";
import { bookAppointment, cancelAppointment, completeAppointment, markNoShow, rescheduleAppointment, skipRecurringInstance, getAvailableSlots } from "./scheduling.js";
import { listClients, updateClient, reactivateClient, deleteClient, updateMyContact } from "./clients.js";
import { setAvailability, listAvailability, overrideAvailability, removeBlock } from "./availability.js";
import { getDailySummary, getWeeklySummary } from "./dashboard.js";
import { sendMessageToClient } from "./messaging.js";
import { sendSms } from "./sms.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_MAP: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

export class ChatAgent {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  private resolveClient(
    clientName: string,
    opts?: { includeInactive?: boolean }
  ): { client?: typeof clients.$inferSelect; error?: string } {
    const rows = opts?.includeInactive
      ? db.select().from(clients).all()
      : db.select().from(clients).where(eq(clients.active, 1)).all();
    const matched = rows.find((c) =>
      c.name.toLowerCase().includes(clientName.toLowerCase())
    );
    if (!matched) {
      return { error: `No client found matching "${clientName}".` };
    }
    return { client: matched };
  }

  private async trySendSms(phone: string, body: string): Promise<void> {
    try {
      await sendSms(phone, body);
    } catch (e) {
      console.error(`[SMS] Failed to send to ${phone}:`, e);
    }

    // Store the message in the messages table for the Messages tab
    try {
      const client = db.select().from(clients).where(eq(clients.phone, phone)).get();
      db.insert(messages)
        .values({
          clientId: client?.id ?? null,
          direction: "outbound",
          channel: "sms",
          senderType: "system",
          body,
        })
        .run();
    } catch (e) {
      // Storage failure should not block the operation
    }
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
      model: "claude-opus-4-6",
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
        model: "claude-opus-4-6",
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
      [
        "get_available_slots", "book_appointment", "cancel_appointment",
        "list_appointments", "create_recurring_schedule",
        "reschedule_appointment", "list_recurring_schedules",
        "skip_recurring_instance", "delete_recurring_schedule",
        "get_my_info", "get_session_balance",
        "update_my_contact", "get_payment_info",
      ].includes(t.name)
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

You CAN help this client with:
- Book, cancel, reschedule appointments
- Check available slots
- View and manage their recurring schedules (list, skip weeks, cancel)
- Check their session balance and account info
- Get payment info (Venmo link)
- Update their email or phone

When using tools, pass "${client.name}" as the clientName.
Keep responses brief and text-message friendly.
IMPORTANT: All times are in ${tz}. Pass local times to tools.

IMPORTANT RULES:
- This client can only have ONE appointment per day. If they try to book a second one on the same day, the system will reject it.
- Before confirming a new booking, use list_appointments to check for same-day conflicts.
- When a client cancels, offer alternative slots for rebooking.
- When asked about sessions/balance, proactively mention if balance is low (≤ 2) and include payment info.

CRITICAL — NEVER ASSUME, ALWAYS VERIFY:
- After any booking or cancellation, call list_appointments to verify it actually happened before confirming to the client.
- If a tool returns an error, tell the client exactly what went wrong. Do not make up a success message.
- When asked about appointment status, ALWAYS call the tool. Never rely on memory from earlier in the conversation.`;

    const aiMessages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: message },
    ];

    let response = await this.anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: clientTools,
      messages: aiMessages,
    });

    // Agentic tool-use loop (client-initiated: enforce one-per-day)
    const MUTATION_TOOLS = new Set([
      "book_appointment", "cancel_appointment", "reschedule_appointment",
      "create_recurring_schedule", "skip_recurring_instance", "delete_recurring_schedule",
      "update_my_contact",
    ]);
    const instructorPhone = process.env.INSTRUCTOR_PHONE_NUMBER;

    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      aiMessages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          const result = await this.executeTool(
            block.name,
            block.input as Record<string, unknown>,
            { clientInitiated: true }
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });

          // Notify instructor of client-initiated mutations
          if (instructorPhone && MUTATION_TOOLS.has(block.name)) {
            try {
              const parsed = JSON.parse(result);
              if (parsed.success) {
                await this.trySendSms(
                  instructorPhone,
                  `[Client action] ${client.name}: ${parsed.message || block.name}`
                );
              }
            } catch { /* result parse failure — skip notification */ }
          }
        }
      }

      aiMessages.push({ role: "user", content: toolResults });

      response = await this.anthropic.messages.create({
        model: "claude-opus-4-6",
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
- IMPORTANT: All times the user mentions are in ${tz}. When calling tools that take dateTime params, pass the LOCAL time as ISO format (e.g., 2026-04-08T15:00:00). The system will handle UTC conversion.

CRITICAL RULES — VIOLATIONS CAUSE REAL-WORLD HARM:

1. ONLY STATE FACTS FROM TOOL RESPONSES. Never infer, assume, or fill in details the tool did not return. If a tool says "cancelled 11 appointments", say exactly that — do not add "Friday appointments should still be intact" unless a tool confirmed it.

2. AFTER EVERY MUTATION, YOU MUST CALL A READ TOOL BEFORE RESPONDING. This is mandatory, not optional.
   - After set_availability → call list_availability to confirm what was actually set
   - After book_appointment → call list_appointments to confirm the booking exists
   - After create_recurring_schedule → call list_recurring_schedules AND list_appointments to confirm
   - After cancel/reschedule → call list_appointments to confirm the new state
   Do NOT respond to the user until you have read back and confirmed the state.

3. NEVER ANSWER STATE QUESTIONS FROM MEMORY. If asked "does Umang have appointments?", call list_appointments. If asked "what are my hours?", call list_availability. Every. Single. Time.

4. REPORT ONLY WHAT THE TOOL RETURNED. Do not add commentary like "X should still be intact" or "Y was probably cancelled". If you're unsure about something, call a tool to check rather than guessing.

5. IF A TOOL RETURNS AN ERROR, report the exact error message. Do not rephrase it or soften it.`;
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
          "Set up one or more recurring weekly appointments for a client. ATOMIC: if multiple slots are requested, ALL must have availability or the entire operation fails. Pass all desired day/time pairs in a single call.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
            slots: {
              type: "array",
              description: "Array of recurring slots to create. All must pass availability checks or none are created.",
              items: {
                type: "object",
                properties: {
                  dayOfWeek: {
                    type: "string",
                    description: "Day of the week.",
                    enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
                  },
                  startTime: {
                    type: "string",
                    description: "Start time in HH:MM format (24-hour).",
                  },
                  endTime: {
                    type: "string",
                    description: "End time in HH:MM format (24-hour). Defaults to 1 hour after start.",
                  },
                },
                required: ["dayOfWeek", "startTime"],
              },
            },
            endDate: {
              type: "string",
              description: "Optional end date for the recurring schedule in YYYY-MM-DD format. If not provided, recurring continues until sessions run out.",
            },
          },
          required: ["clientName", "slots"],
        },
      },
      {
        name: "mark_completed",
        description:
          "Mark an appointment as completed. Deducts 1 session from client balance. Use at end of day or after a session finishes.",
        input_schema: {
          type: "object" as const,
          properties: {
            appointmentId: {
              type: "number",
              description: "The appointment ID to mark as completed.",
            },
          },
          required: ["appointmentId"],
        },
      },
      {
        name: "mark_no_show",
        description:
          "Mark a client as no-show for an appointment. By default does NOT deduct a session. Ask the instructor if they want to deduct before setting deductSession=true.",
        input_schema: {
          type: "object" as const,
          properties: {
            appointmentId: {
              type: "number",
              description: "The appointment ID to mark as no-show.",
            },
            deductSession: {
              type: "boolean",
              description: "Whether to deduct a session for the no-show. Default false. ASK the instructor before setting to true.",
            },
          },
          required: ["appointmentId"],
        },
      },
      {
        name: "reschedule_appointment",
        description:
          "Reschedule an existing appointment to a new date/time. Atomic: if the new slot is unavailable, the old appointment stays untouched. No session change.",
        input_schema: {
          type: "object" as const,
          properties: {
            appointmentId: {
              type: "number",
              description: "The appointment ID to reschedule.",
            },
            newDateTime: {
              type: "string",
              description: "New start date and time in ISO format (e.g., 2025-01-15T10:00:00).",
            },
          },
          required: ["appointmentId", "newDateTime"],
        },
      },
      {
        name: "list_recurring_schedules",
        description:
          "List recurring schedules for all clients or a specific client.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "Optional: filter by client name.",
            },
          },
        },
      },
      {
        name: "update_recurring_schedule",
        description:
          "Change the day or time of an existing recurring schedule. Regenerates future appointments.",
        input_schema: {
          type: "object" as const,
          properties: {
            scheduleId: {
              type: "number",
              description: "The recurring schedule ID to update.",
            },
            dayOfWeek: {
              type: "string",
              description: "New day of the week.",
              enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            },
            startTime: {
              type: "string",
              description: "New start time in HH:MM format (24-hour).",
            },
            endTime: {
              type: "string",
              description: "New end time in HH:MM format (24-hour).",
            },
          },
          required: ["scheduleId"],
        },
      },
      {
        name: "delete_recurring_schedule",
        description:
          "Delete a recurring schedule and cancel all its future appointments. ALWAYS ask for confirmation before calling this.",
        input_schema: {
          type: "object" as const,
          properties: {
            scheduleId: {
              type: "number",
              description: "The recurring schedule ID to delete.",
            },
          },
          required: ["scheduleId"],
        },
      },
      {
        name: "skip_recurring_instance",
        description:
          "Skip one or more weeks of a client's recurring appointment. The recurring rule stays active. No session deduction.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: {
              type: "string",
              description: "The client's name.",
            },
            scheduleId: {
              type: "number",
              description: "The recurring schedule ID.",
            },
            fromDate: {
              type: "string",
              description: "Start date for skipping in YYYY-MM-DD format.",
            },
            weeks: {
              type: "number",
              description: "Number of weeks to skip. Defaults to 1.",
            },
          },
          required: ["clientName", "scheduleId", "fromDate"],
        },
      },
      {
        name: "set_availability",
        description:
          "Set the instructor's regular weekly hours. This replaces ALL existing weekly rules. Days not included will have no availability. Appointments outside the new hours are automatically cancelled.",
        input_schema: {
          type: "object" as const,
          properties: {
            rules: {
              type: "array",
              description: "Array of availability rules.",
              items: {
                type: "object",
                properties: {
                  dayOfWeek: { type: "number", description: "0=Sunday, 1=Monday, ..., 6=Saturday" },
                  startTime: { type: "string", description: "Start time in HH:MM format." },
                  endTime: { type: "string", description: "End time in HH:MM format." },
                },
                required: ["dayOfWeek", "startTime", "endTime"],
              },
            },
          },
          required: ["rules"],
        },
      },
      {
        name: "list_availability",
        description:
          "View the instructor's current weekly hours, date overrides, and blocked times.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "override_availability",
        description:
          "Set a one-off availability override for a specific date. Use to add hours on an off-day or change hours for one day. Appointments outside the new window are cancelled.",
        input_schema: {
          type: "object" as const,
          properties: {
            date: { type: "string", description: "Date in YYYY-MM-DD format." },
            startTime: { type: "string", description: "Start time in HH:MM format." },
            endTime: { type: "string", description: "End time in HH:MM format." },
          },
          required: ["date", "startTime", "endTime"],
        },
      },
      {
        name: "remove_block",
        description: "Remove a previously blocked time slot to re-open it for bookings.",
        input_schema: {
          type: "object" as const,
          properties: {
            blockId: { type: "number", description: "The block ID to remove." },
          },
          required: ["blockId"],
        },
      },
      {
        name: "list_clients",
        description: "List all active clients, optionally filtered by name search.",
        input_schema: {
          type: "object" as const,
          properties: {
            search: { type: "string", description: "Optional search term to filter by name." },
          },
        },
      },
      {
        name: "update_client",
        description: "Update a client's contact details (name, phone, email, notes). Does NOT change session balance.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: { type: "string", description: "The client's current name (to find them)." },
            name: { type: "string", description: "New name." },
            phone: { type: "string", description: "New phone in E.164 format." },
            email: { type: "string", description: "New email." },
            notes: { type: "string", description: "New notes." },
          },
          required: ["clientName"],
        },
      },
      {
        name: "reactivate_client",
        description: "Reactivate a previously deactivated client.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: { type: "string", description: "The client's name." },
          },
          required: ["clientName"],
        },
      },
      {
        name: "delete_client",
        description:
          "PERMANENTLY delete a client and ALL their data (appointments, recurring schedules, session history, messages). This CANNOT be undone. ALWAYS ask the instructor for confirmation before calling this.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: { type: "string", description: "The client's name." },
          },
          required: ["clientName"],
        },
      },
      {
        name: "get_daily_summary",
        description: "Get today's summary: appointment count, upcoming list, and clients with low session balances.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "get_weekly_summary",
        description: "Get a week-at-a-glance: appointments per day and total count.",
        input_schema: {
          type: "object" as const,
          properties: {
            weekStart: { type: "string", description: "Optional start date (Monday) in YYYY-MM-DD. Defaults to current week." },
          },
        },
      },
      {
        name: "send_message",
        description: "Send an SMS message to a client.",
        input_schema: {
          type: "object" as const,
          properties: {
            clientName: { type: "string", description: "The client's name." },
            body: { type: "string", description: "The message text to send." },
          },
          required: ["clientName", "body"],
        },
      },
      // --- Client-only tools ---
      {
        name: "get_my_info",
        description: "Get the client's own profile: name, phone, email, package, sessions remaining, upcoming appointments, and recurring schedules.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "update_my_contact",
        description: "Update the client's own email or phone number. Cannot change name.",
        input_schema: {
          type: "object" as const,
          properties: {
            email: { type: "string", description: "New email address." },
            phone: { type: "string", description: "New phone number in E.164 format." },
          },
        },
      },
      {
        name: "get_payment_info",
        description: "Get payment information: session balance and how to purchase more sessions (Venmo link).",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    opts?: { clientInitiated?: boolean }
  ): Promise<string> {
    switch (name) {
      case "list_appointments":
        return this.toolListAppointments(input.date as string | undefined);

      case "book_appointment":
        return this.toolBookAppointment(
          input.clientName as string,
          input.dateTime as string,
          (input.duration as number) || 60,
          input.notes as string | undefined,
          opts?.clientInitiated
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
          input.slots as Array<{ dayOfWeek: string; startTime: string; endTime?: string }>,
          input.endDate as string | undefined
        );

      case "mark_completed":
        return this.toolMarkCompleted(input.appointmentId as number);

      case "mark_no_show":
        return this.toolMarkNoShow(
          input.appointmentId as number,
          (input.deductSession as boolean) ?? false
        );

      case "reschedule_appointment":
        return this.toolReschedule(
          input.appointmentId as number,
          input.newDateTime as string,
          opts?.clientInitiated
        );

      case "list_recurring_schedules":
        return this.toolListRecurring(input.clientName as string | undefined);

      case "update_recurring_schedule":
        return this.toolUpdateRecurring(
          input.scheduleId as number,
          input.dayOfWeek as string | undefined,
          input.startTime as string | undefined,
          input.endTime as string | undefined
        );

      case "delete_recurring_schedule":
        return this.toolDeleteRecurring(input.scheduleId as number);

      case "skip_recurring_instance":
        return this.toolSkipRecurring(
          input.clientName as string,
          input.scheduleId as number,
          input.fromDate as string,
          (input.weeks as number) ?? 1
        );

      case "set_availability":
        return this.toolSetAvailability(input.rules as Array<{ dayOfWeek: number; startTime: string; endTime: string }>);

      case "list_availability":
        return this.toolListAvailability();

      case "override_availability":
        return this.toolOverrideAvailability(
          input.date as string,
          input.startTime as string,
          input.endTime as string
        );

      case "remove_block":
        return this.toolRemoveBlock(input.blockId as number);

      case "list_clients":
        return this.toolListClients(input.search as string | undefined);

      case "update_client":
        return this.toolUpdateClient(
          input.clientName as string,
          input.name as string | undefined,
          input.phone as string | undefined,
          input.email as string | undefined,
          input.notes as string | undefined
        );

      case "reactivate_client":
        return this.toolReactivateClient(input.clientName as string);

      case "delete_client":
        return this.toolDeleteClient(input.clientName as string);

      case "get_daily_summary":
        return this.toolDailySummary();

      case "get_weekly_summary":
        return this.toolWeeklySummary(input.weekStart as string | undefined);

      case "send_message":
        return this.toolSendMessage(
          input.clientName as string,
          input.body as string
        );

      // --- Client-only tools ---
      case "get_my_info":
        return this.toolGetMyInfo(input.clientName as string);

      case "update_my_contact":
        return this.toolUpdateMyContact(
          input.clientName as string | undefined,
          input.email as string | undefined,
          input.phone as string | undefined
        );

      case "get_payment_info":
        return this.toolGetPaymentInfo(input.clientName as string | undefined);

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
    notes?: string,
    clientInitiated?: boolean
  ): Promise<string> {
    // Find client by name (case-insensitive partial match)
    const { client: matchedClient, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    // Convert local time to UTC for storage
    const startUTC = localToUTC(dateTime);

    // Delegate to scheduling service (handles past check, availability, conflicts, UTC format)
    const result = await bookAppointment(matchedClient!.id, startUTC, notes, { clientInitiated });
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    const appt = result.appointment!;

    // Show current session balance (sessions are deducted on completion, not booking)
    let sessionInfo = "";
    if (matchedClient!.sessionsRemaining !== null) {
      sessionInfo = ` Sessions remaining: ${matchedClient!.sessionsRemaining}.`;
      if (matchedClient!.sessionsRemaining! <= 2) {
        sessionInfo += ` WARNING: Low session balance!`;
      }
    }

    const startFormatted = formatLocalTimeShort(appt.startTime);

    // SMS: booking confirmation
    const localStart = utcToLocal(appt.startTime);
    const dateStr = localStart.slice(0, 10);
    const timeStr = localStart.slice(11, 16);
    await this.trySendSms(matchedClient!.phone, `Your appointment is confirmed for ${dateStr} at ${timeStr}. See you then!`);

    return JSON.stringify({
      success: true,
      appointmentId: appt.id,
      client: matchedClient!.name,
      start: appt.startTime,
      end: appt.endTime,
      formatted: `Booked ${matchedClient!.name} for ${dateStr} at ${startFormatted}.${sessionInfo}`,
      _verify: "Call list_appointments for this date to confirm the booking exists.",
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

    // SMS: cancellation notice
    const client = db.select().from(clients).where(eq(clients.id, appt.clientId)).get();
    if (client) {
      const localStart = utcToLocal(appt.startTime);
      await this.trySendSms(client.phone, `Your appointment on ${localStart.slice(0, 10)} at ${localStart.slice(11, 16)} has been cancelled.`);
    }

    return JSON.stringify({
      success: true,
      message: `Cancelled ${appt.clientName}'s appointment on ${utcToLocal(appt.startTime).slice(0, 10)} at ${formatLocalTimeShort(appt.startTime)}.${refundInfo}`,
      _verify: "Call list_appointments to confirm the cancellation.",
    });
  }

  private async toolGetClientInfo(clientName: string): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName, { includeInactive: true });
    if (error) return JSON.stringify({ error });

    const results = [];
    for (const client of [matched!]) {
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
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    // Get recent ledger entries
    const ledger = db
      .select()
      .from(sessionLedger)
      .where(eq(sessionLedger.clientId, matched!.id))
      .orderBy(desc(sessionLedger.createdAt))
      .limit(5)
      .all();

    return JSON.stringify({
      client: matched!.name,
      packageType: matched!.packageType,
      sessionsRemaining: matched!.sessionsRemaining,
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

    // SMS: welcome message
    await this.trySendSms(phone, `Welcome! You've been added to your trainer's schedule. Reply to this number to book or manage appointments.`);

    return JSON.stringify({
      success: true,
      clientId,
      message: `Added ${name} (${phone})${pkg ? ` with ${pkg} package (${sessionCount} sessions)` : ""}.`,
      _verify: "Call get_client_info to confirm the client was added.",
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
      dayOfWeek: DAY_NAMES[dayOfWeek],
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
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    db.update(clients)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(clients.id, matched!.id))
      .run();

    // Deactivate their recurring schedules too
    db.update(recurringSchedules)
      .set({ active: 0, updatedAt: new Date().toISOString() })
      .where(eq(recurringSchedules.clientId, matched!.id))
      .run();

    return JSON.stringify({
      success: true,
      message: `Deactivated ${matched!.name}. They won't appear in active client lists. Their appointment history is preserved.`,
      _verify: "Call get_client_info to confirm deactivation.",
    });
  }

  private async toolUpdateClientSessions(
    clientName: string,
    sessions: number,
    mode: string,
    packageType?: string
  ): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    const currentBalance = matched!.sessionsRemaining ?? 0;
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
      .where(eq(clients.id, matched!.id))
      .run();

    // Log to session ledger
    const change = newBalance - currentBalance;
    if (change !== 0) {
      db.insert(sessionLedger)
        .values({
          clientId: matched!.id,
          changeAmount: change,
          balanceAfter: newBalance,
          reason: mode === "add" ? "Sessions added" : "Balance updated",
        })
        .run();
    }

    // Auto-generate recurring appointments for the new balance
    await generateForClient(matched!.id);

    // SMS: balance update notification
    await this.trySendSms(matched!.phone, `Your session balance has been updated. You now have ${newBalance} sessions remaining.`);

    return JSON.stringify({
      success: true,
      client: matched!.name,
      previousBalance: currentBalance,
      newBalance,
      packageType: packageType || matched!.packageType,
      message: `Updated ${matched!.name}'s sessions from ${currentBalance} to ${newBalance}.${packageType ? ` Package: ${packageType}.` : ""}`,
      _verify: "Call get_session_balance to confirm the new balance.",
    });
  }

  private async toolCreateRecurring(
    clientName: string,
    slots: Array<{ dayOfWeek: string; startTime: string; endTime?: string }>,
    endDate?: string
  ): Promise<string> {
    if (!slots || slots.length === 0) {
      return JSON.stringify({ error: "No slots provided." });
    }

    // Find client
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    // --- Phase 1: Validate ALL slots before creating any (atomic) ---

    const parsedSlots: Array<{ dayOfWeek: number; dayName: string; startTime: string; endTime: string }> = [];
    const failures: string[] = [];

    for (const slot of slots) {
      const dayOfWeek = DAY_MAP[slot.dayOfWeek];
      if (dayOfWeek === undefined) {
        failures.push(`Invalid day: ${slot.dayOfWeek}`);
        continue;
      }

      const slotEnd = slot.endTime || (() => {
        const [h, m] = slot.startTime.split(":").map(Number);
        return `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      })();

      // Check for duplicate
      const existing = db
        .select()
        .from(recurringSchedules)
        .where(
          and(
            eq(recurringSchedules.clientId, matched!.id),
            eq(recurringSchedules.dayOfWeek, dayOfWeek),
            eq(recurringSchedules.startTime, slot.startTime)
          )
        )
        .get();

      if (existing) {
        failures.push(`${matched!.name} already has a recurring ${slot.dayOfWeek} at ${slot.startTime}`);
        continue;
      }

      // Check availability for this day/time
      const availRules = db
        .select()
        .from(availability)
        .all()
        .filter((a) => a.dayOfWeek === dayOfWeek && !a.isBlocked && !a.overrideDate);

      const withinAvail = availRules.some(
        (w) => slot.startTime >= w.startTime && slotEnd <= w.endTime
      );

      if (!withinAvail) {
        failures.push(`No availability on ${slot.dayOfWeek}s for ${slot.startTime}-${slotEnd}. Set your hours first.`);
        continue;
      }

      parsedSlots.push({ dayOfWeek, dayName: slot.dayOfWeek, startTime: slot.startTime, endTime: slotEnd });
    }

    // If ANY slot failed validation, reject the ENTIRE operation
    if (failures.length > 0) {
      return JSON.stringify({
        error: `Cannot create recurring schedule — some slots failed validation. Fix these first:\n${failures.map(f => `• ${f}`).join("\n")}\n\nNo schedules were created.`,
      });
    }

    // --- Phase 2: All validated — create all schedules ---

    for (const slot of parsedSlots) {
      db.insert(recurringSchedules)
        .values({
          clientId: matched!.id,
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          endDate: endDate || null,
          active: 1,
        })
        .run();
    }

    // Delete existing recurring appointments for this client and regenerate
    const existingRecurring = db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, matched!.id),
          eq(appointments.status, "confirmed")
        )
      )
      .all()
      .filter((a) => a.recurringScheduleId != null && a.startTime > new Date().toISOString());

    for (const appt of existingRecurring) {
      db.delete(appointments).where(eq(appointments.id, appt.id)).run();
    }

    // Regenerate all recurring appointments with fair distribution
    const generated = await generateForClient(matched!.id);

    // SMS: recurring schedule confirmation
    const slotSummary = parsedSlots.map(s => `${s.dayName}s at ${s.startTime}`).join(" and ");
    await this.trySendSms(matched!.phone, `You're booked for ${slotSummary}. See you next week!`);

    return JSON.stringify({
      success: true,
      message: `Created ${parsedSlots.length} recurring schedule(s) for ${matched!.name}: ${slotSummary}. Generated ${generated.created} upcoming appointments.`,
      _verify: "Call list_recurring_schedules and list_appointments to confirm schedules and generated appointments.",
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

  // ---- New tool implementations ----

  private async toolMarkCompleted(appointmentId: number): Promise<string> {
    const result = await completeAppointment(appointmentId);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // Build a descriptive message with client name + date/time
    const appt = db.select().from(appointments).where(eq(appointments.id, appointmentId)).get();
    let desc = `appointment #${appointmentId}`;
    if (appt) {
      const client = db.select().from(clients).where(eq(clients.id, appt.clientId)).get();
      const localStart = utcToLocal(appt.startTime);
      desc = `${client?.name || "Client"}'s ${localStart.slice(0, 10)} at ${formatLocalTimeShort(appt.startTime)} appointment`;

      if (client && (client.sessionsRemaining ?? 0) <= 0) {
        return JSON.stringify({
          success: true,
          warning: `${client.name} has ${client.sessionsRemaining} sessions remaining. They need to purchase more.`,
          message: `Marked ${desc} as completed.`,
          _verify: "Call list_appointments to confirm the status change.",
        });
      }
    }

    return JSON.stringify({ success: true, message: `Marked ${desc} as completed.`, _verify: "Call list_appointments to confirm the status change." });
  }

  private async toolMarkNoShow(appointmentId: number, deductSession: boolean): Promise<string> {
    const appt = db
      .select({ clientId: appointments.clientId, startTime: appointments.startTime, clientName: clients.name, clientPhone: clients.phone })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(eq(appointments.id, appointmentId))
      .get();

    const result = await markNoShow(appointmentId, deductSession);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: missed session notice
    if (appt) {
      const localStart = utcToLocal(appt.startTime);
      await this.trySendSms(appt.clientPhone, `You missed your session on ${localStart.slice(0, 10)} at ${localStart.slice(11, 16)}. Please reach out to reschedule.`);
    }

    const deductMsg = deductSession ? " Session deducted." : " No session deducted.";
    const noShowDesc = appt
      ? `${appt.clientName}'s ${utcToLocal(appt.startTime).slice(0, 10)} at ${formatLocalTimeShort(appt.startTime)} appointment`
      : `appointment #${appointmentId}`;
    return JSON.stringify({
      success: true,
      message: `Marked ${noShowDesc} as no-show.${deductMsg}`,
      _verify: "Call list_appointments to confirm the status change.",
    });
  }

  private async toolReschedule(appointmentId: number, newDateTime: string, clientInitiated?: boolean): Promise<string> {
    // Look up original appointment for SMS
    const original = db
      .select({ clientId: appointments.clientId, startTime: appointments.startTime, clientName: clients.name, clientPhone: clients.phone })
      .from(appointments)
      .innerJoin(clients, eq(appointments.clientId, clients.id))
      .where(eq(appointments.id, appointmentId))
      .get();

    const newStartUTC = localToUTC(newDateTime);
    const result = await rescheduleAppointment(appointmentId, newStartUTC, undefined, { clientInitiated });
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: rescheduled notice
    if (original && result.appointment) {
      const oldLocal = utcToLocal(original.startTime);
      const newLocal = utcToLocal(result.appointment.startTime);
      await this.trySendSms(
        original.clientPhone,
        `Your appointment has been rescheduled from ${oldLocal.slice(0, 10)} at ${oldLocal.slice(11, 16)} to ${newLocal.slice(0, 10)} at ${newLocal.slice(11, 16)}.`
      );
    }

    return JSON.stringify({
      success: true,
      appointmentId: result.appointment!.id,
      message: `Rescheduled ${original?.clientName || "appointment"} from ${original ? utcToLocal(original.startTime).slice(0, 10) + " at " + formatLocalTimeShort(original.startTime) : "old time"} to ${utcToLocal(result.appointment!.startTime).slice(0, 10)} at ${formatLocalTimeShort(result.appointment!.startTime)}.`,
      _verify: "Call list_appointments for the new date to confirm the reschedule.",
    });
  }

  private async toolListRecurring(clientName?: string): Promise<string> {
    let clientId: number | undefined;
    if (clientName) {
      const allClients = db.select().from(clients).where(eq(clients.active, 1)).all();
      const matched = allClients.find((c) => c.name.toLowerCase().includes(clientName.toLowerCase()));
      if (!matched) {
        return JSON.stringify({ error: `No client found matching "${clientName}".` });
      }
      clientId = matched.id;
    }

    const schedules = await listRecurringSchedules(clientId);

    return JSON.stringify({
      count: schedules.length,
      schedules: schedules.map((s) => ({
        id: s.id,
        client: s.clientName,
        day: DAY_NAMES[s.dayOfWeek],
        startTime: s.startTime,
        endTime: s.endTime,
        active: s.active === 1,
      })),
    });
  }

  private async toolUpdateRecurring(
    scheduleId: number,
    dayOfWeekStr?: string,
    startTime?: string,
    endTime?: string
  ): Promise<string> {
    // Look up schedule for SMS context
    const schedule = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, scheduleId)).get();
    const clientBefore = schedule
      ? db.select().from(clients).where(eq(clients.id, schedule.clientId)).get()
      : null;
    const oldDay = schedule ? DAY_NAMES[schedule.dayOfWeek] : "";
    const oldTime = schedule?.startTime ?? "";

    const updates: { dayOfWeek?: number; startTime?: string; endTime?: string } = {};
    if (dayOfWeekStr) updates.dayOfWeek = DAY_MAP[dayOfWeekStr];
    if (startTime) updates.startTime = startTime;
    if (endTime) updates.endTime = endTime;

    const result = await updateRecurringSchedule(scheduleId, updates);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: schedule change notice
    if (clientBefore) {
      const newDay = dayOfWeekStr || oldDay;
      const newTime = startTime || oldTime;
      await this.trySendSms(
        clientBefore.phone,
        `Your recurring session has moved from ${oldDay}s at ${oldTime} to ${newDay}s at ${newTime}.`
      );
    }

    const newDay = dayOfWeekStr || oldDay;
    const newTime = startTime || oldTime;
    return JSON.stringify({ success: true, message: `Updated ${clientBefore?.name || "client"}'s recurring from ${oldDay}s at ${oldTime} to ${newDay}s at ${newTime}.`, _verify: "Call list_recurring_schedules to confirm the update." });
  }

  private async toolDeleteRecurring(scheduleId: number): Promise<string> {
    // Look up for SMS context before deleting
    const schedule = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, scheduleId)).get();
    const client = schedule
      ? db.select().from(clients).where(eq(clients.id, schedule.clientId)).get()
      : null;

    const result = await deleteRecurringSchedule(scheduleId);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: recurring cancelled
    if (client && schedule) {
      await this.trySendSms(
        client.phone,
        `Your recurring ${DAY_NAMES[schedule.dayOfWeek]} at ${schedule.startTime} session has been cancelled. Please reach out if you'd like to reschedule.`
      );
    }

    const delDesc = client && schedule
      ? `Deleted ${client.name}'s recurring ${DAY_NAMES[schedule.dayOfWeek]} at ${schedule.startTime} and cancelled future appointments.`
      : `Deleted recurring schedule #${scheduleId} and cancelled future appointments.`;
    return JSON.stringify({ success: true, message: delDesc, _verify: "Call list_recurring_schedules to confirm deletion." });
  }

  private async toolSkipRecurring(
    clientName: string,
    scheduleId: number,
    fromDate: string,
    weeks: number
  ): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    const result = await skipRecurringInstance(matched!.id, scheduleId, fromDate, weeks);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: per skipped week -- use cancelledStartTimes from the result directly (no re-query)
    for (const startTime of result.cancelledStartTimes) {
      const localStart = utcToLocal(startTime);
      await this.trySendSms(
        matched!.phone,
        `Your session on ${localStart.slice(0, 10)} at ${localStart.slice(11, 16)} has been cancelled. Your recurring schedule continues as normal after that.`
      );
    }

    return JSON.stringify({
      success: true,
      skipped: result.skipped,
      message: `Skipped ${result.skipped} week(s) for ${matched!.name}: ${result.cancelledStartTimes.map(t => utcToLocal(t).slice(0, 10)).join(", ")}.`,
      _verify: "Call list_appointments to confirm the skipped weeks.",
    });
  }

  private async toolSetAvailability(
    rules: Array<{ dayOfWeek: number; startTime: string; endTime: string }>
  ): Promise<string> {
    const result = await setAvailability(rules);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    const summary = rules.map((r) => `${DAY_NAMES[r.dayOfWeek]} ${r.startTime}-${r.endTime}`).join(", ");
    let msg = `Availability set: ${summary}.`;

    if (result.cancelledAppointments.length > 0) {
      const cancelled = result.cancelledAppointments
        .map((c) => `${c.clientName} on ${c.startTime.slice(0, 10)} at ${c.startTime.slice(11, 16)}`)
        .join(", ");
      msg += ` Cancelled ${result.cancelledAppointments.length} appointment(s): ${cancelled}. Affected clients have been notified.`;
    }

    return JSON.stringify({
      success: true,
      message: msg,
      _action: "set_availability",
      _verify: "You MUST now call list_availability to confirm the actual state before responding to the user.",
    });
  }

  private async toolListAvailability(): Promise<string> {
    const result = await listAvailability();

    return JSON.stringify({
      recurring: result.recurring.map((r) => ({
        id: r.id,
        day: r.dayOfWeek !== null ? DAY_NAMES[r.dayOfWeek] : null,
        startTime: r.startTime,
        endTime: r.endTime,
      })),
      overrides: result.overrides.map((o) => ({
        id: o.id,
        date: o.overrideDate,
        startTime: o.startTime,
        endTime: o.endTime,
      })),
      blocks: result.blocks.map((b) => ({
        id: b.id,
        date: b.overrideDate,
        day: b.dayOfWeek !== null ? DAY_NAMES[b.dayOfWeek] : null,
        startTime: b.startTime,
        endTime: b.endTime,
      })),
    });
  }

  private async toolOverrideAvailability(
    date: string,
    startTime: string,
    endTime: string
  ): Promise<string> {
    const result = await overrideAvailability(date, startTime, endTime);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    let msg = `Set availability override for ${date}: ${startTime}-${endTime}.`;
    if (result.cancelledAppointments.length > 0) {
      const cancelled = result.cancelledAppointments
        .map((c) => `${c.clientName} at ${c.startTime.slice(11, 16)}`)
        .join(", ");
      msg += ` Cancelled ${result.cancelledAppointments.length} appointment(s): ${cancelled}. Affected clients have been notified.`;
    }

    return JSON.stringify({ success: true, message: msg, _verify: "Call list_availability to confirm the override." });
  }

  private async toolRemoveBlock(blockId: number): Promise<string> {
    const result = await removeBlock(blockId);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }
    return JSON.stringify({ success: true, message: `Removed block #${blockId}. That time is now open for bookings.` });
  }

  private async toolListClients(search?: string): Promise<string> {
    const result = await listClients(search);
    return JSON.stringify({
      count: result.length,
      clients: result.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        packageType: c.packageType,
        sessionsRemaining: c.sessionsRemaining,
      })),
    });
  }

  private async toolUpdateClient(
    clientName: string,
    name?: string,
    phone?: string,
    email?: string,
    notes?: string
  ): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName, { includeInactive: true });
    if (error) return JSON.stringify({ error });

    const result = await updateClient(matched!.id, { name, phone, email, notes });
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }
    return JSON.stringify({ success: true, message: `Updated ${matched!.name}'s details.`, _verify: "Call get_client_info to confirm the update." });
  }

  private async toolReactivateClient(clientName: string): Promise<string> {
    // Search all clients including inactive
    const { client: matched, error } = this.resolveClient(clientName, { includeInactive: true });
    if (error) return JSON.stringify({ error });

    const result = await reactivateClient(matched!.id);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // SMS: welcome back
    await this.trySendSms(matched!.phone, `You've been reactivated! Reply to this number to book sessions.`);

    return JSON.stringify({ success: true, message: `Reactivated ${matched!.name}.`, _verify: "Call get_client_info to confirm reactivation." });
  }

  private async toolDeleteClient(clientName: string): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName, { includeInactive: true });
    if (error) return JSON.stringify({ error });

    // Send farewell SMS BEFORE deleting (phone number lives on client record)
    await this.trySendSms(
      matched!.phone,
      `Your account has been removed. Thank you for training with us.`
    );

    const result = await deleteClient(matched!.id);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    return JSON.stringify({
      success: true,
      message: `Permanently deleted ${matched!.name} and all their data (appointments, recurring schedules, session history, messages).`,
      _verify: "Call list_clients to confirm deletion.",
    });
  }

  private async toolDailySummary(): Promise<string> {
    const result = await getDailySummary();
    return JSON.stringify({
      today: todayLocal(),
      appointmentCount: result.todayCount,
      upcoming: result.upcoming,
      lowBalanceClients: result.lowBalanceClients,
    });
  }

  private async toolWeeklySummary(weekStart?: string): Promise<string> {
    const result = await getWeeklySummary(weekStart);
    return JSON.stringify({
      totalAppointments: result.totalCount,
      days: result.days,
    });
  }

  private async toolSendMessage(clientName: string, body: string): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    const result = await sendMessageToClient(matched!.id, body);
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    return JSON.stringify({ success: true, message: `Message sent to ${matched!.name}.` });
  }

  // --- Client-only tool handlers ---

  private async toolGetMyInfo(clientName: string): Promise<string> {
    const { client: matched, error } = this.resolveClient(clientName, { includeInactive: true });
    if (error) return JSON.stringify({ error });

    // Upcoming appointments
    const now = new Date().toISOString();
    const upcoming = db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, matched!.id),
          eq(appointments.status, "confirmed"),
          gte(appointments.startTime, now)
        )
      )
      .all()
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 10);

    // Recurring schedules
    const schedules = await listRecurringSchedules(matched!.id);

    // Session ledger (recent)
    const ledger = db
      .select()
      .from(sessionLedger)
      .where(eq(sessionLedger.clientId, matched!.id))
      .orderBy(desc(sessionLedger.createdAt))
      .limit(5)
      .all();

    return JSON.stringify({
      name: matched!.name,
      phone: matched!.phone,
      email: matched!.email,
      packageType: matched!.packageType,
      sessionsRemaining: matched!.sessionsRemaining,
      upcomingAppointments: upcoming.map((a) => ({
        id: a.id,
        start: utcToLocal(a.startTime),
        end: utcToLocal(a.endTime),
        notes: a.notes,
      })),
      recurringSchedules: schedules.map((s) => ({
        id: s.id,
        day: DAY_NAMES[s.dayOfWeek],
        startTime: s.startTime,
        endTime: s.endTime,
        active: s.active === 1,
      })),
      recentActivity: ledger.map((l) => ({
        change: l.changeAmount,
        balance: l.balanceAfter,
        reason: l.reason,
        date: l.createdAt,
      })),
    });
  }

  private async toolUpdateMyContact(
    clientName: string | undefined,
    email?: string,
    phone?: string
  ): Promise<string> {
    if (!clientName) return JSON.stringify({ error: "Client name required." });
    const { client: matched, error } = this.resolveClient(clientName);
    if (error) return JSON.stringify({ error });

    if (!email && !phone) {
      return JSON.stringify({ error: "Provide at least an email or phone to update." });
    }

    const result = await updateMyContact(matched!.id, { email, phone });
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }

    // Notify instructor
    const instructorPhone = process.env.INSTRUCTOR_PHONE_NUMBER;
    if (instructorPhone) {
      const fields = [email && "email", phone && "phone"].filter(Boolean).join(" and ");
      await this.trySendSms(instructorPhone, `${matched!.name} updated their ${fields}.`);
    }

    const updatedMsg = phone
      ? `Contact updated. You'll receive messages at your new number going forward.`
      : `Contact updated.`;

    return JSON.stringify({
      success: true,
      message: updatedMsg,
      _verify: "Call get_my_info to confirm the update.",
    });
  }

  private async toolGetPaymentInfo(clientName?: string): Promise<string> {
    // Get instructor Venmo handle
    const inst = db.select().from(instructor).get();
    const venmoHandle = inst?.venmoHandle || null;

    if (clientName) {
      const { client: matched, error } = this.resolveClient(clientName);
      if (error) return JSON.stringify({ error });

      return JSON.stringify({
        sessionsRemaining: matched!.sessionsRemaining,
        packageType: matched!.packageType,
        venmoHandle,
        message: venmoHandle
          ? `You have ${matched!.sessionsRemaining ?? 0} sessions remaining. To purchase more, Venmo: ${venmoHandle}. Your trainer will update your balance once payment is received.`
          : `You have ${matched!.sessionsRemaining ?? 0} sessions remaining. Please contact your trainer to purchase more sessions.`,
      });
    }

    return JSON.stringify({
      venmoHandle,
      message: venmoHandle
        ? `To purchase sessions, Venmo: ${venmoHandle}. Your trainer will update your balance.`
        : `Please contact your trainer to purchase sessions.`,
    });
  }
}

export const chatAgent = new ChatAgent();
