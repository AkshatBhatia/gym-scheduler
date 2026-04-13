# Instructor Chat Tools — Spec

Every operation the instructor needs should be doable via the chat interface.
This file is the source of truth for what tools exist and what's missing.

---

## Invariants — Session & Conflict Rules

These rules apply to EVERY tool that creates, moves, or closes an appointment.
Any new tool must enforce all of them.

### Conflict checking
- Before inserting or moving an appointment into a time slot, verify:
  1. **No double-booking** — no other non-cancelled appointment overlaps the slot.
  2. **Within availability window** — the slot falls inside a recurring or override availability rule.
  3. **Not blocked** — no `isBlocked=1` override covers the slot.
- If any check fails, the operation must fail and the original state must be unchanged (atomic).

### Session balance accounting
| Event | Session effect | Ledger entry |
|-------|---------------|-------------|
| `book_appointment` | No deduction, but **booking must be rejected if `sessionsRemaining` is 0** (no exceptions). Instructor is warned if balance will be low after booking. | — |
| `cancel_appointment` | +1 refund **only if** the appointment was already `completed` | Refund entry |
| `mark_completed` | −1 from client balance. **If balance is already 0, still allow completion but warn: "Client has no sessions remaining, they need to purchase more."** Balance goes to −1 (negative = owes sessions). | Deduction entry |
| `mark_no_show` | Default: no change. Optionally −1 if instructor confirms (`deductSession=true`). AI must ask before deducting. | Deduction entry only if deducted |
| `reschedule_appointment` | Net zero — no session change (same session, just moved). No balance check needed since the session was already reserved. | — |
| `skip_recurring_instance` | No change — planned skip, session is not consumed | — |

Every balance change MUST be recorded in the `session_ledger` table with `clientId`, `appointmentId`, `changeAmount`, `balanceAfter`, and `reason`.

---

## 1. Appointments

| Tool | Status | Description | Session effect | Client SMS |
|------|--------|-------------|----------------|------------|
| `list_appointments` | Exists | List appointments for a date (defaults to today). | — | No |
| `book_appointment` | Exists | Book a one-off appointment. Checks availability + conflicts. Rejects if `sessionsRemaining == 0` (no exceptions). Warns if balance ≤ 2. | No deduction at booking. | **Yes** — confirmation with date/time |
| `cancel_appointment` | Exists | Cancel by appointment ID. | +1 refund ONLY if status was `completed`. No refund if `confirmed`. Logs refund to `session_ledger`. | **Yes** — "[date] at [time] has been cancelled" |
| `get_available_slots` | Exists | Show open 1-hour slots for a date. | — | No |
| `mark_completed` | **TODO** | Sets status to `completed`. Rejects if already completed/cancelled/no-show. | −1 session. Logs to `session_ledger`. If balance is 0, still allow but warn "client needs to purchase more." Balance can go negative. | No — client was just there |
| `mark_no_show` | **TODO** | Sets status to `no-show`. Rejects if not `confirmed`. Accepts optional `deductSession` boolean (default `false`). AI asks instructor before deducting. | Default: no change. If `deductSession=true`: −1 session, logs to `session_ledger`. | **Yes** — "You missed your session on [date] at [time]. Please reach out to reschedule." |
| `reschedule_appointment` | **TODO** | Cancel old + book new in one atomic step. Accepts appointment ID or client name + date/time. Validates new slot first; if unavailable, old appointment stays untouched. Carries over `recurringScheduleId`. | Net zero — no deduction, no refund, no balance check. No `session_ledger` entries. | **Yes** — "Your appointment has been rescheduled from [old] to [new]." |

---

## 2. Recurring Schedules

