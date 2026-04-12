import type {
  Client,
  Appointment,
  AvailabilityRule,
  TimeSlot,
  Message,
  DashboardSummary,
} from './types';

const BASE = '/api';

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Clients ──────────────────────────────────────────────

export function getClients(): Promise<Client[]> {
  return request('/clients');
}

export function getClient(id: number): Promise<Client> {
  return request(`/clients/${id}`);
}

export function createClient(data: Partial<Client>): Promise<Client> {
  return request('/clients', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateClient(id: number, data: Partial<Client>): Promise<Client> {
  return request(`/clients/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── Appointments ─────────────────────────────────────────

interface AppointmentRow {
  appointment: Appointment;
  clientName: string | null;
  clientPhone: string | null;
}

function flattenAppointments(rows: AppointmentRow[]): Appointment[] {
  return rows.map((r) => ({
    ...r.appointment,
    clientName: r.clientName ?? undefined,
  }));
}

export async function getAppointments(): Promise<Appointment[]> {
  const rows = await request<AppointmentRow[]>('/appointments');
  return flattenAppointments(rows);
}

export async function getWeekAppointments(startDate: string): Promise<Appointment[]> {
  const rows = await request<AppointmentRow[]>(`/appointments?week=${startDate}`);
  return flattenAppointments(rows);
}

export async function getTodayAppointments(): Promise<Appointment[]> {
  const rows = await request<AppointmentRow[]>('/appointments/today');
  return flattenAppointments(rows);
}

export function createAppointment(
  data: Partial<Appointment>
): Promise<Appointment> {
  return request('/appointments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateAppointmentStatus(
  id: number,
  status: Appointment['status']
): Promise<Appointment> {
  return request(`/appointments/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

// ── Availability ─────────────────────────────────────────

export function getAvailability(): Promise<AvailabilityRule[]> {
  return request('/availability');
}

export function getAvailableSlots(date: string): Promise<TimeSlot[]> {
  return request(`/availability/slots?date=${date}`);
}

export function createAvailability(
  data: Partial<AvailabilityRule>
): Promise<AvailabilityRule> {
  return request('/availability', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteAvailability(id: number): Promise<void> {
  return request(`/availability/${id}`, { method: 'DELETE' });
}

// ── Messages ─────────────────────────────────────────────

interface MessageRow {
  message: Message;
  clientName: string | null;
}

export async function getMessages(): Promise<Message[]> {
  const rows = await request<MessageRow[]>('/messages');
  return rows.map((r) => ({ ...r.message }));
}

export async function getClientMessages(clientId: number): Promise<Message[]> {
  const rows = await request<MessageRow[]>(`/messages?clientId=${clientId}`);
  return rows.map((r) => ({ ...r.message }));
}

// ── Dashboard ────────────────────────────────────────────

export function getDashboardSummary(): Promise<DashboardSummary> {
  return request('/dashboard/summary');
}
