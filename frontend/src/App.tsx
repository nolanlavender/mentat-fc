import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { TeamListPage } from './pages/TeamListPage';
import { TeamDashboardPage } from './pages/TeamDashboardPage';
import { MyTeamPage } from './pages/MyTeamPage';
import './App.css';

function App() {
  return (
    <>
      <header className="site-nav">
        <Link to="/">Teams</Link>
        <Link to="/my-team">My Team</Link>
      </header>
      <Routes>
        <Route path="/" element={<TeamListPage />} />
        <Route path="/teams/:id" element={<TeamDashboardPage />} />
        <Route path="/my-team" element={<MyTeamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default App;
