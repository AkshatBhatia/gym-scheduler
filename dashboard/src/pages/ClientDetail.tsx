import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { getClient, updateClient, getAppointments, getClientMessages } from '../api';
import StatusBadge from '../components/StatusBadge';
import Modal from '../components/Modal';
import ClientForm from '../components/ClientForm';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const clientId = Number(id);
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data: client, isLoading } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => getClient(clientId),
    enabled: !!clientId,
  });

  const { data: allAppointments = [] } = useQuery({
    queryKey: ['appointments'],
    queryFn: getAppointments,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ['client-messages', clientId],
    queryFn: () => getClientMessages(clientId),
    enabled: !!clientId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof updateClient>[1]) =>
      updateClient(clientId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client', clientId] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      setEditOpen(false);
    },
  });

  const clientAppts = allAppointments.filter((a) => a.clientId === clientId);
  const upcoming = clientAppts
    .filter((a) => new Date(a.startTime) >= new Date() && a.status !== 'cancelled')
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const history = clientAppts
    .filter((a) => new Date(a.startTime) < new Date() || a.status === 'cancelled')
    .sort((a, b) => b.startTime.localeCompare(a.startTime));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading client...
      </div>
    );
  }

  if (!client) {
    return (
      <div className="py-20 text-center text-gray-400">
        Client not found.{' '}
        <Link to="/clients" className="text-indigo-600 hover:underline">
          Back to clients
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm text-gray-500">
        <Link to="/clients" className="text-indigo-600 hover:underline">
          Clients
        </Link>{' '}
        / {client.name}
      </div>

      {/* Client info card */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">{client.name}</h2>
            <div className="mt-2 space-y-1 text-sm text-gray-600">
              <p>Phone: {client.phone}</p>
              {client.email && <p>Email: {client.email}</p>}
              <p>
                Package:{' '}
                <span className="capitalize font-medium">{client.packageType}</span>
              </p>
              <p>
                Sessions Remaining:{' '}
                <span
                  className={`font-semibold ${
                    client.sessionsRemaining <= 2 ? 'text-red-600' : 'text-green-600'
                  }`}
                >
                  {client.sessionsRemaining}
                </span>
              </p>
              <p>
                Status:{' '}
                <span
                  className={`font-medium ${client.active ? 'text-green-600' : 'text-gray-500'}`}
                >
                  {client.active ? 'Active' : 'Inactive'}
                </span>
              </p>
            </div>
            {client.notes && (
              <p className="mt-3 text-sm text-gray-500">
                <span className="font-medium text-gray-700">Notes:</span> {client.notes}
              </p>
            )}
          </div>
          <button
            onClick={() => setEditOpen(true)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Upcoming appointments */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h3 className="text-base font-semibold text-gray-800">
              Upcoming Appointments
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {upcoming.length === 0 ? (
              <div className="px-6 py-6 text-center text-sm text-gray-400">
                No upcoming appointments.
              </div>
            ) : (
              upcoming.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center justify-between px-6 py-3"
                >
                  <span className="text-sm text-gray-700">
                    {format(parseISO(appt.startTime), 'EEE, MMM d · h:mm a')}
                  </span>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Session history */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h3 className="text-base font-semibold text-gray-800">Session History</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {history.length === 0 ? (
              <div className="px-6 py-6 text-center text-sm text-gray-400">
                No past sessions.
              </div>
            ) : (
              history.slice(0, 20).map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center justify-between px-6 py-3"
                >
                  <span className="text-sm text-gray-700">
                    {format(parseISO(appt.startTime), 'MMM d, yyyy · h:mm a')}
                  </span>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Recent messages */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-base font-semibold text-gray-800">Recent Messages</h3>
        </div>
        <div className="space-y-3 p-6">
          {messages.length === 0 ? (
            <div className="text-center text-sm text-gray-400">
              No messages with this client.
            </div>
          ) : (
            messages.slice(0, 15).map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-md rounded-xl px-4 py-2 text-sm ${
                    msg.direction === 'outbound'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  <p>{msg.body}</p>
                  <p
                    className={`mt-1 text-xs ${
                      msg.direction === 'outbound' ? 'text-indigo-200' : 'text-gray-400'
                    }`}
                  >
                    {format(parseISO(msg.createdAt), 'MMM d, h:mm a')}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Client">
        <ClientForm
          initial={client}
          onSubmit={(data) => updateMutation.mutate(data)}
          onCancel={() => setEditOpen(false)}
          loading={updateMutation.isPending}
        />
      </Modal>
    </div>
  );
}
