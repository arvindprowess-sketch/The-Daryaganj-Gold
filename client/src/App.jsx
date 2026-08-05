import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { Spinner } from './components/ui.jsx';
import PendingBanner from './components/PendingBanner.jsx';

import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';

// Auditor (mobile) flow
import StoreSelect from './pages/auditor/StoreSelect.jsx';
import AuditSession from './pages/auditor/AuditSession.jsx';
import SuperCategoryList from './pages/auditor/SuperCategoryList.jsx';
import ItemList from './pages/auditor/ItemList.jsx';
import Submit from './pages/auditor/Submit.jsx';

// Admin (desktop) flow
import AdminLayout from './pages/admin/AdminLayout.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import ItemMaster from './pages/admin/ItemMaster.jsx';
import StoresUsers from './pages/admin/StoresUsers.jsx';
import AuditSessions from './pages/admin/AuditSessions.jsx';
import CountEntry from './pages/admin/CountEntry.jsx';
import SystemStock from './pages/admin/SystemStock.jsx';
import Settings from './pages/admin/Settings.jsx';
import Reports from './pages/admin/Reports.jsx';
import DataManagement from './pages/admin/DataManagement.jsx';
import Readiness from './pages/admin/Readiness.jsx';
import PhotoReview from './pages/admin/PhotoReview.jsx';

function RequireRole({ role, children }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  // Wait for auth to finish loading before deciding — guarding early was one
  // cause of spurious redirects to /login.
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  // A seeded account still carries a password that was printed to a console.
  // It cannot use the app — on any route — until that password is replaced.
  if (user.must_change_password) return <ChangePassword forced />;
  if (role && user.role !== role) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/a'} replace />;
  }
  return children;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'admin' ? '/admin' : '/a'} replace />;
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />

        {/* ── Auditor (mobile-first) ── */}
        <Route path="/a" element={<RequireRole role="auditor"><StoreSelect /></RequireRole>} />
        <Route path="/a/store/:storeId" element={<RequireRole role="auditor"><AuditSession /></RequireRole>} />
        <Route path="/a/audit/:auditId" element={<RequireRole role="auditor"><SuperCategoryList /></RequireRole>} />
        <Route path="/a/audit/:auditId/super-category/:superCategoryId" element={<RequireRole role="auditor"><ItemList /></RequireRole>} />
        <Route path="/a/audit/:auditId/submit" element={<RequireRole role="auditor"><Submit /></RequireRole>} />

        {/* ── Admin (desktop) ── */}
        <Route path="/admin" element={<RequireRole role="admin"><AdminLayout /></RequireRole>}>
          <Route index element={<Dashboard />} />
          <Route path="items" element={<ItemMaster />} />
          <Route path="photo-review" element={<PhotoReview />} />
          <Route path="stores-users" element={<StoresUsers />} />
          <Route path="audits" element={<AuditSessions />} />
          <Route path="audits/:auditId/count" element={<CountEntry />} />
          <Route path="audits/:auditId/system-stock" element={<SystemStock />} />
          <Route path="settings" element={<Settings />} />
          <Route path="reports" element={<Reports />} />
          <Route path="data" element={<DataManagement />} />
          <Route path="readiness" element={<Readiness />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <PendingBanner />
    </>
  );
}
