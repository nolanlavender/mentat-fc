import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { TeamListPage } from './pages/TeamListPage';
import { TeamDashboardPage } from './pages/TeamDashboardPage';
import { MyTeamPage } from './pages/MyTeamPage';
import { BetsPage } from './pages/BetsPage';
import { LoginPage } from './pages/LoginPage';
import { AuthProvider, useAuth } from './auth/AuthContext';
import './App.css';

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout(): void {
    logout();
    navigate('/login');
  }

  return (
    <header className="site-nav">
      <Link to="/">Teams</Link>
      <Link to="/my-team">My Team</Link>
      <Link to="/bets">Bets</Link>
      <span className="nav-spacer" />
      {user ? (
        <>
          <span className="nav-user">{user.email}</span>
          <button type="button" className="link-button" onClick={handleLogout}>
            Log out
          </button>
        </>
      ) : (
        <Link to="/login">Log in</Link>
      )}
    </header>
  );
}

function App() {
  return (
    <AuthProvider>
      <Nav />
      <Routes>
        <Route path="/" element={<TeamListPage />} />
        <Route path="/teams/:id" element={<TeamDashboardPage />} />
        <Route path="/my-team" element={<MyTeamPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/bets"
          element={
            <RequireAuth>
              <BetsPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
