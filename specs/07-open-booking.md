# 07 — Open Booking (Public Inbound)

## What

Allows unknown (new) phone numbers to text the system, inquire about availability, and book sessions. This turns the Twilio number into a public booking line.

## How

### Inbound Message Routing

1. Twilio webhook `POST /api/webhooks/twilio/inbound` receives all inbound SMS.
2. Server checks the sender's phone number:
   - **Known instructor phone** → route to instructor chat (spec 02).
   - **Known client phone** → route to client reply handler (spec 05).
   - **Unknown phone** → route to open booking flow (this spec).

### Conversation Flow

The AI guides unknown callers through a structured conversation:

#### Step 1 — Greeting & Intent

> "Hey! This is [Instructor Name]'s scheduling assistant. Looking to book a training session?"

If the person says yes or asks about availability, proceed. If unrelated, reply politely that this number is for booking only.

#### Step 2 — Show Availability

- Ask what day they are interested in (or default to the next 3 days).
- Query `getAvailableSlots()` for the requested date(s).
- Present open slots in a friendly format:
  > "Here's what's open on Thursday: 8am, 10am, 11am, 2pm, 4pm. What works for you?"

#### Step 3 — Collect Booking Details

- Client picks a slot.
- AI asks for their name: "Great! What's your name so I can get you on the books?"
- Optional: ask for email.

#### Step 4 — Confirm & Create

- Create a new `clients` row (package_type: 'single', sessions_remaining: 1).
- Create a confirmed `appointments` row.
- Send confirmation:
  > "You're all set, Jake! Thursday at 10am. [Instructor] will see you then. Reply here if anything changes."

#### Step 5 — Notify Instructor

- Send the instructor an SMS:
  > "New booking! Jake (555-0199) booked Thursday 10am via text."

### Waitlist

If no slots are available for the requested day:

1. AI replies: "Thursday is fully booked. Want me to put you on the waitlist? I'll text you if something opens up."
2. If yes, store a record in a lightweight `waitlist` array in the messages context (v1: no dedicated table; tracked via message history and a tag in the client notes).
3. When a cancellation opens a slot, check recent waitlist inquiries and notify them.

### Spam & Abuse Prevention

- If an unknown number sends more than 10 messages without completing a booking, stop responding and notify the instructor.
- No outbound messages to unknown numbers unless they initiated the conversation.

### Client Conversion

Once a booking is completed, the phone number is stored in the `clients` table. Future messages from this number route to the client reply handler (spec 05) instead of the open booking flow.

## Validation Plan

1. **Happy path**: Simulate a new number texting in; walk through the full flow; verify client created, appointment booked, instructor notified.
2. **Availability display**: Request a day with 3 open slots; verify all 3 are listed correctly.
3. **Fully booked**: Request a day with zero slots; verify waitlist offer.
4. **Routing transition**: After booking, send another message from the same number; verify it routes to the client handler, not open booking.
5. **Spam guard**: Send 11 messages from an unknown number without booking; verify the system stops responding after 10.
6. **Instructor notification**: Complete a booking; verify the instructor receives the notification SMS with client name, phone, and appointment time.
