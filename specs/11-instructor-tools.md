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
| `mark_completed` | −1 from client balance | Deduction entry |
| `mark_no_show` | −1 from client balance (no-show still consumes a session) | Deduction entry |
| `reschedule_appointment` | Net zero — no session change (same session, just moved). No balance check needed since the session was already reserved. | — |
| `skip_recurring_instance` | No change — planned skip, session is not consumed | — |

Every balance change MUST be recorded in the `session_ledger` table with `clientId`, `appointmentId`, `changeAmount`, `balanceAfter`, and `reason`.

---

## 1. Appointments

### Existing
| Tool | What it does |
|------|-------------|
| `list_appointments` | List appointments for a date (defaults to today) |
| `book_appointment` | Book a one-off appointment. Checks availability + conflicts. **Sessions: rejects if `sessionsRemaining == 0` (no exceptions). No deduction — sessions are deducted on completion, not booking. Warns if balance ≤ 2 after booking.** |
| `cancel_appointment` | Cancel by appointment ID. **Sessions: +1 refund ONLY if appointment status was `completed` (session was already deducted). If status is `confirmed`, no refund needed (session was never deducted). Logs refund to `session_ledger`.** |
| `get_available_slots` | Show open 1-hour slots for a date |

### Missing
| Tool | Why it's needed | Session effect |
|------|----------------|----------------|
| `mark_completed` | End-of-day workflow — sets status to `completed` | **−1 session. Logs deduction to `session_ledger`. Rejects if already completed/cancelled/no-show.** |
| `mark_no_show` | Client didn't show up | **−1 session (no-show still consumes the session). Logs deduction to `session_ledger`. Rejects if not `confirmed`.** |
| `reschedule_appointment` | Cancel old + book new in one atomic step | **Net zero — no session deduction, no refund, no balance check. The session was already reserved by the original booking. Just moving it.** |

**Notes on reschedule:**
- Should accept either an appointment ID or client name + current date/time to find the appointment.
- Internally: validate new slot first (conflict + availability + block checks). Only if the new slot is valid, cancel old and book new. If the new slot is unavailable, the entire operation fails and the old appointment stays untouched.
- No session deduction or refund — it's the same session being moved. No `session_ledger` entries.
- Must carry over `recurringScheduleId` if the original appointment was recurring-generated.

---

## 2. Recurring Schedules

### Existing
| Tool | What it does |
|------|-------------|
| `create_recurring_schedule` | Create weekly recurring, auto-generates appointments from session balance |

### Missing
| Tool | Why it's needed | Example utterance |
|------|----------------|-------------------|
| `list_recurring_schedules` | Can't see what's set up; need this before editing/deleting | "What's Sarah's recurring schedule?" / "Show all recurring" |
| `update_recurring_schedule` | Change day/time of an existing recurring | "Move Sarah's recurring from Tuesday to Wednesday" |
| `delete_recurring_schedule` | Remove a recurring rule entirely | "Remove Sarah's Friday recurring" |
| `pause_recurring_schedule` | Temporarily disable without deleting (sets active=0) | "Pause Sarah's recurring for now" |
| `skip_recurring_instance` | Cancel just one week's generated appointment without touching the rule. **Sessions: no change — planned skip, session is not consumed, no `session_ledger` entry.** | "Sarah can't make it this Tuesday, skip this week" |

### Recurring schedule invariants

When a recurring schedule is **created or updated**, the system auto-generates future appointments. These generated appointments must obey the same invariants as any other booking:

1. **Conflict check per generated slot** — each generated appointment must pass the same 3 checks (no double-booking, within availability, not blocked). If a specific week's slot conflicts, skip that week silently rather than failing the entire operation.
2. **Session-limited generation** — only generate as many future appointments as the client has `sessionsRemaining`. Do not generate more appointments than the client can pay for.
3. **Fair distribution** — if a client has multiple recurring schedules (e.g., Tuesday + Thursday), distribute generated appointments evenly across all active schedules via round-robin by date.
4. **Regeneration on changes** — when a recurring schedule is created, updated, deleted, or paused: delete all future confirmed appointments with a `recurringScheduleId` for that client, then regenerate from scratch using all remaining active schedules. This ensures fair redistribution.
5. **Session balance** — generating recurring appointments does NOT deduct sessions. Sessions are only deducted on `mark_completed` or `mark_no_show`. The generated count is capped by balance but doesn't reduce it.

### Notes

**On skip:** Find the confirmed appointment for this client on the given date that has a `recurringScheduleId`, and cancel it. Should NOT deduct a session — it's a planned skip, not a no-show. The skipped slot is not regenerated elsewhere.

**On one-off reschedule of a recurring instance:** "Sarah wants Thursday instead of Tuesday this week" = `skip_recurring_instance` (Tuesday) + `book_appointment` (Thursday). The AI can chain these two tools — no need for a dedicated tool. The Thursday booking follows all standard conflict/availability checks.

