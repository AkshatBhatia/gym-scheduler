import { useState, type FormEvent } from 'react';
import type { Client } from '../types';

interface ClientFormProps {
  initial?: Partial<Client>;
  onSubmit: (data: Partial<Client>) => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function ClientForm({ initial, onSubmit, onCancel, loading }: ClientFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [packageType, setPackageType] = useState(initial?.packageType ?? '');
  const [sessionsRemaining, setSessionsRemaining] = useState(
    initial?.sessionsRemaining ?? 0
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      name,
      phone,
      email: email || undefined,
      packageType,
      sessionsRemaining,
      notes: notes || undefined,
    });
  }

  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Name *</label>
        <input
          required
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Phone *</label>
        <input
          required
          className={inputCls}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
        <input
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Package Type *
          </label>
          <select
            required
            className={inputCls}
            value={packageType}
            onChange={(e) => setPackageType(e.target.value)}
          >
            <option value="">Select...</option>
            <option value="single">Single Session</option>
            <option value="5-pack">5-Pack</option>
            <option value="10-pack">10-Pack</option>
            <option value="monthly">Monthly Unlimited</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Sessions Left
          </label>
          <input
            type="number"
            min={0}
            className={inputCls}
            value={sessionsRemaining}
            onChange={(e) => setSessionsRemaining(Number(e.target.value))}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
        <textarea
          rows={3}
          className={inputCls}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? 'Saving...' : initial?.id ? 'Update Client' : 'Add Client'}
        </button>
      </div>
    </form>
  );
}
