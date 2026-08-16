// Mirrors backend/src/services/*.ts response shapes. Duplicated by hand
// rather than shared from a common package -- frontend and backend are
// separate npm packages with no shared-package setup yet; revisit only if
// keeping these two in sync by hand actually becomes painful.

export interface Team {
  id: number;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
}

export interface Prediction {
  modelVersion: string;
  probHomeWin: number;
  probDraw: number;
  probAwayWin: number;
  predictedHomeGoals: number | null;
  predictedAwayGoals: number | null;
}

export interface ScorerPrediction {
  playerId: number;
  playerName: string;
  playerPhotoUrl: string | null;
  teamId: number;
  expectedGoals: number;
  probScores: number;
}

export interface NextMatch {
  fixtureId: number;
  kickoffAt: string;
  status: string;
  round: string | null;
  competitionName: string;
  homeTeam: { id: number; name: string; logoUrl: string | null };
  awayTeam: { id: number; name: string; logoUrl: string | null };
  prediction: Prediction | null;
}

export interface FixtureSummary {
  id: number;
  kickoffAt: string;
  status: string;
  round: string | null;
  homeScore: number | null;
  awayScore: number | null;
  competitionName: string;
  seasonLabel: string;
  homeTeam: { id: number; name: string; logoUrl: string | null };
  awayTeam: { id: number; name: string; logoUrl: string | null };
  prediction: Prediction | null;
  topScorers: ScorerPrediction[];
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
  photoUrl: string | null;
}

export interface TeamFormMatch {
  fixtureId: number;
  kickoffDate: string;
  competitionName: string;
  opponent: { id: number; name: string; logoUrl: string | null };
  isHome: boolean;
  goalsFor: number;
  goalsAgainst: number;
  result: 'W' | 'D' | 'L';
}

export interface TeamForm {
  matches: TeamFormMatch[];
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

export interface TeamDashboard {
  team: Team;
  nextMatch?: NextMatch;
  tablePosition?: TablePosition;
  form: TeamForm;
  squad: SquadPlayer[];
}

export interface PlayerFormSummary {
  matches: number;
  goals: number;
  assists: number;
  minutesPlayed: number;
  avgRating: number | null;
}

export interface PlayerSeasonStats extends PlayerFormSummary {
  seasonLabel: string;
  yellowCards: number;
  redCards: number;
}

export interface PlayerGameLogEntry {
  fixtureId: number;
  kickoffAt: string;
  competitionName: string;
  seasonLabel: string;
  isHome: boolean;
  opponent: { id: number; name: string; logoUrl: string | null };
  homeScore: number | null;
  awayScore: number | null;
  minutesPlayed: number | null;
  goals: number | null;
  assists: number | null;
  rating: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

export interface PlayerDetail {
  id: number;
  fullName: string;
  dateOfBirth: string | null;
  nationality: string | null;
  position: string | null;
  photoUrl: string | null;
  currentTeam: { id: number; name: string; logoUrl: string | null } | null;
  seasonStats: PlayerSeasonStats | null;
  last5Form: PlayerFormSummary | null;
  last30DaysForm: PlayerFormSummary | null;
  gameLog: PlayerGameLogEntry[];
}

export interface MyTeamPlayer {
  playerId: number;
  fplPlayerId: number;
  fullName: string;
  position: string | null;
  photoUrl: string | null;
  team: { id: number; name: string; logoUrl: string | null } | null;
  squadPosition: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarting: boolean;
}

export type BetResult = 'pending' | 'won' | 'lost' | 'void';

export interface BetLeg {
  id: number;
  fixtureId: number;
  market: string;
  selection: string;
  oddsDecimal: number;
  result: BetResult;
  settledAt: string | null;
  fixture: {
    kickoffAt: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    competitionName: string;
    seasonLabel: string;
    homeTeam: { id: number; name: string };
    awayTeam: { id: number; name: string };
  };
  modelProbability: number | null;
}

export interface Bet {
  id: number;
  stake: number;
  placedAt: string;
  legs: BetLeg[];
  isParlay: boolean;
  result: BetResult;
  settledAt: string | null;
  combinedOdds: number;
  yourImpliedProbability: number;
  modelProbability: number | null;
  edge: number | null;
  payout: number | null;
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
