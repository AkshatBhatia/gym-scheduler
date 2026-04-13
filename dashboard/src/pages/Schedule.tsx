import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  format,
  parseISO,
  startOfWeek,
  addDays,
  isSameDay,
  getHours,
  getMinutes,
} from 'date-fns';
import { getWeekAppointments, createAppointment, updateAppointmentStatus, deleteAppointment, getAvailability } from '../api';
import type { Appointment, AvailabilityRule } from '../types';
import StatusBadge from '../components/StatusBadge';
import BookingModal from '../components/BookingModal';
import Modal from '../components/Modal';

const HOURS = Array.from({ length: 24 }, (_, i) => i); // 0am-11pm (full 24 hours)
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_BG: Record<Appointment['status'], string> = {
  confirmed: 'bg-blue-100 border-blue-300 text-blue-800',
  completed: 'bg-green-100 border-green-300 text-green-800',
  cancelled: 'bg-red-50 border-red-200 text-red-400 line-through',
  'no-show': 'bg-orange-100 border-orange-300 text-orange-800',
};

export default function Schedule() {
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 })
  );
  const [bookingOpen, setBookingOpen] = useState(false);
  const [selected, setSelected] = useState<Appointment | null>(null);

  const weekStartStr = format(weekStart, 'yyyy-MM-dd');

  const { data: appointments = [] } = useQuery({
    queryKey: ['week-appointments', weekStartStr],
    queryFn: () => getWeekAppointments(weekStartStr),
  });

  const { data: availabilityRules = [] } = useQuery({
    queryKey: ['availability'],
    queryFn: getAvailability,
  });

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const bookMutation = useMutation({
    mutationFn: createAppointment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['week-appointments'] });
      setBookingOpen(false);
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Appointment['status'] }) =>
      updateAppointmentStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['week-appointments'] });
      setSelected(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteAppointment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['week-appointments'] });
      setSelected(null);
    },
  });

  function getApptsForCell(day: Date, hour: number) {
    return appointments.filter((a) => {
      const start = parseISO(a.startTime);
      return isSameDay(start, day) && getHours(start) === hour;
    });
  }

  function isCellBlocked(day: Date, hour: number): boolean {
    const dayOfWeek = day.getDay(); // 0=Sun
    const dateStr = format(day, 'yyyy-MM-dd');
    const timeStr = `${String(hour).padStart(2, '0')}:00`;

    return availabilityRules.some(
      (r) =>
        r.isBlocked &&
        r.startTime <= timeStr &&
        r.endTime > timeStr &&
        (
          // Date-specific override matching this date
          (r.overrideDate && r.overrideDate === dateStr) ||
          // Recurring blocked rule matching this day of week
          (!r.overrideDate && r.dayOfWeek === dayOfWeek)
        )
    );
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart((d) => addDays(d, -7))}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            &larr; Prev
          </button>
          <span className="text-sm font-semibold text-gray-700">
            {format(weekStart, 'MMM d')} &mdash; {format(addDays(weekStart, 6), 'MMM d, yyyy')}
          </span>
          <button
            onClick={() => setWeekStart((d) => addDays(d, 7))}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Next &rarr;
          </button>
        </div>
        <button
          onClick={() => setBookingOpen(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700"
        >
          + Book Session
        </button>
      </div>

      {/* Calendar grid */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="min-w-[800px]">
          {/* Day headers */}
          <div className="grid grid-cols-[80px_repeat(7,1fr)] border-b border-gray-200">
            <div className="border-r border-gray-200 p-2" />
            {days.map((day, i) => (
              <div
                key={i}
                className="border-r border-gray-100 p-2 text-center last:border-r-0"
              >
                <div className="text-xs font-medium text-gray-500">{DAY_LABELS[i]}</div>
                <div
                  className={`text-sm font-semibold ${
                    isSameDay(day, new Date())
                      ? 'text-indigo-600'
                      : 'text-gray-800'
                  }`}
                >
                  {format(day, 'd')}
                </div>
              </div>
            ))}
          </div>

          {/* Hour rows */}
          {HOURS.map((hour) => (
            <div
              key={hour}
              className="grid grid-cols-[80px_repeat(7,1fr)] border-b border-gray-100 last:border-b-0"
            >
              <div className="flex items-start justify-end border-r border-gray-200 p-2 text-xs font-medium text-gray-400">
                {format(new Date(2000, 0, 1, hour), 'h a')}
              </div>
              {days.map((day, di) => {
                const cellAppts = getApptsForCell(day, hour);
                const blocked = isCellBlocked(day, hour);
                return (
                  <div
                    key={di}
                    className={`flex min-h-[56px] flex-col border-r border-gray-50 p-1 last:border-r-0 ${
                      blocked ? 'bg-red-50' : ''
                    }`}
                  >
                    {blocked && cellAppts.length === 0 && (
                      <span className="text-xs text-red-400 italic">Blocked</span>
                    )}
                    {cellAppts.map((appt) => (
                      <button
                        key={appt.id}
                        onClick={() => setSelected(appt)}
                        className={`flex-1 w-full truncate rounded-md border px-2 py-2 text-left text-xs font-medium transition-shadow hover:shadow-md ${STATUS_BG[appt.status]}`}
                      >
                        {appt.clientName ?? `Client #${appt.clientId}`}
                        <span className="ml-1 opacity-60">
                          {format(parseISO(appt.startTime), 'h:mm')}
                          {appt.endTime &&
                            `-${format(parseISO(appt.endTime), 'h:mm')}`}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Booking modal */}
      <BookingModal
        open={bookingOpen}
        onClose={() => setBookingOpen(false)}
        onBook={(data) => bookMutation.mutate(data)}
        loading={bookMutation.isPending}
        initialDate={format(weekStart, 'yyyy-MM-dd')}
      />

      {/* Appointment detail modal */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Appointment Details"
      >
        {selected && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">Client</span>
                <span className="text-sm font-medium text-gray-800">
                  {selected.clientName ?? `Client #${selected.clientId}`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">Time</span>
                <span className="text-sm font-medium text-gray-800">
                  {format(parseISO(selected.startTime), 'MMM d, h:mm a')}
                  {selected.endTime &&
                    ` - ${format(parseISO(selected.endTime), 'h:mm a')}`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">Status</span>
                <StatusBadge status={selected.status} />
              </div>
              {selected.notes && (
                <div>
                  <span className="text-sm text-gray-500">Notes</span>
                  <p className="mt-1 text-sm text-gray-700">{selected.notes}</p>
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 pt-4">
              <p className="mb-2 text-sm font-medium text-gray-700">Change Status:</p>
              <div className="flex flex-wrap gap-2">
                {(
                  ['confirmed', 'completed', 'no-show', 'cancelled'] as Appointment['status'][]
                ).map((s) => (
                  <button
                    key={s}
                    disabled={selected.status === s || statusMutation.isPending}
                    onClick={() =>
                      statusMutation.mutate({ id: selected.id, status: s })
                    }
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-40 ${
                      selected.status === s
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-gray-200 pt-4">
              <button
                onClick={() => {
                  if (confirm('Permanently delete this appointment? This cannot be undone.')) {
                    deleteMutation.mutate(selected.id);
                  }
                }}
                disabled={deleteMutation.isPending}
                className="rounded-lg border border-red-300 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Appointment'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
