import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { Skeleton } from './components/ui';
import AskAI from './pages/AskAI';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import { RecordDetail, RecordsIndex, RecordsList } from './pages/Records';
import Usage from './pages/Usage';

function Protected() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ padding: 40 }}>
        <Skeleton h={24} w={240} />
      </div>
    );
  }
  return user ? <Layout /> : <Navigate to="/login" replace />;
}

function NotFound() {
  return (
    <div className="card empty">
      <div className="big">🧭</div>
      <h2>Page not found</h2>
      <p style={{ marginTop: 6 }}>
        <Link to="/">Back to the dashboard</Link>
      </p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="ask" element={<AskAI />} />
        <Route path="records" element={<RecordsIndex />} />
        <Route path="records/:type" element={<RecordsList />} />
        <Route path="records/:type/:ref" element={<RecordDetail />} />
        <Route path="usage" element={<Usage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