| Tool | Status | Description | Session effect | Client SMS |
|------|--------|-------------|----------------|------------|
| `create_recurring_schedule` | Exists | Create one or more weekly recurring slots for a client, auto-generates appointments indefinitely. | No deduction. Generation is not limited by balance. | **Yes** — "You're booked for Tuesdays and Thursdays at 9am. See you next week!" |
| `list_recurring_schedules` | **TODO** | View all recurring schedules, or filter by client. | — | No |
| `update_recurring_schedule` | **TODO** | Change day/time of an existing recurring. Validates new day/time against availability. Triggers full regeneration of future appointments. | — | **Yes** — "Your recurring session has moved from Tuesdays at 9am to Wednesdays at 9am." |
| `delete_recurring_schedule` | **TODO** | Remove a recurring rule and cancel all its future appointments. AI must ask for confirmation first. | — | **Yes** — "Your recurring [day] at [time] session has been cancelled. Please reach out to reschedule." |
| `skip_recurring_instance` | **TODO** | Cancel next N weeks (default 1) of a recurring appointment. Rule stays active; future weeks generate as normal. | No change — planned skip. No `session_ledger` entries. | **Yes** — per skipped week: "Your session on [date] has been cancelled. Your recurring schedule continues as normal." |

**`create_recurring_schedule` details:**
- Accepts **multiple day/time pairs** in a single call. Example: "Sarah trains Tuesday 9am and Thursday 9am" → creates 2 recurring schedule entries.
- Starts generating from the **next available date** (not today, not past dates).
- **Generate indefinitely** — recurring appointments are generated on a rolling basis into the future (e.g. 12 weeks out, extended by a cron/background job). They are NOT limited by `sessionsRemaining`. The purpose is to **hold the time slot** on the calendar so no one else can book it, even if the client's sessions run out and they haven't renewed yet.
- **Availability check per slot** — each recurring day/time must fall within the instructor's availability rules. If the instructor has no availability window covering e.g. Thursday 9am, reject that slot and tell the instructor why.
- Example: client recurs Tue + Thu at 9am → appointments are generated every Tue and Thu indefinitely, regardless of session balance.

### Recurring schedule invariants

When a recurring schedule is **created or updated**, the system auto-generates future appointments. These generated appointments must obey the same invariants as any other booking:

1. **Availability gate** — before creating a recurring schedule entry, verify the requested day/time falls within the instructor's availability rules for that day of week. If not, reject with a clear message (e.g. "You don't have availability on Saturdays. Set your Saturday hours first.").
2. **Conflict check per generated slot** — each generated appointment must pass the same 3 checks (no double-booking, within availability, not blocked). If a specific week's slot conflicts, skip that week silently rather than failing the entire operation.
3. **Generate indefinitely** — recurring appointments are generated on a rolling horizon (e.g. 12 weeks out) and extended by a background job. Generation is NOT limited by `sessionsRemaining`. The recurring slot acts as a **hold** on the calendar — it blocks that time from being booked by anyone else, even after the client's sessions run out. This protects the client's time while they renew.
4. **Fair distribution** — if a client has multiple recurring schedules (e.g., Tuesday + Thursday), distribute generated appointments evenly across all active schedules via round-robin by date. Start from the next available date for each slot.
5. **Regeneration on changes** — when a recurring schedule is created, updated, or deleted: delete all future confirmed appointments with a `recurringScheduleId` for that client, then regenerate from scratch using all remaining active schedules. This ensures fair redistribution.
6. **Session balance** — generating recurring appointments does NOT deduct sessions. Sessions are only deducted on `mark_completed` or `mark_no_show`. A client with 0 sessions can still have recurring appointments on the calendar (they hold the slot). The instructor/AI should warn when `mark_completed` is called and balance is 0 — "Client has no sessions remaining, they need to purchase more."
7. **Cancellation requires confirmation** — recurring schedules can only be deleted by the instructor or the client themselves. The AI must always ask for explicit confirmation before deleting. This prevents accidental loss of a client's held time slot.

### Notes

**On skip:** Find the next N confirmed appointments (default 1) for this client's recurring schedule starting from the given date, and cancel them. Should NOT deduct sessions — planned skips, not no-shows. No need to append replacements — the recurring schedule continues generating indefinitely so slots are naturally recaptured in future weeks. If `weeks=4`, cancels the next 4 instances of that specific recurring schedule.

