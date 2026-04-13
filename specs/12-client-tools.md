# Client Chat Tools — Spec

Clients interact with the system primarily via SMS. The AI assistant manages their
bookings and provides information — all through text conversation.

This file is the source of truth for what tools clients have access to.

---

## Invariants — shared with instructor spec

All invariants from `11-instructor-tools.md` apply to client-initiated actions too:

- **Conflict checking** — same 3 checks (no double-booking, within availability, not blocked).
- **Session balance gate** — clients cannot book if `sessionsRemaining == 0`.
- **Never Assume, Always Verify** — AI must call read tools after mutations before confirming.
- **Atomicity** — no partial creates.

### Client-specific constraints

1. **Clients can only see/modify their own data.** No tool should expose other clients' names, appointments, or balances.
2. **Clients cannot change session balances, availability, or instructor settings.** These are instructor-only.
3. **Clients cannot mark appointments as completed or no-show.** Only the instructor controls session lifecycle.
4. **Destructive actions require confirmation.** Cancellations and recurring deletions must be confirmed before executing.
5. **Instructor is notified of all client-initiated changes.** When a client books, cancels, reschedules, or modifies their recurring schedule, the instructor gets an SMS notification.
6. **One appointment per day per client.** A client cannot have two confirmed appointments on the same calendar day. This is enforced at the service layer (not just the AI prompt). Applies to:
   - `book_appointment` — reject if client already has a confirmed appointment on that date.
   - `reschedule_appointment` — reject if the new date already has a confirmed appointment for this client (excluding the one being rescheduled).
   - `create_recurring_schedule` — if two recurring slots land on the same day of the week (e.g., two different times on Tuesday), reject the entire operation.
   - `skip_recurring_instance` — no check needed (skipping reduces, not adds).
   - `cancel_appointment` — no check needed (cancelling reduces, not adds).
   The instructor can override this via their own tools if needed (e.g., a double session day), but client-initiated bookings enforce the limit strictly.

---

## 1. Appointments

