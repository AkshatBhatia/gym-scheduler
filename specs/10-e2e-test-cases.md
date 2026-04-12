# End-to-End Test Cases

## Prerequisites
- Server running on port 3001
- Dashboard running on port 5173
- Fresh database (run `npm run db:seed` before each full test run)
- Instructor phone: +15129250165
- Timezone: America/Los_Angeles

## How to Run
Each test case can be run via curl (API) or the Chat Console (UI).
Tests are grouped by feature area. Each test has:
- **Setup**: Any preconditions
- **Steps**: Exact commands or actions
- **Expected**: What should happen
- **Verify**: How to confirm it worked

---

## T01: Client CRUD

### T01.1: Create a client
```bash
curl -s -X POST http://localhost:3001/api/clients \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","phone":"+15550001111","packageType":"10-pack","sessionsRemaining":10}'
```
**Expected**: 201 response with client object, sessionsRemaining=10

### T01.2: Create duplicate phone fails
```bash
curl -s -X POST http://localhost:3001/api/clients \
  -H "Content-Type: application/json" \
  -d '{"name":"Duplicate","phone":"+15550001111"}'
```
**Expected**: 409 response with "already exists" error

### T01.3: List clients with search
```bash
curl -s "http://localhost:3001/api/clients?search=Test"
```
**Expected**: Returns array containing "Test User"

### T01.4: Get client detail
```bash
curl -s http://localhost:3001/api/clients/{id}
```
**Expected**: Returns client with appointments array

### T01.5: Update client
```bash
curl -s -X PUT http://localhost:3001/api/clients/{id} \
  -H "Content-Type: application/json" \
  -d '{"notes":"Prefers mornings"}'
```
**Expected**: Updated client returned with notes set

### T01.6: Soft delete client
```bash
curl -s -X DELETE http://localhost:3001/api/clients/{id}
```
**Expected**: Client active=0, no longer appears in GET /api/clients list

---

## T02: Availability & Scheduling

### T02.1: Default availability slots
```bash
curl -s "http://localhost:3001/api/availability/slots?date=NEXT_MONDAY"
```
**Expected**: 12 slots (6am-6pm hourly), all available=true

### T02.2: Sunday has no slots
```bash
curl -s "http://localhost:3001/api/availability/slots?date=NEXT_SUNDAY"
```
**Expected**: Empty array (no availability on Sundays)

### T02.3: Block time off
```bash
curl -s -X POST http://localhost:3001/api/availability \
  -H "Content-Type: application/json" \
  -d '{"overrideDate":"NEXT_MONDAY","startTime":"12:00","endTime":"14:00","isBlocked":true}'
```
**Expected**: Block created. GET slots for that date shows 10 slots (12pm and 1pm missing)

### T02.4: Blocked time prevents booking
```bash
# Book during blocked time
curl -s -X POST http://localhost:3001/api/appointments \
  -H "Content-Type: application/json" \
  -d '{"clientId":CLIENT_ID,"startTime":"NEXT_MONDAY_T12:00:00"}'
```
**Expected**: The slot should show as unavailable. (Note: current API may allow booking in blocked slots — this is a potential bug to verify)

### T02.5: Remove block via availability grid
- Navigate to Availability page
- Click a red (blocked) cell
**Expected**: Cell turns green, block is deleted from DB

---

## T03: Appointment Booking

### T03.1: Book an appointment
```bash
curl -s -X POST http://localhost:3001/api/appointments \
  -H "Content-Type: application/json" \
  -d '{"clientId":CLIENT_ID,"startTime":"NEXT_TUESDAY_T10:00:00","notes":"Upper body"}'
```
**Expected**: Appointment created with status=confirmed, endTime = startTime + 1 hour

### T03.2: Double booking prevented
```bash
curl -s -X POST http://localhost:3001/api/appointments \
  -H "Content-Type: application/json" \
  -d '{"clientId":ANOTHER_CLIENT_ID,"startTime":"NEXT_TUESDAY_T10:00:00"}'
```
**Expected**: Error "Time slot is already booked"

### T03.3: Complete appointment decrements sessions
```bash
curl -s -X PUT http://localhost:3001/api/appointments/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"completed"}'
```
**Expected**: Status=completed, client sessionsRemaining decremented by 1, ledger entry created

### T03.4: Cancel appointment
```bash
curl -s -X PUT http://localhost:3001/api/appointments/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"cancelled","reason":"Client sick"}'
```
**Expected**: Status=cancelled, notes updated with reason

### T03.5: Cancelled slot becomes available
- After cancelling, check available slots for that date
**Expected**: The cancelled time slot appears as available again

