import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getClients, createClient } from '../api';
import Modal from '../components/Modal';
import ClientForm from '../components/ClientForm';

export default function Clients() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
  });

  const createMutation = useMutation({
    mutationFn: createClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      setAddOpen(false);
    },
  });

  const filtered = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search)
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search clients..."
            className="w-full sm:w-64 rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700"
        >
          + Add Client
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-4 py-3 sm:px-6">Name</th>
              <th className="hidden sm:table-cell px-6 py-3">Phone</th>
              <th className="px-4 py-3 sm:px-6">Package</th>
              <th className="px-4 py-3 sm:px-6">Sessions</th>
              <th className="hidden md:table-cell px-6 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-400">
                  {search ? 'No clients match your search.' : 'No clients yet.'}
                </td>
              </tr>
            ) : (
              filtered.map((client) => (
                <tr key={client.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 sm:px-6">
                    <Link
                      to={`/clients/${client.id}`}
                      className="font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      {client.name}
                    </Link>
                  </td>
                  <td className="hidden sm:table-cell px-6 py-3 text-gray-600">{client.phone}</td>
                  <td className="px-4 py-3 sm:px-6 capitalize text-gray-600">
                    {client.packageType}
                  </td>
                  <td className="px-4 py-3 sm:px-6">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                        client.sessionsRemaining <= 2
                          ? 'bg-red-100 text-red-700'
                          : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {client.sessionsRemaining}
                    </span>
                  </td>
                  <td className="hidden md:table-cell px-6 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        client.active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {client.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add client modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Client">
        <ClientForm
          onSubmit={(data) => createMutation.mutate(data)}
          onCancel={() => setAddOpen(false)}
          loading={createMutation.isPending}
        />
      </Modal>
    </div>
  );
}
