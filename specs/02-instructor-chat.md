# 02 — Instructor Chat Interface

## What

A natural-language SMS interface that lets the instructor manage their schedule, clients, and availability by texting the system. Claude interprets commands, executes actions, and replies with confirmations.

## How

### Message Flow

1. Instructor texts the Twilio number.
2. Twilio webhook `POST /api/webhooks/twilio/instructor` delivers the message.
3. Server identifies the sender as the instructor (single known phone number stored in env).
4. Message is saved to the `messages` table (direction: inbound, sender_type: instructor).
5. The message, along with a system prompt, is sent to the Claude API.
6. Claude returns a structured response: an action to execute (if any) and a human-readable reply.
7. Server executes the action (DB write), then sends the reply via Twilio SMS.
8. Outbound reply is saved to `messages` (direction: outbound, sender_type: ai).

### System Prompt Context

Each request to Claude includes:

- Current date and time.
- Today's schedule (all appointments for the day).
- Client list with names, phone numbers, package types, and remaining sessions.
- Current availability rules (hours, blocks).
- The last 10 messages in the instructor conversation for continuity.

### Supported Intents

| Intent              | Example input                          | Action                              |
|---------------------|----------------------------------------|-------------------------------------|
| View schedule       | "What's my schedule today?"            | Query appointments, return list     |
| Book appointment    | "Book Sarah at 3pm tomorrow"           | Insert appointment, decrement check |
| Cancel appointment  | "Cancel Mike's Thursday session"       | Update status → cancelled           |
| Check balances      | "How many sessions does Jake have?"    | Query client sessions_remaining     |
| Block time          | "Block off Friday afternoon"           | Insert availability block           |
| Add client          | "Add new client Jess, 555-1234, 10-pack" | Insert client row                |
| View client info    | "Tell me about Sarah"                  | Return client record + recent msgs  |

Claude uses tool-calling to map intents to specific functions. Unrecognized intents get a friendly "I didn't understand" reply with suggestions.

### Morning Briefing

- A cron job (node-cron) fires at **7:00 AM** local time daily.
- Queries all confirmed appointments for the day.
- Composes a summary via Claude using the voice profile.
- Sends it to the instructor via Twilio SMS.
- Saved as a system-channel outbound message.

### Error Handling

- If a booking would double-book, reply with the conflict and suggest the next available slot.
- If a client name is ambiguous, reply asking for clarification.
- Twilio delivery failures are logged; retried once after 60 seconds.

## Validation Plan

1. **Intent parsing tests**: Feed 20+ sample messages to the Claude prompt; assert correct intent classification and parameter extraction.
2. **End-to-end flow**: Simulate a Twilio webhook POST; verify DB writes and SMS response.
3. **Context window**: Confirm the system prompt stays within token limits with 50+ clients and a full day of appointments.
4. **Morning briefing**: Mock the cron trigger; verify correct schedule summary is sent.
5. **Ambiguity handling**: Send "Book Alex" when two clients named Alex exist; verify the system asks for clarification.