### T03.6: Times are stored in UTC, displayed in local timezone
- Book at "3:00 PM" via Chat Console (instructor says "book at 3pm")
- Check raw DB: should be stored as UTC (10pm UTC for Pacific)
- Check API response: should return local time (3:00 PM)
- Check Schedule page: should show at 3 PM slot

---

## T04: Recurring Schedules

### T04.1: Create recurring schedule
```bash
curl -s -X POST http://localhost:3001/api/recurring \
  -H "Content-Type: application/json" \
  -d '{"clientId":CLIENT_ID,"dayOfWeek":2,"startTime":"10:00","endTime":"11:00"}'
```
**Expected**: Schedule created, appointments auto-generated matching client's sessionsRemaining

### T04.2: Appointments match session count
- Client has 5 sessions, 1 recurring day → should generate 5 appointments
- Client has 5 sessions, 2 recurring days → should generate 5 appointments total (not 5 per day)
**Expected**: Total recurring appointments = sessionsRemaining

### T04.3: One-off bookings don't reduce recurring count
- Client has 5 sessions, 1 recurring schedule with 5 appointments already generated
- Manually book a one-off appointment
- Regenerate recurring
**Expected**: Still 5 recurring appointments (one-off doesn't affect count)

### T04.4: Adding sessions generates more recurring
```bash
curl -s -X PUT http://localhost:3001/api/clients/{id} \
  -H "Content-Type: application/json" \
  -d '{"sessionsRemaining":15}'
```
Then regenerate:
```bash
curl -s -X POST http://localhost:3001/api/recurring/generate \
  -H "Content-Type: application/json" \
  -d '{"clientId":CLIENT_ID}'
```
**Expected**: More recurring appointments created up to new balance

### T04.5: Recurring times stored in UTC
- Create recurring at 8:00 AM (Pacific)
- Check raw DB appointments: should be 15:00 UTC (or 16:00 depending on DST)
**Expected**: All recurring appointment times are UTC in the database

### T04.6: Delete recurring schedule
```bash
curl -s -X DELETE http://localhost:3001/api/recurring/{id}
```
**Expected**: Schedule deleted. Existing generated appointments remain (not deleted).

---

## T05: Instructor AI Chat

### T05.1: "Who do I have tomorrow?"
- Send as instructor via Chat Console
**Expected**: AI calls list_appointments tool, returns tomorrow's schedule with client names and times in local timezone

### T05.2: "Schedule Sarah for Thursday at 3pm"
- Send as instructor
**Expected**: AI calls book_appointment, creates appointment, confirms with date/time/client, mentions sessions remaining

### T05.3: "Cancel Sarah's Thursday session"
- After T05.2, send as instructor
**Expected**: AI identifies the appointment, cancels it, confirms cancellation

### T05.4: "How many sessions does Emily have?"
- Send as instructor
**Expected**: AI calls get_session_balance, returns count and package type

### T05.5: "Block off Friday afternoon"
- Send as instructor
**Expected**: AI calls block_time with appropriate times (12:00-18:00 or similar), confirms

### T05.6: "Add new client Jane Smith 555-999-0000 with 5 sessions"
- Send as instructor
**Expected**: AI calls add_client, creates client, confirms

### T05.7: Follow-up context maintained
- Say "Schedule Mike for Monday at 10am"
- Then say "Actually make it 11am"
**Expected**: AI understands "it" refers to Mike's Monday appointment from conversation history

### T05.8: "Set up recurring Tuesday and Thursday at 9am for Emily"
- Send as instructor
**Expected**: AI creates recurring schedules, auto-generates appointments, confirms

---

## T06: Client AI Chat

### T06.1: Client confirms appointment
- Select a client with an upcoming appointment
- Send "yes" or "see you then"
**Expected**: Confirmation response, appointment remains confirmed

### T06.2: Client cancels
- Select a client with an upcoming appointment
- Send "can't make it"
**Expected**: Appointment cancelled, session refunded, friendly response

### T06.3: Client books a session
- Select a client, send "Can I book Friday at 2pm?"
**Expected**: AI checks availability, books the slot, confirms with time and sessions remaining

### T06.4: Client double-book same day warning
- Client already has a session on Friday
- Client asks to book another Friday slot
**Expected**: AI warns about existing appointment on same day, asks to confirm before booking

### T06.5: Client sets up recurring
- Send "I want 8am every Monday"
**Expected**: AI creates recurring schedule, generates appointments, confirms

### T06.6: Client asks about balance
- Send "How many sessions do I have left?"
**Expected**: AI responds with session count and package type

### T06.7: Client conversation history maintained
- Send "What times are available Friday?"
- AI responds with slots
- Send "Book the 10am"
**Expected**: AI books Friday at 10am (remembers Friday from prior message)

---

## T07: Unknown Number (Public Booking)

### T07.1: Unknown number asks about availability
- Send as Unknown: "Do you have any openings this week?"
**Expected**: AI shows available slots for next few days

### T07.2: Unknown number books
- Send "I'd like the Thursday 3pm slot, my name is John"
**Expected**: Response acknowledges, may ask for more info or confirm

---

## T08: Dashboard & Calendar UI

### T08.1: Dashboard summary accurate
- Navigate to /
**Expected**: Today's Sessions count matches actual appointments, Total Clients correct, This Week count correct

### T08.2: Low balance alerts
- Set a client's sessions to 1
**Expected**: Client appears in Low Balance Alerts section

### T08.3: Schedule shows appointments in correct slots
- Book appointments at specific times
- Navigate to /schedule
**Expected**: Each appointment appears in the correct day column and hour row

### T08.4: Schedule shows blocked time
- Block a time range
- Navigate to /schedule
**Expected**: Blocked cells show red background with "Blocked" label

### T08.5: Click appointment shows details
- Click an appointment on the schedule
**Expected**: Modal shows client name, time, status, with buttons to change status

### T08.6: Week navigation
- Click "Next →" and "← Prev"
**Expected**: Calendar updates to show correct week, appointments load for that week

---

## T09: Messages

### T09.1: All SMS messages stored
- Send messages via Chat Console (instructor, client, unknown)
- Navigate to /messages
**Expected**: All conversations appear, grouped by client. Instructor messages grouped as "Instructor (You)"

### T09.2: Message search
- Search for a keyword that appears in a message
**Expected**: Only conversations containing that keyword shown

### T09.3: Chat thread display
- Click a conversation
**Expected**: Messages displayed in chat-bubble style, outbound (indigo, right), inbound (gray, left), with sender label and timestamp above body

---

## T10: Timezone Handling

### T10.1: Instructor chat uses local timezone
- As instructor: "What's my schedule for tomorrow?"
**Expected**: Times shown in Pacific (e.g., "3:00 PM" not "22:00" or "10:00 PM UTC")

### T10.2: Schedule page shows local times
- Book appointment at 3pm Pacific
- Check Schedule page
**Expected**: Shows in 3 PM row, not offset

### T10.3: Changing timezone updates display
```bash
curl -s -X PUT http://localhost:3001/api/settings/timezone \
  -H "Content-Type: application/json" \
  -d '{"timezone":"America/New_York"}'
```
- Check schedule: same appointment should now show at 6 PM (Eastern)
**Expected**: All displayed times shift by 3 hours

### T10.4: Recurring appointments stored in UTC
- Create recurring at 8am Pacific
- Raw DB should show 15:00Z (or 16:00Z during DST)
**Expected**: UTC in DB, local time in API response

---

## T11: Auth & Profile

### T11.1: Login flow
- Navigate to / (should show login page)
- Enter phone, click "Send Login Code"
- Check server log for OTP code
- Enter code, click "Log In"
**Expected**: Redirected to dashboard, JWT stored in localStorage

### T11.2: Profile page
- Navigate to /profile
- Fill in name, business name, venmo handle, timezone
- Click "Save Profile"
**Expected**: "Profile saved!" confirmation, data persists on reload

### T11.3: Logout
- Click "Log Out" on profile page
**Expected**: Redirected to login page, localStorage cleared

### T11.4: Expired token
- Manually set an expired JWT in localStorage
- Navigate to any page
**Expected**: API returns 401, should redirect to login

---

## T12: Mobile Responsiveness

### T12.1: Dashboard mobile
- Resize to 390x844
**Expected**: Cards stack vertically, no horizontal overflow

### T12.2: Clients table mobile
**Expected**: Phone and Status columns hidden, Name/Package/Sessions visible

### T12.3: Schedule mobile
**Expected**: Calendar scrolls horizontally, header wraps properly

### T12.4: Messages mobile
- Tap a conversation
**Expected**: Chat thread goes full-width, back button appears

### T12.5: Sidebar mobile
- Tap hamburger menu
**Expected**: Sidebar slides in, overlay behind, clicking outside closes it

---

## T13: Edge Cases

### T13.1: Book appointment for inactive client
**Expected**: Error or warning

### T13.2: Complete already-completed appointment
**Expected**: Error "Cannot complete appointment with status 'completed'"

### T13.3: Cancel already-cancelled appointment
**Expected**: Error "already cancelled"

### T13.4: Book in the past
- Try booking for yesterday at 3pm
**Expected**: Should be rejected or warned

### T13.5: Client with 0 sessions tries to book
**Expected**: Booking should still work (pay-per-session) or warn about 0 balance

### T13.6: Very long message handling
- Send a 500+ character message via Chat Console
**Expected**: No crashes, message stored and displayed properly
