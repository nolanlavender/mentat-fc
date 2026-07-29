import { pool } from '../db/pool.js';

export interface Player {
  id: number;
  fullName: string;
  dateOfBirth: string | null;
  nationality: string | null;
  position: string | null;
  currentTeam: { id: number; name: string } | null;
}

const MAX_LIMIT = 200;

export async function listPlayers(filters: { teamId?: number; limit?: number }): Promise<Player[]> {
  const limit = Math.min(filters.limit ?? 50, MAX_LIMIT);

  const { rows } = await pool.query(
    `SELECT p.id, p.full_name, p.date_of_birth, p.nationality, p.position,
       t.id AS team_id, t.name AS team_name
     FROM players p
     LEFT JOIN teams t ON t.id = p.current_team_id
     WHERE ($1::int IS NULL OR p.current_team_id = $1)
     ORDER BY p.full_name
     LIMIT $2`,
    [filters.teamId ?? null, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    dateOfBirth: r.date_of_birth,
    nationality: r.nationality,
    position: r.position,
    currentTeam: r.team_id ? { id: r.team_id, name: r.team_name } : null,
  }));
}

export async function getPlayerById(id: number): Promise<Player | undefined> {
  const { rows } = await pool.query(
    `SELECT p.id, p.full_name, p.date_of_birth, p.nationality, p.position,
       t.id AS team_id, t.name AS team_name
     FROM players p
     LEFT JOIN teams t ON t.id = p.current_team_id
     WHERE p.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return undefined;

  return {
    id: r.id,
    fullName: r.full_name,
    dateOfBirth: r.date_of_birth,
    nationality: r.nationality,
    position: r.position,
    currentTeam: r.team_id ? { id: r.team_id, name: r.team_name } : null,
  };
}