| Tool | Status | Description | Session effect | Client SMS | Instructor notification |
|------|--------|-------------|----------------|------------|------------------------|
| `list_appointments` | Exists | List the client's own upcoming appointments. Filtered to `clientId` automatically — they never see other clients' data. | — | No | No |
| `book_appointment` | Exists | Book a one-off appointment. Checks availability + conflicts. Rejects if `sessionsRemaining == 0`. | No deduction at booking. | **Yes** — confirmation with date/time | **Yes** — "[Client] booked [date] at [time]" |
| `cancel_appointment` | Exists | Cancel one of their own appointments by ID. AI should offer alternative slots after cancellation. | No refund (session wasn't deducted). If was `completed`, +1 refund. | **Yes** — cancellation notice | **Yes** — "[Client] cancelled [date] at [time]" |
| `get_available_slots` | Exists | Show open slots for a date. | — | No | No |
| `reschedule_appointment` | **TODO** | Cancel old + book new atomically. Client provides current appointment context + new preferred time. AI finds the appointment and reschedules. | Net zero — no session change. | **Yes** — "Rescheduled from [old] to [new]" | **Yes** — "[Client] rescheduled from [old] to [new]" |

### Notes

**On cancellation flow (from spec 05):** When a client cancels, the AI should:
1. Cancel the appointment.
2. Offer the next 3 available slots for rescheduling: "No problem! Here are some open times this week: [slots]. Want to rebook?"
3. Notify the instructor.

**On rescheduling:** The client says "can I move my Thursday to Friday?" — the AI should:
1. Find their Thursday appointment.
2. Check Friday availability.
3. If available, do an atomic reschedule.
4. If not, offer alternatives.
The AI should be smart enough to resolve "my next appointment" or "Thursday's session" to the correct appointment ID without the client knowing IDs.

---

## 2. Recurring Schedules

| Tool | Status | Description | Session effect | Client SMS | Instructor notification |
|------|--------|-------------|----------------|------------|------------------------|
| `create_recurring_schedule` | Exists | Set up recurring weekly slots. Same atomic behavior as instructor — all slots validated before any are created. | — | **Yes** — "You're booked for [days] at [time]" | **Yes** — "[Client] set up recurring [days] at [time]" |
| `list_recurring_schedules` | **TODO** | View their own recurring schedules. | — | No | No |
| `skip_recurring_instance` | **TODO** | Skip one or more weeks. "I can't make it next Tuesday" or "I'm on vacation for 3 weeks". No session deduction. | No change. | **Yes** — "Your [date] session has been skipped." | **Yes** — "[Client] skipped [date(s)]" |
| `delete_recurring_schedule` | **TODO** | Cancel a recurring schedule entirely. **Requires confirmation:** AI must ask "Are you sure you want to cancel your recurring [day] at [time]? This will free up that slot." | — | **Yes** — "Your recurring [day] session has been cancelled." | **Yes** — "[Client] cancelled their recurring [day] at [time]" |

### Notes

**On skipping:** A client saying "I'm traveling next week" should trigger the AI to identify all their recurring appointments for that week and offer to skip them all at once. The AI should list which specific dates will be skipped and confirm before proceeding.

**On deleting:** The AI must always confirm before deleting a recurring schedule. This is a significant action — it frees up the client's held time slot, which another client could then book.

---

## 3. Account & Session Info

| Tool | Status | Description | Client SMS | Instructor notification |
|------|--------|-------------|------------|------------------------|
| `get_my_info` | **TODO** | View own profile: name, phone, email, package type, sessions remaining, upcoming appointments, recurring schedules. Composite view — calls multiple underlying queries. | No | No |
| `get_session_balance` | **TODO** | Check remaining sessions + recent ledger activity. Client-friendly formatting: "You have 7 sessions left on your 10-pack." | No | No |
| `update_my_contact` | **TODO** | Update own email or phone. **Cannot change name** (instructor does that). If changing phone, warn: "You'll receive messages at your new number going forward." | No | **Yes** — "[Client] updated their [field]" |

### Notes

**On session balance:** The AI should proactively mention low balance when relevant — e.g., after booking, if balance drops to ≤ 2: "Heads up — you have 2 sessions left. Want to purchase more? Venmo: @handle". Include the Venmo link from instructor settings.

**On "get_my_info":** This is a convenience tool that combines `get_client_info` + `get_session_balance` + `list_recurring_schedules` + `list_appointments` into one response. The AI should present it conversationally: "Here's your info: You have 7 sessions on your 10-pack. Your recurring: Tue + Thu at 9am. Next appointment: Thursday 4/17 at 9am."

---

## 4. Payments & Packages

| Tool | Status | Description | Client SMS | Instructor notification |
|------|--------|-------------|------------|------------------------|
| `get_payment_info` | **TODO** | Show the instructor's Venmo handle and the client's current package/balance. "You have 3 sessions left. To purchase more: Venmo @handle." | No | No |

### Notes

The system does NOT process payments. This tool is read-only — it surfaces payment info so the client can pay externally. After payment, the instructor updates the session balance via their own tools.

If a client says "I want to buy more sessions" or "how do I pay?", the AI provides the Venmo link and tells them the instructor will update their balance once payment is received.

---

## 5. NOT available to clients

These instructor-only tools must NEVER be exposed to clients:

| Tool | Why |
|------|-----|
| `mark_completed` | Session lifecycle is instructor-controlled |
| `mark_no_show` | Attendance decisions are instructor-controlled |
| `add_client` / `delete_client` / `deactivate_client` / `reactivate_client` | Client management is admin-only |
| `update_client_sessions` | Session balance changes = money; instructor-only |
| `set_availability` / `override_availability` / `block_time` / `remove_block` / `list_availability` | Scheduling power is instructor-only |
| `list_clients` | Privacy — clients should not see other clients |
| `get_daily_summary` / `get_weekly_summary` | Business metrics are instructor-only |
| `send_message` | Outbound SMS control is instructor-only |
| `update_client` (name, notes) | Notes may contain private instructor observations |
| `search_messages` | May surface instructor-side conversations |

---

## All client tools — quick reference

| Tool | Status | Category | Client SMS? | Instructor SMS? |
|------|--------|----------|:-----------:|:---------------:|
| `list_appointments` | Exists | Appointments | No | No |
| `book_appointment` | Exists | Appointments | **Yes** | **Yes** |
| `cancel_appointment` | Exists | Appointments | **Yes** | **Yes** |
| `get_available_slots` | Exists | Appointments | No | No |
| `reschedule_appointment` | **TODO** | Appointments | **Yes** | **Yes** |
| `create_recurring_schedule` | Exists | Recurring | **Yes** | **Yes** |
| `list_recurring_schedules` | **TODO** | Recurring | No | No |
| `skip_recurring_instance` | **TODO** | Recurring | **Yes** | **Yes** |
| `delete_recurring_schedule` | **TODO** | Recurring | **Yes** | **Yes** |
| `get_my_info` | **TODO** | Account | No | No |
| `get_session_balance` | **TODO** | Account | No | No |
| `update_my_contact` | **TODO** | Account | No | **Yes** |
| `get_payment_info` | **TODO** | Payments | No | No |

**Total: 13 tools** (5 exist, 8 TODO)

---

## Client notification patterns

### Proactive notifications (system-initiated, not tool-triggered)

These are sent by cron jobs / background processes, not by client tool calls:

| Trigger | Client SMS | Instructor SMS |
|---------|-----------|----------------|
| Day-before confirmation | "Hey [name]! Confirming your session tomorrow at [time]." | No |
| Low balance (≤ 2 sessions) | "Heads up — you have [N] sessions left. Venmo: @handle" | "[Client] is down to [N] sessions." |
| Zero balance | "You've used all your sessions! Purchase more: Venmo @handle" | "[Client] has 0 sessions remaining." |
| Monthly renewal (1st of month) | "Your monthly is up for renewal. Venmo @handle" | No |
| Appointment auto-completed | No (session just happened) | No |

### Client reply patterns (pre-AI pattern matching)

These are handled BEFORE the AI — simple regex matching for fast responses:

| Client says | Classification | Action |
|------------|---------------|--------|
| "yes", "sure", "see you then" | Confirm | Log confirmation, respond "Great, see you [day] at [time]!" |
| "no", "can't make it", "cancel" | Cancel | Cancel appointment, offer rebooking slots, notify instructor |
| "reschedule", "move", "different time" | Reschedule | Prompt for new preferred time, hand off to AI with tools |
| "what time?", "when is it?" | Question | Look up and reply with appointment details |
| anything else | AI fallback | Full AI processing with tool access |

---

## User journeys

### Journey 1: New client books via text (open booking)
1. Unknown number texts in → `processPublicMessage`
2. AI greets, asks what day they want
3. `get_available_slots` → present options
4. Client picks a slot, gives their name
5. System creates client record + books appointment
6. Confirmation SMS to client, notification to instructor

### Journey 2: Existing client books a session
1. Client: "Can I book Thursday at 2pm?"
2. AI calls `get_available_slots` to verify
3. AI calls `book_appointment`
4. AI calls `list_appointments` to verify (never assume)
5. Confirmation to client, notification to instructor

### Journey 3: Client cancels and rebooks
1. Client: "I need to cancel tomorrow"
2. AI finds tomorrow's appointment, calls `cancel_appointment`
3. AI offers next 3 available slots: "Want to rebook? Here's what's open..."
4. Client picks a new time → `book_appointment`
5. Both confirmed, instructor notified of the change

### Journey 4: Client reschedules
1. Client: "Can I move my Thursday to Friday?"
2. AI identifies the Thursday appointment
3. AI calls `reschedule_appointment` (atomic)
4. AI verifies with `list_appointments`
5. "Done! Moved from Thu 2pm to Fri 2pm."

### Journey 5: Client checks their info
1. Client: "How many sessions do I have?"
2. AI calls `get_session_balance`
3. "You have 7 sessions left on your 10-pack. Your next appointment is Thursday at 9am."

### Journey 6: Client skips recurring weeks
1. Client: "I'm on vacation next 2 weeks"
2. AI identifies their recurring schedule(s)
3. AI calls `skip_recurring_instance` with `weeks=2`
4. AI verifies: "Skipped your Tuesday and Friday sessions for the next 2 weeks. Your recurring schedule picks back up on [date]."
5. Instructor notified

### Journey 7: Client confirms day-before message
1. System sends: "Hey Sarah! Confirming your session tomorrow at 10am."
2. Sarah replies: "See you then!"
3. Pattern match → confirm → "Great, see you tomorrow!"
4. (No tool calls needed, fast path)

### Journey 8: Client asks about payment
1. Client: "How do I buy more sessions?"
2. AI calls `get_payment_info`
3. "You have 2 sessions left. To purchase more, Venmo @handle. Your trainer will update your balance once payment is received."

### Journey 9: Client cancels recurring
1. Client: "I want to stop my Tuesday sessions"
2. AI calls `list_recurring_schedules` to find it
3. AI asks confirmation: "Are you sure you want to cancel your recurring Tuesday at 9am?"
4. Client: "Yes"
5. AI calls `delete_recurring_schedule`
6. "Done. Your Tuesday recurring has been cancelled."
7. Instructor notified

---

## Implementation priority

**Phase 1 — Complete the core booking flow:**
`reschedule_appointment` (client version), `get_session_balance`, `get_my_info`

**Phase 2 — Recurring management:**
`list_recurring_schedules`, `skip_recurring_instance`, `delete_recurring_schedule`

**Phase 3 — Account & payments:**
`update_my_contact`, `get_payment_info`
