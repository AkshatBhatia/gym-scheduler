import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { getDashboardSummary, getTodayAppointments } from '../api';
import StatusBadge from '../components/StatusBadge';

export default function Dashboard() {
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: getDashboardSummary,
  });

  const { data: todayAppts, isLoading: apptsLoading } = useQuery({
    queryKey: ['today-appointments'],
    queryFn: getTodayAppointments,
  });

  return (
    <div className="space-y-6 min-w-0">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          title="Today's Sessions"
          value={summary?.todayAppointments ?? '-'}
          color="indigo"
          loading={summaryLoading}
        />
        <SummaryCard
          title="Total Clients"
          value={summary?.totalClients ?? '-'}
          color="emerald"
          loading={summaryLoading}
        />
        <SummaryCard
          title="This Week"
          value={summary?.weekSessions ?? '-'}
          color="violet"
          loading={summaryLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Today's Schedule */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="text-base font-semibold text-gray-800">Today's Schedule</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {apptsLoading ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                Loading...
              </div>
            ) : todayAppts && todayAppts.length > 0 ? (
              todayAppts.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center justify-between px-6 py-3"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-gray-500">
                      {format(parseISO(appt.startTime), 'h:mm a')}
                    </span>
                    <span className="text-sm font-medium text-gray-800">
                      {appt.clientName ?? `Client #${appt.clientId}`}
                    </span>
                  </div>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            ) : (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                No sessions scheduled for today.
              </div>
            )}
          </div>
          <div className="border-t border-gray-100 px-6 py-3">
            <Link
              to="/schedule"
              className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
            >
              View full schedule &rarr;
            </Link>
          </div>
        </div>

        {/* Low Balance Alerts */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="text-base font-semibold text-gray-800">Low Balance Alerts</h2>
            <p className="text-xs text-gray-500">Clients with 2 or fewer sessions remaining</p>
          </div>
          <div className="divide-y divide-gray-100">
            {summaryLoading ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                Loading...
              </div>
            ) : summary?.lowBalanceClients && summary.lowBalanceClients.length > 0 ? (
              summary.lowBalanceClients.map((client) => (
                <div
                  key={client.id}
                  className="flex items-center justify-between px-6 py-3"
                >
                  <div>
                    <Link
                      to={`/clients/${client.id}`}
                      className="text-sm font-medium text-gray-800 hover:text-indigo-600"
                    >
                      {client.name}
                    </Link>
                    <p className="text-xs text-gray-500">{client.packageType}</p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      client.sessionsRemaining === 0
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {client.sessionsRemaining} left
                  </span>
                </div>
              ))
            ) : (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                All clients have sufficient sessions.
              </div>
            )}
          </div>
          <div className="border-t border-gray-100 px-6 py-3">
            <Link
              to="/clients"
              className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
            >
              View all clients &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  color,
  loading,
}: {
  title: string;
  value: string | number;
  color: 'indigo' | 'emerald' | 'violet';
  loading: boolean;
}) {
  const colors = {
    indigo: 'from-indigo-500 to-indigo-600',
    emerald: 'from-emerald-500 to-emerald-600',
    violet: 'from-violet-500 to-violet-600',
  };

  return (
    <div
      className={`rounded-xl bg-gradient-to-br ${colors[color]} p-6 text-white shadow-md`}
    >
      <p className="text-sm font-medium text-white/80">{title}</p>
      <p className="mt-2 text-3xl font-bold">
        {loading ? (
          <span className="inline-block h-8 w-16 animate-pulse rounded bg-white/20" />
        ) : (
          value
        )}
      </p>
    </div>
  );
}
