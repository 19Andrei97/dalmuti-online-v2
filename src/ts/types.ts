/* Shared types for the client. These mirror the payloads emitted by
 * server/room-manager.js (see roomView / senderView / playerView / lobbyView). */

/** A card is an integer 1..13. Rank === count in the deck; 13 is the Joker. */
export type CardValue = number;
export const JOKER: CardValue = 13;

/** A play/tax selection: card value -> how many of it. */
export type CardSelection = Record<number, number>;

/** Mirrors `game_state` in server/config.js. */
export enum GameState {
  WAITING = 0,
  PLAYING = 1,
  TAXATION = 2,
}

export type Role =
  | "greaterDalmuti"
  | "lesserDalmuti"
  | "merchant"
  | "lesserPeon"
  | "greaterPeon";

export interface PlayerView {
  nickname: string;
  seat: number;
  ready: boolean;
  spectator: boolean;
  connected: boolean;
  points: number;
  handCount: number;
  isBot: boolean;
  difficulty: string | null;
  role: Role | null;
}

export interface LastPlay {
  num: CardValue;
  count: number;
  by: string;
  handCount?: number;
  /** Exact cards of the play (Jokers kept as 13) so the table shows a Joker. */
  cards?: CardValue[];
}

export interface TaxPhase {
  kind: string;
  role: "peon" | "dalmuti";
  count: number;
  partner: string;
  deadline: number;
}

export interface RevolutionPhase {
  greater: boolean;
  deadline: number;
}

export type Phase =
  | { type: "tax"; deadline: number; taxes: unknown[]; submissions: Record<string, unknown> }
  | { type: "revolution"; greater: boolean; deadline: number }
  | null;

export interface LeaderBoardRow {
  sid: string;
  nickname: string;
  points: number;
  role: Role | null;
}

/** The per-recipient room snapshot (`refresh game room`). */
export interface RoomData {
  name: string;
  hide: boolean;
  you: string;
  seats: boolean[];
  players: Record<string, PlayerView>;
  hand: CardValue[];
  state: GameState;
  round: number;
  cur_order_idx: number;
  order: string[] | null;
  last: LastPlay | null;
  /** Display copy of the table that survives a completed trick (see renderField). */
  shown: LastPlay | null;
  roles: Record<string, Role> | null;
  socialOrder: string[] | null;
  leaderBoard: LeaderBoardRow[] | null;
  phase: Phase;
  host: string | null;
  canAddBot: boolean;
}

export interface SenderView {
  nickname: string;
  cur_room: string;
  seat: number;
  ready: boolean;
  spectator: boolean;
  token?: string;
}

export interface LobbyRoom {
  name: string;
  players: number;
  capacity: number;
  state: GameState;
}

export type LobbyView = Record<string, LobbyRoom>;

export interface ChatConnection {
  nickname: string;
  seat: number;
  spectator: boolean;
  connected: boolean;
}

export interface AuthInfo {
  authEnabled: boolean;
  username?: string | null;
  id?: number;
  error?: string;
}

export type BotDifficulty = "easy" | "medium" | "hard";
