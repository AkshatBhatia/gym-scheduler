import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { getMessages, getClients } from '../api';
import type { Message, Client } from '../types';

export default function Messages() {
  const [search, setSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);

  const { data: messages = [], isLoading: msgsLoading } = useQuery({
    queryKey: ['messages'],
    queryFn: getMessages,
  });

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
  });

  const clientMap = useMemo(() => {
    const map = new Map<number, Client>();
    clients.forEach((c) => map.set(c.id, c));
    return map;
  }, [clients]);

  const INSTRUCTOR_GROUP_ID = -1;

  // Group messages by client (instructor messages grouped under -1)
  const grouped = useMemo(() => {
    const groups = new Map<number, Message[]>();
    messages.forEach((m) => {
      const key = m.clientId ?? INSTRUCTOR_GROUP_ID;
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    });
    // Sort each group by time, and sort groups by latest message
    const entries = Array.from(groups.entries()).map(([clientId, msgs]) => ({
      clientId,
      messages: msgs.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ),
      latestTime: Math.max(...msgs.map((m) => new Date(m.createdAt).getTime())),
    }));
    entries.sort((a, b) => b.latestTime - a.latestTime);
    return entries;
  }, [messages]);

  const filteredGroups = grouped.filter((g) => {
    if (!search) return true;
    const client = clientMap.get(g.clientId);
    const q = search.toLowerCase();
    const isInstructor = g.clientId === INSTRUCTOR_GROUP_ID;
    return (
      (isInstructor && 'instructor'.includes(q)) ||
      client?.name.toLowerCase().includes(q) ||
      client?.phone.includes(q) ||
      g.messages.some((m) => m.body.toLowerCase().includes(q))
    );
  });

  const selectedThread = selectedClientId
    ? grouped.find((g) => g.clientId === selectedClientId)?.messages ?? []
    : [];

  const selectedClient = selectedClientId
    ? clientMap.get(selectedClientId)
    : null;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Client list sidebar — hidden on mobile when conversation selected */}
      <div className={`flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm w-full md:w-80 md:shrink-0 ${
        selectedClientId ? 'hidden md:flex' : 'flex'
      }`}>
        <div className="border-b border-gray-100 p-4">
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
              placeholder="Search messages..."
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {msgsLoading ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading...</div>
          ) : filteredGroups.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">No messages.</div>
          ) : (
            filteredGroups.map((g) => {
              const client = clientMap.get(g.clientId);
              const isInstructor = g.clientId === INSTRUCTOR_GROUP_ID;
              const lastMsg = g.messages[g.messages.length - 1];
              const isActive = selectedClientId === g.clientId;
              return (
                <button
                  key={g.clientId}
                  onClick={() => setSelectedClientId(g.clientId)}
                  className={`w-full px-4 py-3 text-left transition-colors ${
                    isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800">
                      {isInstructor ? 'Instructor (You)' : client?.name ?? `Client #${g.clientId}`}
                    </span>
                    <span className="text-xs text-gray-400">
                      {format(parseISO(lastMsg.createdAt), 'MMM d')}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {lastMsg.direction === 'outbound' ? 'You: ' : ''}
                    {lastMsg.body}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Chat thread — hidden on mobile when no conversation selected */}
      <div className={`flex flex-1 flex-col rounded-xl border border-gray-200 bg-white shadow-sm ${
        selectedClientId ? 'flex' : 'hidden md:flex'
      }`}>
        {selectedClientId ? (
          <>
            <div className="border-b border-gray-100 px-4 py-3 sm:px-6 sm:py-4 flex items-center gap-3">
              <button
                onClick={() => setSelectedClientId(null)}
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 md:hidden"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h3 className="text-base font-semibold text-gray-800">
                {selectedClientId === INSTRUCTOR_GROUP_ID
                  ? 'Instructor (You)'
                  : selectedClient?.name ?? `Client #${selectedClientId}`}
              </h3>
              {selectedClientId !== INSTRUCTOR_GROUP_ID && selectedClient?.phone && (
                <p className="text-xs text-gray-500">{selectedClient.phone}</p>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                {selectedThread.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.direction === 'outbound' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                        msg.direction === 'outbound'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-semibold ${
                            msg.direction === 'outbound'
                              ? 'text-indigo-200'
                              : 'text-gray-500'
                          }`}
                        >
                          {msg.direction === 'outbound'
                            ? (msg.senderType === 'ai' ? 'GymFlow AI' : 'You')
                            : (selectedClientId === INSTRUCTOR_GROUP_ID ? 'You' : selectedClient?.name ?? 'Client')}
                        </span>
                        <span
                          className={`text-xs ${
                            msg.direction === 'outbound'
                              ? 'text-indigo-300'
                              : 'text-gray-400'
                          }`}
                        >
                          {format(parseISO(msg.createdAt), 'MMM d, h:mm a')}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
            Select a conversation to view messages.
          </div>
        )}
      </div>
    </div>
  );
}
