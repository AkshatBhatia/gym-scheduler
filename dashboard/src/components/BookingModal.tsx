import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import Modal from './Modal';
import { getClients, getAvailableSlots } from '../api';
import type { TimeSlot } from '../types';

interface BookingModalProps {
  open: boolean;
  onClose: () => void;
  onBook: (data: { clientId: number; startTime: string; endTime: string; notes?: string }) => void;
  loading?: boolean;
  initialDate?: string;
}

export default function BookingModal({ open, onClose, onBook, loading, initialDate }: BookingModalProps) {
  const [clientId, setClientId] = useState<number | ''>('');
  const [date, setDate] = useState(initialDate ?? format(new Date(), 'yyyy-MM-dd'));
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [notes, setNotes] = useState('');

  const { data: clients } = useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
    enabled: open,
  });

  const { data: slots, isLoading: slotsLoading } = useQuery({
    queryKey: ['slots', date],
    queryFn: () => getAvailableSlots(date),
    enabled: open && !!date,
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!clientId || !selectedSlot) return;
    onBook({
      clientId: Number(clientId),
      startTime: selectedSlot.startTime,
      endTime: selectedSlot.endTime,
      notes: notes || undefined,
    });
  }

  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

  return (
    <Modal open={open} onClose={onClose} title="Book Session" wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Client *</label>
          <select
            required
            className={inputCls}
            value={clientId}
            onChange={(e) => setClientId(Number(e.target.value))}
          >
            <option value="">Select a client...</option>
            {clients?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.sessionsRemaining} sessions left)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Date *</label>
          <input
            type="date"
            required
            className={inputCls}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setSelectedSlot(null);
            }}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Available Slots *
          </label>
          {slotsLoading ? (
            <p className="text-sm text-gray-500">Loading slots...</p>
          ) : slots && slots.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {slots.map((slot) => {
                const start = format(new Date(slot.startTime), 'h:mm a');
                const isSelected = selectedSlot?.startTime === slot.startTime;
                return (
                  <button
                    key={slot.startTime}
                    type="button"
                    disabled={!slot.available}
                    onClick={() => setSelectedSlot(slot)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      !slot.available
                        ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400'
                        : isSelected
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-300 text-gray-700 hover:border-indigo-300 hover:bg-indigo-50'
                    }`}
                  >
                    {start}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No available slots for this date.</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
          <textarea
            rows={2}
            className={inputCls}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !clientId || !selectedSlot}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Booking...' : 'Book Session'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
