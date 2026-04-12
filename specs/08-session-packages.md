# 08 — Session Packages & Billing

## What

Track client session packages, auto-decrement on appointment completion, and send low-balance notifications and payment reminders.

## How

### Package Types

| Package   | Sessions | Behavior                                      |
|-----------|----------|-----------------------------------------------|
| single    | 1        | One-time session; balance drops to 0 after use |
| 5-pack    | 5        | Decrements per completed session               |
| 10-pack   | 10       | Decrements per completed session               |
| 20-pack   | 20       | Decrements per completed session               |
| monthly   | unlimited| No decrement; expires based on calendar month  |

### Session Lifecycle

1. **Appointment created**: No session deducted yet. The `sessions_remaining` value is unchanged.
2. **Appointment completed**: When the instructor marks a session as `completed` (via chat or dashboard):
   - For pack-based clients: `sessions_remaining` decrements by 1.
   - A `session_ledger` entry is created: `change_amount = -1`, `reason = 'completed'`.
   - `clients.sessions_remaining` is updated to match.
3. **Appointment cancelled**: No session deducted. If previously decremented (error recovery), a +1 adjustment is recorded.
4. **Appointment no-show**: Instructor decides via chat or dashboard whether to charge the session. AI asks: "Mark as no-show — should I charge the session?"

### Auto-Completion

- A cron job runs at **9:00 PM** daily.
- Any confirmed appointment whose `end_time` has passed and is still `confirmed` is auto-completed.
- Session decrement and ledger entry are applied.
- This prevents forgotten manual completions from skewing balances.

### Low-Balance Notifications

When a session is decremented and the new `sessions_remaining` reaches **2 or fewer**:

1. Compose a message to the client via Claude using the voice profile:
   > "Heads up Sarah — you've got 2 sessions left on your 10-pack. Want to re-up? Venmo: @instructor-handle"
2. Send via Twilio SMS.
3. Also notify the instructor:
   > "Sarah is down to 2 sessions on her 10-pack."

### Zero-Balance Handling

When `sessions_remaining` hits 0:

- The client can still have appointments booked (instructor may allow this).
- The system flags the client in the dashboard (red badge on client row).
- On the next booking attempt via chat, AI warns: "Sarah has 0 sessions remaining. Book anyway?"

### Payment & Renewal

- The system does **not** process payments directly.
- Payment reminders include a configurable Venmo link (stored in env: `VENMO_LINK`).
- When the instructor records a package purchase (via chat: "Sarah bought a new 10-pack" or via dashboard), the system:
  1. Updates `clients.package_type` and `clients.sessions_remaining`.
  2. Creates a ledger entry: `change_amount = +10`, `reason = 'package_purchase'`.

### Monthly Package Handling

- Monthly clients have `sessions_remaining` set to 0 (unused).
- No decrement logic applies.
- A cron job on the **1st of each month** at 8:00 AM sends a renewal reminder:
  > "Hey Jake — your monthly is up for renewal. Venmo @instructor-handle to keep it going!"
- Instructor can mark monthly as renewed via chat or dashboard.

### Ledger Integrity

- `session_ledger` is append-only.
- Every change to `sessions_remaining` must have a corresponding ledger entry.
- `balance_after` is always computed as `previous_balance + change_amount` at insert time.
- Dashboard shows full ledger history per client for auditing.

## Validation Plan

1. **Completion decrement**: Complete an appointment for a 10-pack client with 7 sessions; verify sessions_remaining = 6 and ledger entry exists.
2. **Low-balance alert**: Decrement a client to 2 sessions; verify client and instructor both receive SMS notifications.
3. **Zero-balance booking**: Attempt to book via chat for a client with 0 sessions; verify warning is surfaced.
4. **Package purchase**: Record a 10-pack purchase for a client with 0 sessions; verify sessions_remaining = 10 and ledger shows +10.
5. **Auto-completion cron**: Create a confirmed appointment in the past; run the cron; verify it is marked completed and session decremented.
6. **Monthly renewal**: On the 1st, verify monthly clients receive a renewal reminder and no session decrement occurs on completion.
7. **Ledger audit**: After a series of operations, verify sum of all `change_amount` for a client equals the current `sessions_remaining`.
