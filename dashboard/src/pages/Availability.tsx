import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { getAvailability, createAvailability, deleteAvailability } from '../api';
import type { AvailabilityRule } from '../types';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sat, Sun
const HOURS = Array.from({ length: 24 }, (_, i) => i); // full 24 hours

export default function Availability() {
  const queryClient = useQueryClient();
  const [blockDate, setBlockDate] = useState('');
  const [blockStart, setBlockStart] = useState('09:00');
  const [blockEnd, setBlockEnd] = useState('17:00');

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['availability'],
    queryFn: getAvailability,
  });

  const createMutation = useMutation({
    mutationFn: createAvailability,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAvailability,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability'] });
    },
  });

  function toggleCell(dayOfWeek: number, hour: number) {
    const timeStr = `${String(hour).padStart(2, '0')}:00`;
    const endStr = `${String(hour + 1).padStart(2, '0')}:00`;

    // Check for a blocked rule first (takes priority)
    const blockedRule = rules.find(
      (r) =>
        !r.overrideDate &&
        r.dayOfWeek === dayOfWeek &&
        r.isBlocked &&
        r.startTime <= timeStr &&
        r.endTime > timeStr
    );

    if (blockedRule) {
      // Remove the block
      deleteMutation.mutate(blockedRule.id);
      return;
    }

    // Check for an availability rule covering this slot
    const availRule = rules.find(
      (r) =>
        !r.overrideDate &&
        r.dayOfWeek === dayOfWeek &&
        !r.isBlocked &&
        r.startTime <= timeStr &&
        r.endTime > timeStr
    );

    if (availRule) {
      // Available → block this hour
      createMutation.mutate({
        dayOfWeek,
        startTime: timeStr,
        endTime: endStr,
        isBlocked: true,
      });
    } else {
      // No rule → create available slot
      createMutation.mutate({
        dayOfWeek,
        startTime: timeStr,
        endTime: endStr,
        isBlocked: false,
      });
    }
  }

  function getCellState(dayOfWeek: number, hour: number): 'available' | 'blocked' | 'none' {
    const timeStr = `${String(hour).padStart(2, '0')}:00`;
    const endStr = `${String(hour + 1).padStart(2, '0')}:00`;

    // Check recurring rules (no overrideDate) for this day
    const recurringRule = rules.find(
      (r) =>
        !r.overrideDate &&
        r.dayOfWeek === dayOfWeek &&
        r.startTime <= timeStr &&
        r.endTime > timeStr &&
        !r.isBlocked
    );

    // Check recurring blocked rules (no overrideDate) for this day
    const recurringBlock = rules.find(
      (r) =>
        !r.overrideDate &&
        r.dayOfWeek === dayOfWeek &&
        r.startTime <= timeStr &&
        r.endTime > timeStr &&
        r.isBlocked
    );

    if (recurringBlock) return 'blocked';
    if (recurringRule) return 'available';
    return 'none';
  }

  function handleBlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (!blockDate) return;
    const dayOfWeek = new Date(blockDate + 'T12:00:00').getDay();
    createMutation.mutate({
      dayOfWeek,
      startTime: blockStart,
      endTime: blockEnd,
      isBlocked: true,
      overrideDate: blockDate,
    });
    setBlockDate('');
  }

  const overrides = rules.filter((r) => r.overrideDate);

  const CELL_COLORS = {
    available: 'bg-green-200 hover:bg-green-300 border-green-300',
    blocked: 'bg-red-200 hover:bg-red-300 border-red-300',
    none: 'bg-gray-50 hover:bg-gray-100 border-gray-200',
  };

  return (
    <div className="space-y-6">
      {/* Legend */}
      <div className="flex items-center gap-6 text-sm text-gray-600">
        <span className="flex items-center gap-2">
          <span className="h-4 w-4 rounded border border-green-300 bg-green-200" />
          Available
        </span>
        <span className="flex items-center gap-2">
          <span className="h-4 w-4 rounded border border-red-300 bg-red-200" />
          Blocked
        </span>
        <span className="flex items-center gap-2">
          <span className="h-4 w-4 rounded border border-gray-200 bg-gray-50" />
          Not set
        </span>
        <span className="text-xs text-gray-400">Click a cell to toggle</span>
      </div>

      {/* Weekly grid */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-gray-400">Loading...</div>
        ) : (
          <div className="min-w-[700px]">
            {/* Day headers */}
            <div className="grid grid-cols-[80px_repeat(7,1fr)] border-b border-gray-200">
              <div className="border-r border-gray-200 p-2" />
              {DISPLAY_DAYS.map((d) => (
                <div
                  key={d}
                  className="border-r border-gray-100 p-2 text-center text-xs font-semibold text-gray-600 last:border-r-0"
                >
                  {DAY_LABELS[d]}
                </div>
              ))}
            </div>

            {/* Hour rows */}
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="grid grid-cols-[80px_repeat(7,1fr)] border-b border-gray-100 last:border-b-0"
              >
                <div className="flex items-center justify-end border-r border-gray-200 p-2 text-xs font-medium text-gray-400">
                  {format(new Date(2000, 0, 1, hour), 'h a')}
                </div>
                {DISPLAY_DAYS.map((dayOfWeek) => {
                  const state = getCellState(dayOfWeek, hour);
                  return (
                    <button
                      key={dayOfWeek}
                      onClick={() => toggleCell(dayOfWeek, hour)}
                      disabled={createMutation.isPending || deleteMutation.isPending}
                      className={`min-h-[40px] border-r border-b-0 transition-colors last:border-r-0 ${CELL_COLORS[state]} disabled:opacity-50`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Block Time Off form */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-gray-800">Block Time Off</h3>
          <form onSubmit={handleBlockSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Date</label>
              <input
                type="date"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={blockDate}
                onChange={(e) => setBlockDate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Start
                </label>
                <input
                  type="time"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={blockStart}
                  onChange={(e) => setBlockStart(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  End
                </label>
                <input
                  type="time"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={blockEnd}
                  onChange={(e) => setBlockEnd(e.target.value)}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Blocking...' : 'Block Time'}
            </button>
          </form>
        </div>

        {/* Current overrides */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h3 className="text-base font-semibold text-gray-800">Date Overrides</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {overrides.length === 0 ? (
              <div className="px-6 py-6 text-center text-sm text-gray-400">
                No date overrides set.
              </div>
            ) : (
              overrides.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between px-6 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {rule.overrideDate}
                    </p>
                    <p className="text-xs text-gray-500">
                      {rule.startTime} - {rule.endTime}
                      {rule.isBlocked && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-600">
                          Blocked
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteMutation.mutate(rule.id)}
                    disabled={deleteMutation.isPending}
                    className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