---

## 3. Availability / Hours

### Existing
| Tool | What it does |
|------|-------------|
| `block_time` | Block a date-specific time range (creates availability override with `isBlocked=1`) |

### Missing
| Tool | Why it's needed | Example utterance |
|------|----------------|-------------------|
| `set_availability` | Set regular weekly hours (day-of-week rules) | "My hours are 8am-6pm Monday through Friday" |
| `list_availability` | View current weekly rules + any overrides | "What are my hours?" |
| `override_availability` | One-off date override — add hours on a day that's normally off, or change hours for a specific date | "I'm available Saturday this week 9am-12pm" / "Next Monday I can only do 10-2" |
| `remove_block` | Unblock a previously blocked time | "Actually, unblock next Tuesday afternoon" |

**Notes on override vs block:**
- `block_time` = "I'm NOT available during this time on this date" (`isBlocked=1, overrideDate=date`)
- `override_availability` = "On this specific date, my hours are X-Y instead of the usual" (`isBlocked=0, overrideDate=date`)
- Both already work in the availability table schema — just need chat tools.

---

## 4. Client Management

### Existing
| Tool | What it does |
|------|-------------|
| `add_client` | Create new client with phone, package, sessions |
| `get_client_info` | Look up by name — returns contact, package, sessions, upcoming appointments |
| `get_session_balance` | Check balance + recent ledger |
| `deactivate_client` | Soft-delete (active=0), also pauses recurring |
| `update_client_sessions` | Set/add sessions, optionally update package type |

### Missing
| Tool | Why it's needed | Example utterance |
|------|----------------|-------------------|
| `list_clients` | "Who are all my clients?" — especially useful for overview | "List all my clients" / "How many active clients do I have?" |
| `update_client` | Edit name, phone, email, notes | "Update Sarah's phone to +1555..." / "Add a note to John's profile" |
| `reactivate_client` | Undo a deactivation | "Bring John back, he wants to restart" |

---

## 5. Dashboard / Overview

### Existing
None via chat.

### Missing
| Tool | Why it's needed | Example utterance |
|------|----------------|-------------------|
| `get_daily_summary` | Quick morning briefing: today's count, upcoming list, low-balance alerts | "How's my day looking?" / "Morning briefing" |
| `get_weekly_summary` | Week-at-a-glance: appointments per day, total sessions | "What's my week like?" |

---

## 6. Messaging

### Existing
| Tool | What it does |
|------|-------------|
| `search_messages` | Search conversation history by client/keyword |

### Missing
| Tool | Why it's needed | Example utterance |
|------|----------------|-------------------|
| `send_message` | Proactive SMS to a client via Twilio | "Text Sarah that I'm running 10 min late" / "Send John a reminder about his package" |

---

## Summary: 16 missing tools

| # | Tool | Category | Priority |
|---|------|----------|----------|
| 1 | `mark_completed` | Appointments | **High** — daily workflow |
| 2 | `mark_no_show` | Appointments | **High** — daily workflow |
| 3 | `reschedule_appointment` | Appointments | **High** — very common ask |
| 4 | `list_recurring_schedules` | Recurring | **High** — can't manage what you can't see |
| 5 | `update_recurring_schedule` | Recurring | **High** — schedules change |
| 6 | `delete_recurring_schedule` | Recurring | **Medium** — less common |
| 7 | `pause_recurring_schedule` | Recurring | **Medium** — temporary holds |
| 8 | `skip_recurring_instance` | Recurring | **High** — weekly occurrence |
| 9 | `set_availability` | Availability | **High** — initial setup + changes |
| 10 | `list_availability` | Availability | **High** — "what are my hours?" |
| 11 | `override_availability` | Availability | **Medium** — one-off schedule changes |
| 12 | `remove_block` | Availability | **Low** — undo mistakes |
| 13 | `list_clients` | Clients | **Medium** — overview |
| 14 | `update_client` | Clients | **Medium** — contact changes |
| 15 | `reactivate_client` | Clients | **Low** — rare |
| 16 | `get_daily_summary` | Dashboard | **High** — morning routine |
| 17 | `get_weekly_summary` | Dashboard | **Medium** — planning |
| 18 | `send_message` | Messaging | **High** — proactive outreach |

---

## Implementation order (suggested)

**Phase 1 — Daily workflow essentials:**
`mark_completed`, `mark_no_show`, `reschedule_appointment`, `skip_recurring_instance`, `get_daily_summary`, `send_message`

**Phase 2 — Recurring + Availability management:**
`list_recurring_schedules`, `update_recurring_schedule`, `delete_recurring_schedule`, `pause_recurring_schedule`, `set_availability`, `list_availability`, `override_availability`

**Phase 3 — Client + polish:**
`list_clients`, `update_client`, `reactivate_client`, `get_weekly_summary`, `remove_block`
