import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface Instructor {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  businessName: string | null;
  venmoHandle: string | null;
  timezone: string | null;
}

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export default function Profile({ onLogout }: { onLogout: () => void }) {
  const queryClient = useQueryClient();
  const token = localStorage.getItem('token');

  const { data: profile, isLoading } = useQuery<Instructor>({
    queryKey: ['profile'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load profile');
      return res.json();
    },
  });

  const [form, setForm] = useState({
    name: '',
    email: '',
    businessName: '',
    venmoHandle: '',
    timezone: 'America/Los_Angeles',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile) {
      setForm({
        name: profile.name || '',
        email: profile.email || '',
        businessName: profile.businessName || '',
        venmoHandle: profile.venmoHandle || '',
        timezone: profile.timezone || 'America/Los_Angeles',
      });
    }
  }, [profile]);

  const updateMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await fetch('/api/auth/me', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate(form);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-gray-400">
        Loading profile...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-800">Instructor Profile</h2>
          <p className="text-xs text-gray-500">Your personal and business information</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
              <input
                type="text"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Phone</label>
              <input
                type="tel"
                disabled
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
                value={profile?.phone || ''}
              />
              <p className="mt-0.5 text-xs text-gray-400">Phone cannot be changed</p>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@example.com"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Business Name</label>
              <input
                type="text"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={form.businessName}
                onChange={(e) => setForm({ ...form, businessName: e.target.value })}
                placeholder="My Gym"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Venmo Handle</label>
              <div className="flex">
                <span className="inline-flex items-center rounded-l-lg border border-r-0 border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">@</span>
                <input
                  type="text"
                  className="w-full rounded-r-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={form.venmoHandle}
                  onChange={(e) => setForm({ ...form, venmoHandle: e.target.value })}
                  placeholder="yourhandle"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Timezone</label>
            <select
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 pt-4">
            <div>
              {saved && (
                <span className="text-sm font-medium text-green-600">Profile saved!</span>
              )}
              {updateMutation.isError && (
                <span className="text-sm text-red-600">Failed to save</span>
              )}
            </div>
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700 disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </form>
      </div>

      {/* Logout */}
      <div className="rounded-xl border border-gray-200 bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">Sign Out</p>
            <p className="text-xs text-gray-500">Logged in as {profile?.phone}</p>
          </div>
          <button
            onClick={onLogout}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            Log Out
          </button>
        </div>
      </div>
    </div>
  );
}