**On one-off reschedule of a recurring instance:** "Sarah wants Thursday instead of Tuesday this week" = `skip_recurring_instance` (Tuesday) + `book_appointment` (Thursday). The AI can chain these two tools — no need for a dedicated tool. The Thursday booking follows all standard conflict/availability checks.

---

## 3. Availability / Hours

| Tool | Status | Description | Client SMS |
|------|--------|-------------|------------|
| `block_time` | Exists | Block a date-specific time range (`isBlocked=1, overrideDate=date`). Triggers cascading cancellation (see below). | **Yes** — SMS to each client whose appointment is cancelled by the block |
| `set_availability` | **TODO** | Set regular weekly hours (day-of-week rules). Triggers cascading cancellation if hours shrink. | **Yes** — SMS to each client whose future appointment is cancelled because hours shrank |
| `list_availability` | **TODO** | View current weekly rules + any overrides. | No |
| `override_availability` | **TODO** | One-off date override — add hours on a normally-off day, or change hours for a specific date (`isBlocked=0, overrideDate=date`). Triggers cascading cancellation if hours narrow. | **Yes** — SMS to each client whose appointment on that date falls outside the new window |
| `remove_block` | **TODO** | Unblock a previously blocked time. Opens time up, doesn't cancel anything. | No |

**Notes on override vs block:**
- `block_time` = "I'm NOT available during this time on this date" (`isBlocked=1, overrideDate=date`)
- `override_availability` = "On this specific date, my hours are X-Y instead of the usual" (`isBlocked=0, overrideDate=date`)
- Both already work in the availability table schema — just need chat tools.

### Availability change cascading

When any availability change **shrinks** the instructor's available hours — whether via `block_time`, `set_availability`, or `override_availability` — the system must:

1. **Find conflicting appointments** — query all future confirmed appointments that now fall outside the new availability window or inside a newly blocked range.
2. **Cancel them** — set status to `cancelled` on each conflicting appointment. No session deduction (these were confirmed, not completed).
3. **Notify the instructor** — return the list of cancelled appointments in the tool response so the AI can tell the instructor: "This cancelled 3 appointments: Sarah Mon 10am, Mike Mon 2pm, Emily Tue 9am."
4. **Notify affected clients** — send an SMS to each affected client informing them their appointment was cancelled and they need to rebook. Message should include which date/time was cancelled.
5. **Recurring regeneration** — if cancelled appointments had a `recurringScheduleId`, those recurring schedules are still active. The next background generation cycle will attempt to regenerate them on non-conflicting weeks. No manual intervention needed.

This applies to:
- `block_time` — any confirmed appointment overlapping the blocked range on that date
- `set_availability` — if weekly hours shrink (e.g. "no more Fridays"), cancel all future Friday appointments
- `override_availability` — if the override narrows hours for a specific date (e.g. "Monday only 10-2" when there are appointments at 9am and 3pm), cancel the ones outside the new window

---

## 4. Client Management

| Tool | Status | Description | Client SMS |
|------|--------|-------------|------------|
| `add_client` | Exists | Create new client with phone, package, sessions. | **Yes** — welcome message: "Welcome! You've been added to [instructor]'s schedule. Reply to this number to book or manage appointments." |
| `get_client_info` | Exists | Look up by name — returns contact, package, sessions, upcoming appointments. | No |
| `get_session_balance` | Exists | Check balance + recent ledger. | No |
| `deactivate_client` | Exists | Soft-delete (active=0), also pauses recurring. | No — instructor handles personally |
| `delete_client` | **TODO** | **Permanent hard-delete** of a client and all their data. AI must ask for confirmation twice: "This will permanently delete [name] and all their appointment history, recurring schedules, session ledger, and messages. This cannot be undone. Are you sure?" Only proceeds if instructor explicitly confirms. **Cascade:** (1) Cancel all future confirmed appointments for this client. (2) Delete all recurring schedules for this client. (3) Delete all session ledger entries. (4) Delete all messages for this client. (5) Delete the client row. **Sessions:** No deduction — cancellations are part of deletion, not no-shows. | **Yes** — final SMS: "Your account with [instructor name] has been removed. Thank you for training with us." Sent BEFORE the delete (since the phone number is on the client record). |
| `update_client_sessions` | Exists | Set/add sessions, optionally update package type. | **Yes** — "Your session balance has been updated. You now have [N] sessions remaining." |
| `list_clients` | **TODO** | List all active clients, optional search. | No |
| `update_client` | **TODO** | Edit name, phone, email, notes. | No — internal admin change |
| `reactivate_client` | **TODO** | Undo deactivation (set active=1). | **Yes** — "You've been reactivated! Reply to this number to book sessions." |

