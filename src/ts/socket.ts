import type {
  CardSelection,
  ChatConnection,
  LobbyView,
  RevolutionPhase,
  RoomData,
  SenderView,
  TaxPhase,
} from "./types";

/* Typed facade over the Socket.io global served at /socket.io/socket.io.js.
 * We deliberately do not depend on the socket.io-client types at build time;
 * instead the event contracts are declared here and checked end-to-end. */

export interface ServerToClientEvents {
  "refresh game room": (room: RoomData) => void;
  "refresh waiting room": (rooms: LobbyView, userCount: number) => void;
  "update sender": (sender: SenderView) => void;
  connectUrl: (url: string) => void;
  alert: (key: string) => void;
  "chat message": (nickname: string, msg: string, sid: string) => void;
  "chat announce": (key: string, color: string, nickname?: string, nickname1?: string) => void;
  "chat announce taxs": (key: string, color: string, paid: string, received: string) => void;
  "chat connection": (user: ChatConnection) => void;
  "revolution phase": (info: RevolutionPhase) => void;
  "tax phase": (info: TaxPhase) => void;
  "tax owed": (info: { kind: string; count: number; partner: string }) => void;
  "tax result": (info: { role: string; partner: string; sent: string; received: string }) => void;
}

export interface ClientToServerEvents {
  init: () => void;
  reconnect: (token: string) => void;
  "set new nickname": (nickname: string, roomId: string) => void;
  "create game room": (name: string, hide: boolean, noTax: boolean, targetPoints: number) => void;
  "join game room": (name: string) => void;
  "leave room": () => void;
  "chat message": (msg: string) => void;
  ready: () => void;
  play: (selection: CardSelection) => void;
  "declare revolution": () => void;
  tax: (selection: CardSelection) => void;
  "add bot": (difficulty: string) => void;
  "fill bots": (difficulty: string) => void;
  "remove bot": (sid: string) => void;
  "reset session": () => void;
}

export interface TypedSocket {
  readonly id: string;
  emit<K extends keyof ClientToServerEvents>(
    event: K,
    ...args: Parameters<ClientToServerEvents[K]>
  ): void;
  on<K extends keyof ServerToClientEvents>(event: K, handler: ServerToClientEvents[K]): void;
  off<K extends keyof ServerToClientEvents>(event: K, handler?: ServerToClientEvents[K]): void;
}

declare const io: () => unknown;

export function connect(): TypedSocket {
  return io() as TypedSocket;
}
