# 05 — Client Messaging

## What

Automated outbound messaging to clients for appointment confirmations, reminders, and change handling. Messages are AI-composed using the instructor's voice profile rather than rigid templates.

## How

### Day-Before Confirmation

1. A cron job runs at **6:00 PM** daily.
2. Queries all confirmed appointments for **tomorrow**.
3. For each appointment, composes a confirmation message via Claude using:
   - Client's name.
   - Appointment date and time.
   - The voice profile (tone, slang, emoji preferences).
4. Sends the message via Twilio SMS to the client's phone number.
5. Stores the message in the `messages` table (direction: outbound, sender_type: ai, channel: sms).

Example output (voice-dependent):
> "Hey Sarah! Just confirming your session tomorrow at 10am. See you there!"

### Client Reply Handling

When a client replies via SMS:

1. Twilio webhook `POST /api/webhooks/twilio/client` receives the message.
2. Server looks up the client by phone number.
3. Message is saved to `messages` (direction: inbound, sender_type: client).
4. Claude classifies the reply into one of:

| Classification | Example replies                     | Action                                    |
|----------------|-------------------------------------|-------------------------------------------|
| confirm        | "See you then!", "Sounds good"      | No action needed; log confirmation        |
| cancel         | "Can't make it", "Need to cancel"   | Cancel appointment, trigger alt-slot flow |
| reschedule     | "Can we do 2pm instead?"            | Check availability, propose options       |
| question       | "What time was it again?"           | Look up and reply with appointment info   |
| ambiguous      | "Hmm maybe"                         | Ask a clarifying follow-up question       |

5. AI composes a reply using the voice profile and sends it.
6. All outbound replies are saved to `messages`.

### Cancellation Flow

When a client cancels:

1. The appointment status is updated to `cancelled`.
2. Session ledger: if a session was pre-decremented, a +1 adjustment is recorded.
3. AI composes a message offering the next 3 available slots for rescheduling.
4. If the client picks a new slot, a new appointment is created.
5. Instructor is notified via SMS: "Heads up — Sarah cancelled her Thursday 10am. She rebooked for Friday 2pm."

### Instructor Notifications

The instructor receives an SMS notification when:

- A client cancels an appointment.
- A client reschedules.
- A client sends a reply that is classified as ambiguous (so the instructor can step in).
- A new client books via the open booking flow (see spec 07).

### Rate Limiting

- Maximum 1 outbound message per client per hour (excluding direct replies to inbound messages).
- No messages sent before 8:00 AM or after 9:00 PM local time. Messages queued outside this window are held until 8:00 AM.

## Validation Plan

1. **Confirmation generation**: Run the cron logic with 3 appointments tomorrow; verify 3 unique, voice-matched messages are produced.
2. **Reply classification**: Feed 30+ sample client replies through the classifier; assert >= 90% correct classification.
3. **Cancellation flow**: Simulate a "can't make it" reply; verify appointment cancelled, session restored, alternative slots offered.
4. **Instructor notification**: Cancel a client session; verify the instructor receives a notification SMS.
5. **Rate limiting**: Attempt to send 3 messages to the same client within an hour; verify only the first goes through.
6. **Quiet hours**: Queue a message at 10:00 PM; verify it is held and sent at 8:00 AM the next day.
