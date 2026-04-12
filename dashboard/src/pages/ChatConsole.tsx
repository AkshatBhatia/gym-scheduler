import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getClients } from '../api';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  sender: string;
  body: string;
  timestamp: string;
}

const INSTRUCTOR_PHONE_FALLBACK = '+15129250165';
const STORAGE_KEY = 'gymflow-chat-console';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getChatKey(senderType: string, selectedClientId: number | null, unknownPhone: string): string {
  if (senderType === 'instructor') return `${STORAGE_KEY}-chat-instructor`;
  if (senderType === 'client' && selectedClientId) return `${STORAGE_KEY}-chat-client-${selectedClientId}`;
  return `${STORAGE_KEY}-chat-unknown-${unknownPhone}`;
}

export default function ChatConsole() {
  const [senderType, setSenderType] = useState<'instructor' | 'client' | 'unknown'>(
    () => loadJson(`${STORAGE_KEY}-senderType`, 'instructor')
  );
  const [selectedClientId, setSelectedClientId] = useState<number | null>(
    () => loadJson(`${STORAGE_KEY}-selectedClientId`, null)
  );
  const [unknownPhone, setUnknownPhone] = useState(
    () => loadJson(`${STORAGE_KEY}-unknownPhone`, '+15559999999')
  );

  const chatKey = getChatKey(senderType, selectedClientId, unknownPhone);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadJson(chatKey, []));
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(loadJson<number>(`${STORAGE_KEY}-nextId`, 0));

  // When channel changes, load that channel's messages
  useEffect(() => {
    const key = getChatKey(senderType, selectedClientId, unknownPhone);
    setMessages(loadJson(key, []));
  }, [senderType, selectedClientId, unknownPhone]);

  // Save messages whenever they change
  useEffect(() => {
    sessionStorage.setItem(chatKey, JSON.stringify(messages));
  }, [messages, chatKey]);

  // Persist selector state
  useEffect(() => {
    sessionStorage.setItem(`${STORAGE_KEY}-senderType`, JSON.stringify(senderType));
  }, [senderType]);
  useEffect(() => {
    sessionStorage.setItem(`${STORAGE_KEY}-selectedClientId`, JSON.stringify(selectedClientId));
  }, [selectedClientId]);
  useEffect(() => {
    sessionStorage.setItem(`${STORAGE_KEY}-unknownPhone`, JSON.stringify(unknownPhone));
  }, [unknownPhone]);
  // nextId is saved after each message send, not on every render
  useEffect(() => {
    sessionStorage.setItem(`${STORAGE_KEY}-nextId`, JSON.stringify(nextId.current));
  }, [messages]); // only when messages change (which means nextId changed)

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
  });

  const { data: instructorPhone } = useQuery({
    queryKey: ['instructor-phone'],
    queryFn: async () => {
      const res = await fetch('/api/settings/instructor-phone');
      const data = await res.json();
      return data.phone as string;
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function getFromPhone(): string {
    if (senderType === 'instructor') return instructorPhone || INSTRUCTOR_PHONE_FALLBACK;
    if (senderType === 'client' && selectedClientId) {
      const client = clients.find((c) => c.id === selectedClientId);
      return client?.phone || '+15550000000';
    }
    return unknownPhone;
  }

  function getSenderLabel(): string {
    if (senderType === 'instructor') return 'Instructor';
    if (senderType === 'client' && selectedClientId) {
      const client = clients.find((c) => c.id === selectedClientId);
      return client?.name || 'Client';
    }
    return `Unknown (${unknownPhone})`;
  }

  const clearChat = useCallback(() => {
    setMessages([]);
    sessionStorage.removeItem(chatKey);
  }, [chatKey]);

  function clearAllChats() {
    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(STORAGE_KEY));
    keys.forEach((k) => sessionStorage.removeItem(k));
    setMessages([]);
    nextId.current = 0;
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: nextId.current++,
      role: 'user',
      sender: getSenderLabel(),
      body: input.trim(),
      timestamp: new Date().toLocaleTimeString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const fromPhone = getFromPhone();
      const params = new URLSearchParams({
        From: fromPhone,
        Body: input.trim(),
        To: '+15550001111',
      });

      const res = await fetch('/api/sms/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const xml = await res.text();
      const match = xml.match(/<Message>([\s\S]*?)<\/Message>/);
      const responseBody = match
        ? match[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
        : 'No response';

      const aiMsg: ChatMessage = {
        id: nextId.current++,
        role: 'assistant',
        sender: 'GymFlow AI',
        body: responseBody,
        timestamp: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: nextId.current++,
        role: 'assistant',
        sender: 'System',
        body: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      {/* Sender selector */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <span className="text-sm font-medium text-gray-600">Send as:</span>
        <div className="flex gap-1">
          {(['instructor', 'client', 'unknown'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setSenderType(type)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                senderType === type
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        {senderType === 'client' && (
          <select
            value={selectedClientId ?? ''}
            onChange={(e) => setSelectedClientId(Number(e.target.value) || null)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="">Select client...</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.phone})
              </option>
            ))}
          </select>
        )}

        {senderType === 'unknown' && (
          <input
            type="text"
            value={unknownPhone}
            onChange={(e) => setUnknownPhone(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm w-40"
            placeholder="Phone number"
          />
        )}

        <div className="ml-auto flex gap-2">
          <button
            onClick={clearChat}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
          >
            Clear this chat
          </button>
          <button
            onClick={clearAllChats}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="p-4 space-y-3">
          {messages.length === 0 && (
            <div className="py-12 text-center text-sm text-gray-400">
              <p className="text-base font-medium text-gray-500 mb-2">SMS Test Console</p>
              <p>Simulate text messages to the AI assistant.</p>
              <p className="mt-4 text-xs">
                {senderType === 'instructor' && (
                  <>Try: "Who do I have tomorrow?", "Schedule Mike for Tuesday at 3pm", "How many sessions does Emily have?"</>
                )}
                {senderType === 'client' && (
                  <>Try: "yes", "can't make it", "can we reschedule to Friday?"</>
                )}
                {senderType === 'unknown' && (
                  <>Try: "I'd like to book a session", "What times are available this week?"</>
                )}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-xs font-semibold ${
                      msg.role === 'user' ? 'text-indigo-200' : 'text-gray-500'
                    }`}
                  >
                    {msg.sender}
                  </span>
                  <span
                    className={`text-xs ${
                      msg.role === 'user' ? 'text-indigo-300' : 'text-gray-400'
                    }`}
                  >
                    {msg.timestamp}
                  </span>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.body}</p>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-gray-100 px-4 py-3">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce" />
                  <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0.1s]" />
                  <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0.2s]" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          placeholder={
            senderType === 'instructor'
              ? 'Ask the AI assistant...'
              : senderType === 'client'
              ? 'Reply as client...'
              : 'Text as a new person...'
          }
          disabled={loading || (senderType === 'client' && !selectedClientId)}
          className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50"
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim() || (senderType === 'client' && !selectedClientId)}
          className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-medium text-white shadow hover:bg-indigo-700 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