---

## 5. Dashboard / Overview

| Tool | Status | Description | Client SMS |
|------|--------|-------------|------------|
| `get_daily_summary` | **TODO** | Morning briefing: today's count, upcoming list, low-balance alerts. | No |
| `get_weekly_summary` | **TODO** | Week-at-a-glance: appointments per day, total sessions. | No |

---

## 6. Messaging

| Tool | Status | Description | Client SMS |
|------|--------|-------------|------------|
| `search_messages` | Exists | Search conversation history by client/keyword. | No |
| `send_message` | **TODO** | Proactive SMS to a client via Twilio. | **Yes** — the message itself IS the notification |

---

## All tools — quick reference

| Tool | Status | Category | Client SMS? | Priority |
|------|--------|----------|:-----------:|----------|
| `list_appointments` | Exists | Appointments | No | — |
| `book_appointment` | Exists | Appointments | **Yes** | — |
| `cancel_appointment` | Exists | Appointments | **Yes** | — |
| `get_available_slots` | Exists | Appointments | No | — |
| `mark_completed` | **TODO** | Appointments | No | High |
| `mark_no_show` | **TODO** | Appointments | **Yes** | High |
| `reschedule_appointment` | **TODO** | Appointments | **Yes** | High |
| `create_recurring_schedule` | Exists | Recurring | **Yes** | — |
| `list_recurring_schedules` | **TODO** | Recurring | No | High |
| `update_recurring_schedule` | **TODO** | Recurring | **Yes** | High |
| `delete_recurring_schedule` | **TODO** | Recurring | **Yes** | Medium |
| `skip_recurring_instance` | **TODO** | Recurring | **Yes** | High |
| `block_time` | Exists | Availability | **Yes** (if cascading) | — |
| `set_availability` | **TODO** | Availability | **Yes** (if cascading) | High |
| `list_availability` | **TODO** | Availability | No | High |
| `override_availability` | **TODO** | Availability | **Yes** (if cascading) | Medium |
| `remove_block` | **TODO** | Availability | No | Low |
| `add_client` | Exists | Clients | **Yes** | — |
| `get_client_info` | Exists | Clients | No | — |
| `get_session_balance` | Exists | Clients | No | — |
| `deactivate_client` | Exists | Clients | No | — |
| `delete_client` | **TODO** | Clients | **Yes** | Low |
| `update_client_sessions` | Exists | Clients | **Yes** | — |
| `list_clients` | **TODO** | Clients | No | Medium |
| `update_client` | **TODO** | Clients | No | Medium |
| `reactivate_client` | **TODO** | Clients | **Yes** | Low |
| `get_daily_summary` | **TODO** | Dashboard | No | High |
| `get_weekly_summary` | **TODO** | Dashboard | No | Medium |
| `search_messages` | Exists | Messaging | No | — |
| `send_message` | **TODO** | Messaging | **Yes** | High |

---

## Implementation order (suggested)

**Phase 1 — Daily workflow essentials:**
`mark_completed`, `mark_no_show`, `reschedule_appointment`, `skip_recurring_instance`, `get_daily_summary`, `send_message`

**Phase 2 — Recurring + Availability management:**
`list_recurring_schedules`, `update_recurring_schedule`, `delete_recurring_schedule`, `set_availability`, `list_availability`, `override_availability`

**Phase 3 — Client + polish:**
`list_clients`, `update_client`, `reactivate_client`, `get_weekly_summary`, `remove_block`
