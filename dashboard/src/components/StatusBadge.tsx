import type { Appointment } from '../types';

const COLORS: Record<Appointment['status'], string> = {
  confirmed: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700 line-through',
  'no-show': 'bg-orange-100 text-orange-700',
};

interface StatusBadgeProps {
  status: Appointment['status'];
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${COLORS[status]}`}
    >
      {status}
    </span>
  );
}
