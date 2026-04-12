# 03 — Availability & Scheduling

## What

Rules engine that defines when the instructor is available, calculates open slots, and prevents double-booking.

## How

### Default Weekly Schedule

| Day       | Hours         |
|-----------|---------------|
| Monday    | 6:00 AM – 6:00 PM |
| Tuesday   | 6:00 AM – 6:00 PM |
| Wednesday | 6:00 AM – 6:00 PM |
| Thursday  | 6:00 AM – 6:00 PM |
| Friday    | 6:00 AM – 6:00 PM |
| Saturday  | 6:00 AM – 6:00 PM |
| Sunday    | Unavailable    |

Stored as recurring rows in the `availability` table (override_date = NULL, is_blocked = 0).

### Slot Duration

All appointments are **1 hour**. Slots align to the hour (6:00, 7:00, ..., 17:00 for a 6am-6pm day). No half-hour slots in v1.

### Per-Day Overrides

To change hours for a specific date (e.g., Saturday April 11 is only 8am-12pm):

- Insert a row with `override_date = '2026-04-11'`, `day_of_week = 6`, `start_time = '08:00'`, `end_time = '12:00'`, `is_blocked = 0`.
- When calculating availability for that date, the override row takes precedence over the recurring row for the same day_of_week.

### Time-Off Blocks

To block a specific time range:

- Insert a row with `is_blocked = 1`, the target `override_date`, and the blocked `start_time`/`end_time`.
- To block an entire day, set start_time = '00:00', end_time = '23:59'.

### Slot Availability Calculation

`getAvailableSlots(date: string): Slot[]`

1. Determine the day_of_week for the given date.
2. Check for override rows matching the exact date. If found, use those as the base hours. Otherwise, use the recurring rows for that day_of_week.
3. Generate all 1-hour slots within the base hours.
4. Subtract any time-off blocks (is_blocked = 1) for that date.
5. Subtract any existing confirmed appointments that overlap each slot.
6. Return the remaining open slots.

### Double-Booking Prevention

Before inserting an appointment:

1. Query for any confirmed appointment where `start_time < new_end_time AND end_time > new_start_time`.
2. If any exist, reject the booking and return the conflicting appointment details.
3. This check runs inside a transaction to prevent race conditions.

### API Endpoints

| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | /api/availability/:date     | Returns open slots for a date      |
| GET    | /api/availability/week/:date| Returns open slots for the week    |
| PUT    | /api/availability/override  | Set hours override for a date      |
| POST   | /api/availability/block     | Block a time range                 |
| DELETE | /api/availability/block/:id | Remove a time-off block            |

## Validation Plan

1. **Slot generation**: Given default hours, assert 12 slots (6am-6pm) are generated for a Monday.
2. **Override precedence**: Set a Saturday override to 8am-12pm; confirm only 4 slots returned.
3. **Block subtraction**: Block 10am-12pm on a Tuesday; confirm those 2 slots are removed.
4. **Double-booking**: Book a slot, then attempt to book the same slot; assert rejection with conflict info.
5. **Full-day block**: Block an entire day; confirm zero slots returned.
6. **Edge case**: Book last slot of the day (5pm-6pm); confirm it is unavailable and 4pm-5pm is still open.
