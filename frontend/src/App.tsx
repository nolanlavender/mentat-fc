import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { HomePage } from './pages/HomePage';
import { TeamDashboardPage } from './pages/TeamDashboardPage';
import { PlayerPage } from './pages/PlayerPage';
import { MyTeamPage } from './pages/MyTeamPage';
import { BetsPage } from './pages/BetsPage';
import { PredictionsPage } from './pages/PredictionsPage';
import { LoginPage } from './pages/LoginPage';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TeamsNavDropdown } from './components/TeamsNavDropdown';
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
      <Link to="/" className="nav-brand">
        Mentat FC
      </Link>
      <TeamsNavDropdown />
      <Link to="/my-team">My Team</Link>
      <Link to="/predictions">Predictions</Link>
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
        <Route path="/" element={<HomePage />} />
        <Route path="/teams/:id" element={<TeamDashboardPage />} />
        <Route path="/players/:id" element={<PlayerPage />} />
        <Route
          path="/my-team"
          element={
            <RequireAuth>
              <MyTeamPage />
            </RequireAuth>
          }
        />
        <Route path="/predictions" element={<PredictionsPage />} />
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
