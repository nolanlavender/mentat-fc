// Mirrors backend/src/services/*.ts response shapes. Duplicated by hand
// rather than shared from a common package -- frontend and backend are
// separate npm packages with no shared-package setup yet; revisit only if
// keeping these two in sync by hand actually becomes painful.

export interface Team {
  id: number;
  name: string;
  shortName: string | null;
}

export interface Prediction {
  modelVersion: string;
  probHomeWin: number;
  probDraw: number;
  probAwayWin: number;
  predictedHomeGoals: number | null;
  predictedAwayGoals: number | null;
}

export interface NextMatch {
  fixtureId: number;
  kickoffAt: string;
  status: string;
  round: string | null;
  competitionName: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  prediction: Prediction | null;
}

export interface TablePosition {
  competitionName: string;
  seasonLabel: string;
  position: number;
  played: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
}

export interface SquadPlayer {
  id: number;
  fullName: string;
  position: string | null;
}

export interface TeamDashboard {
  team: Team;
  nextMatch?: NextMatch;
  tablePosition?: TablePosition;
  squad: SquadPlayer[];
}

export interface MyTeamPlayer {
  playerId: number;
  fplPlayerId: number;
  fullName: string;
  position: string | null;
  team: { id: number; name: string } | null;
  squadPosition: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarting: boolean;
}

export type BetResult = 'pending' | 'won' | 'lost' | 'void';

export interface Bet {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
  stake: number;
  result: BetResult;
  placedAt: string;
  settledAt: string | null;
  fixture: {
    kickoffAt: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    competitionName: string;
    homeTeam: string;
    awayTeam: string;
  };
  yourImpliedProbability: number;
  modelProbability: number | null;
  edge: number | null;
}

export interface BetsRoiSummary {
  totalBets: number;
  pending: number;
  won: number;
  lost: number;
  void: number;
  totalStakedSettled: number;
  totalReturnedSettled: number;
  netProfitSettled: number;
  roiPercent: number | null;
  winRatePercent: number | null;
}

export interface MyTeam {
  entryName: string;
  managerName: string;
  gameweek: number;
  gameweekPoints: number;
  totalPoints: number;
  bank: number;
  squadValue: number;
  activeChip: string | null;
  players: MyTeamPlayer[];
  isPreview: boolean;
}
