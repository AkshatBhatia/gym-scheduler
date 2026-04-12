import { useState, useCallback } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Schedule from './pages/Schedule';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import Availability from './pages/Availability';
import Messages from './pages/Messages';
import ChatConsole from './pages/ChatConsole';
import Login from './pages/Login';
import Profile from './pages/Profile';

export default function App() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem('token')
  );

  const handleLogin = useCallback((newToken: string) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
  }, []);

  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/availability" element={<Availability />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/console" element={<ChatConsole />} />
        <Route path="/profile" element={<Profile onLogout={handleLogout} />} />
      </Route>
    </Routes>
  );
}
