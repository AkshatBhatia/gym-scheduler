# 04 — Web Dashboard

## What

An admin-only web UI for the instructor to visually manage their schedule, clients, availability, and conversations. Built with React, Vite, and TailwindCSS.

## How

### Tech Stack

- **Frontend**: React 18 + TypeScript, Vite bundler, TailwindCSS for styling.
- **State management**: React Query (TanStack Query) for server state; local state via useState/useReducer.
- **Routing**: React Router v6.
- **Backend**: Express API (same server), endpoints under `/api/`.
- **Auth**: Simple shared secret token in a cookie (single-user system; no user accounts). Set via environment variable.

### Pages & Layout

#### Shell Layout

- Sidebar navigation: Calendar, Clients, Availability, Messages, Voice Profile.
- Top bar: current date, quick-add appointment button.

#### 1. Calendar Page (`/`)

- **Weekly view** by default, showing Mon–Sat columns.
- Each column divided into 1-hour rows from 6am to 6pm.
- Appointments rendered as colored blocks:
  - Green = confirmed, Gray = cancelled, Red = no-show, Blue = completed.
- Click an empty slot to open the **New Appointment** modal (select client, confirm time).
- Click an existing appointment to open the **Edit Appointment** modal (change time, mark status, cancel).
- Navigation arrows to move between weeks.
- "Today" button to jump back.

#### 2. Clients Page (`/clients`)

- Searchable list of all clients (name, phone, package type, sessions remaining).
- Click a client row to open the **Client Detail** panel:
  - Edit name, phone, email, notes, package type.
  - Session balance with ledger history.
  - Conversation history (messages tab).
  - Upcoming appointments.
- "Add Client" button opens a creation form.

#### 3. Availability Page (`/availability`)

- Visual weekly grid showing current hours.
- Click a day column header to edit that day's default hours (start/end time pickers).
- Date picker to set one-off overrides for specific dates.
- "Block Time" form: pick date, start time, end time.
- List of upcoming blocks with delete buttons.

#### 4. Messages Page (`/messages`)

- List of recent conversations grouped by client.
- Click a client to see the full message thread (SMS and system messages).
- Search bar: filter by client name, keyword, or date range.

#### 5. Voice Profile Page (`/voice-profile`)

- Display current sample messages.
- Text area to add/edit sample messages.
- Read-only display of AI-generated tone analysis.
- "Re-analyze" button to regenerate the tone profile.
- Preferences toggles: emoji usage (on/off), formality level slider.

### API Endpoints (Backend)

| Method | Path                          | Description                      |
|--------|-------------------------------|----------------------------------|
| GET    | /api/appointments?week=:date  | Appointments for the week        |
| POST   | /api/appointments             | Create appointment               |
| PUT    | /api/appointments/:id         | Update appointment               |
| DELETE | /api/appointments/:id         | Cancel appointment               |
| GET    | /api/clients                  | List all clients                 |
| POST   | /api/clients                  | Create client                    |
| PUT    | /api/clients/:id              | Update client                    |
| GET    | /api/clients/:id/messages     | Messages for a client            |
| GET    | /api/messages?q=:search       | Search messages                  |
| GET    | /api/voice-profile            | Get voice profile                |
| PUT    | /api/voice-profile            | Update voice profile             |
| POST   | /api/voice-profile/analyze    | Trigger re-analysis              |

### Responsive Design

- Desktop-first (instructor uses laptop/tablet).
- Minimum supported width: 768px.
- Calendar collapses to day view on narrow screens.

## Validation Plan

1. **Component rendering**: Unit tests (Vitest + React Testing Library) for each page and modal.
2. **API integration**: Mock API responses; verify correct data displayed and mutations sent.
3. **Calendar interactions**: Click empty slot, verify modal opens with correct time pre-filled. Click appointment, verify edit modal shows correct data.
4. **Client search**: Type partial name; verify filtered results.
5. **Auth gate**: Access without token cookie; verify redirect to a login prompt.
6. **Visual regression**: Screenshot tests for calendar layout at 1024px and 768px widths.
