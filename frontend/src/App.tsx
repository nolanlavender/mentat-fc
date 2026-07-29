import { Routes, Route, Navigate } from 'react-router-dom';
import { TeamListPage } from './pages/TeamListPage';
import { TeamDashboardPage } from './pages/TeamDashboardPage';
import './App.css';

function App() {
  return (
    <Routes>
      <Route path="/" element={<TeamListPage />} />
      <Route path="/teams/:id" element={<TeamDashboardPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
