# GymFlow — TODO

## UX / Design
- [ ] Mobile-first polish — test all flows on actual phone, not just resized browser
- [ ] Login page: add "Skip" button in dev mode (use fixed OTP 12345)
- [ ] Dashboard: empty state for new instructors (onboarding flow)
- [ ] Schedule: swipe gesture for week navigation on mobile
- [ ] Client detail page: add "Text Client" button that opens Chat Console with client selected
- [ ] Chat Console: auto-scroll to bottom when switching channels
- [ ] Availability: show time labels on mobile (currently cut off on small screens)
- [ ] Add loading spinners/skeletons for API calls instead of blank screens
- [ ] Toast notifications for actions (booking confirmed, client added, etc.)

## Features
- [ ] Toll-free SMS verification — resubmitted, waiting for approval
- [ ] Voice profile onboarding (Phase 2) — analyze instructor's texting style
- [ ] Payment reminders with Venmo deeplink
- [ ] Weekly summary text to instructor (sessions completed, revenue, cancellation rate)
- [ ] Waitlist for full days
- [ ] No-show tracking and patterns
- [ ] Client-facing booking link (Phase 3 — public inbound booking)

## Bugs / Tech Debt
- [ ] Dev OTP bypass (12345) — code written but not committed/deployed
- [ ] Clean up broken test files from failed agents (11 stale .test.ts files)
- [ ] 6 test setup issues — sessions tests expect negative balance but code clamps to 0
- [ ] `chat.ts` is 1400+ lines — split into separate modules (tools, prompts, agent loop)
- [ ] Client name lookup loads all clients (5x in chat.ts) — use SQL LIKE
- [ ] N+1 queries in recurring.ts — batch existence check
- [ ] No pagination on messages API endpoint
- [ ] Schedule.tsx O(n*m) cell filtering — pre-group with useMemo
- [ ] Chat Console parses TwiML with regex — add a JSON endpoint for dashboard
- [ ] Recurring generation: add DST-aware time handling for appointments that cross DST boundaries

## Infrastructure
- [ ] Multi-tenant support (per-instructor DB or tenant_id column)
- [ ] Migrate from SQLite to Supabase/Postgres when adding multi-tenant
- [ ] Set up CI/CD pipeline (run tests on PR, deploy on merge to main)
- [ ] Add Render persistent disk for SQLite data durability
- [ ] Custom domain for gymflow (gymflow.app or similar)
- [ ] Rate limiting on public endpoints (OTP, SMS webhook)
- [ ] Twilio signature verification in production
