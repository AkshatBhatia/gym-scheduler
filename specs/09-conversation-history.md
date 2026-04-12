# 09 — Conversation History

## What

Persistent storage of all messages (SMS, web, system-generated) with per-client views, search, and access via both the dashboard and the instructor chat interface.

## How

### Storage

All messages are stored in the `messages` table (see spec 01). Every inbound and outbound message is recorded regardless of channel or sender type.

Fields used for filtering:

- `client_id` — links message to a client (null for instructor-only messages).
- `direction` — inbound or outbound.
- `channel` — sms, web, or system.
- `sender_type` — instructor, client, ai, or system.
- `created_at` — timestamp for ordering and date filtering.

### Per-Client Conversation View

**Dashboard** (`/messages` page and client detail panel):

- Messages grouped by client, ordered by `created_at` descending.
- Each thread shows a chat-style view: inbound messages on the left, outbound on the right.
- System messages (e.g., "Appointment cancelled") shown as centered gray text.
- Clicking a client name in the message list navigates to their full thread.

**Chat interface** (instructor SMS):

- Instructor texts: "Show me my conversation with Mike"
- System queries the last 20 messages for the matching client.
- Formats them as a readable summary and sends via SMS:
  > "Last 5 messages with Mike:
  > You (Apr 5): Hey Mike, see you Thursday at 3pm!
  > Mike (Apr 5): Sounds good coach
  > You (Apr 3): Great sesh today. Same time next week?
  > Mike (Apr 3): For sure
  > You (Apr 1): Reminder — tomorrow at 3pm!"

If the conversation is long, only the most recent messages are included with a note: "(20 more messages — view all on the dashboard)".

### Search

**Dashboard search** (`GET /api/messages?q=:search`):

Supports filtering by:

| Filter     | Example                    | Query behavior                          |
|------------|----------------------------|-----------------------------------------|
| Client name| `q=mike`                   | Match client name (case-insensitive)    |
| Keyword    | `q=cancel`                 | Full-text search on message body        |
| Date range | `from=2026-04-01&to=2026-04-07` | Filter by created_at range        |
| Combined   | `q=mike&from=2026-04-01`  | Name/keyword AND date range             |

Results returned as paginated list (20 per page) with client name, timestamp, and message preview (first 100 chars).

**Chat search**:

- Instructor texts: "Search messages for 'reschedule'"
- System queries messages containing the keyword.
- Returns the top 5 results with client name and date.

### Message Context for AI

When composing AI responses (specs 02, 05, 07), the system includes recent conversation history in the Claude prompt:

- For **instructor chat**: last 10 instructor messages for continuity.
- For **client replies**: last 5 messages in that client's thread for context.
- For **open booking**: the full conversation with the unknown number (up to 20 messages).

### Retention Policy

- **Keep all messages** indefinitely in v1.
- No automatic deletion or archival.
- Database size is expected to be manageable in SQLite for a single-instructor operation (estimated < 100MB/year).
- Future consideration: optional export to CSV via dashboard.

### API Endpoints

| Method | Path                              | Description                          |
|--------|-----------------------------------|--------------------------------------|
| GET    | /api/messages                     | Search/list all messages (paginated) |
| GET    | /api/clients/:id/messages         | Messages for a specific client       |
| GET    | /api/messages/search?q=:keyword   | Full-text keyword search             |

## Validation Plan

1. **Storage completeness**: Send an inbound SMS, trigger an outbound reply, and create a system event; verify all 3 appear in the messages table with correct fields.
2. **Per-client view**: Create 10 messages across 3 clients; query by client_id; verify correct messages returned in chronological order.
3. **Dashboard thread rendering**: Load a client's message thread; verify inbound and outbound messages are visually distinguished.
4. **Chat retrieval**: Text "Show me my conversation with Mike"; verify the last 5 messages are returned accurately.
5. **Keyword search**: Insert messages containing "reschedule"; search for the keyword; verify matching messages returned.
6. **Date range filter**: Query messages for a specific week; verify only messages within that range are returned.
7. **Pagination**: Insert 50 messages; request page 1 (20 results) and page 2 (20 results); verify correct ordering and no duplicates.
8. **AI context inclusion**: Trigger a client reply; inspect the Claude prompt; verify recent conversation history is included.
