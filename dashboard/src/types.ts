export interface Client {
  id: number;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  packageType: string;
  sessionsRemaining: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Appointment {
  id: number;
  clientId: number;
  clientName?: string;
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'cancelled' | 'no-show' | 'completed';
  recurringScheduleId?: number | null;
  notes?: string;
  createdAt: string;
}

export interface AvailabilityRule {
  id: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isBlocked: boolean;
  overrideDate?: string;
}

export interface TimeSlot {
  startTime: string;
  endTime: string;
  available: boolean;
}

export interface Message {
  id: number;
  clientId?: number;
  direction: 'inbound' | 'outbound';
  channel: string;
  senderType: string;
  body: string;
  createdAt: string;
}

export interface DashboardSummary {
  todayAppointments: number;
  totalClients: number;
  weekSessions: number;
  lowBalanceClients: Client[];
}
