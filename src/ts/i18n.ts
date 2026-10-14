/* Language dictionary + resolution.
 *
 * The server emits i18n keys (e.g. "language.started"). We resolve them against
 * the loaded dictionary rather than eval()-ing server data. The dictionary keys
 * omit the "language." namespace, so it is stripped before lookup. */

export interface Language {
  title: string;
  create: string;
  join: string;
  newRoomName: string;
  hide: string;
  noTaxFirst: string;
  btnCreate: string;
  titleNickModal: string;
  setNickname: string;
  save: string;
  btnJoin: string;
  info: string;
  howToPlay: string;
  room: string;
  usersOnline: string;
  chooseLang: string;
  roomTitle: string;
  connecting: string;
  cards: string;
  ready: string;
  notReady: string;
  winner: string;
  spect: string;
  pass: string;
  play: string;
  yourTurn: string;
  autoPassIn: string;
  started: string;
  passed: string;
  finished: string;
  ended: string;
  disconnected: string;
  connected: string;
  write: string;
  send: string;
  share: string;
  shareTit: string;
  shareInvite: string;
  close: string;
  players: string;
  wait: string;
  playing: string;
  wrongCard: string;
  cheat: string;
  waitTurn: string;
  noRoom: string;
  roomFull: string;
  swap: string;
  placed: string;
  taxs: [string, string];
  leaderboard: string;
  confirmPass: string;
  authRequired: string;
  badNickname: string;
  badRoomName: string;
  rateLimited: string;
  tooManyRooms: string;
  mustPlay: string;
  noRevolution: string;
  revolution: string;
  greaterRevolution: string;
  revolutionBanner: string;
  greaterRevolutionBanner: string;
  revolutionPrompt: string;
  revolutionPromptGreater: string;
  taxPeonPrompt: string;
  taxDalmutiPrompt: string;
  addBot: string;
  addBotTitle: string;
  botDifficulty: string;
  difficultyEasy: string;
  difficultyMedium: string;
  difficultyHard: string;
  botsTitle: string;
  removeBot: string;
  botLabel: string;
  notHost: string;
  botNotNow: string;
  badBot: string;
  fillBots: string;
  botAdd: string;
  fullscreen: string;
  selectHint: string;
  you: string;
  wonHand: string;
  youWonHand: string;
  taxDue: string;
  taxPaid: string;
  wonTrick: string;
  leadNow: string;
  newTrick: string;
  targetPoints: string;
  targetPointsHint: string;
  sessionScore: string;
  sessionWon: string;
  sessionOver: string;
  resetSession: string;
  sessionReset: string;
}

export type LangCode = "en" | "it" | "bg";
export const LANGS: LangCode[] = ["en", "it", "bg"];

const STORAGE_KEY = "language";

export function currentLang(): LangCode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "it" || saved === "bg" ? saved : "en";
}

export function setLanguage(lang: LangCode): void {
  localStorage.setItem(STORAGE_KEY, lang);
  location.reload();
}

export async function loadLanguage(): Promise<Language> {
  const res = await fetch(`/js/language/${currentLang()}.json`);
  if (!res.ok) throw new Error(`language load failed: ${res.status}`);
  return (await res.json()) as Language;
}

/** Resolve a server i18n key against the dictionary. Falls back to the key. */
export function resolveMessage(lang: Language, key: unknown): string {
  if (typeof key !== "string") return String(key);
  const parts = key.split(".");
  if (parts[0] === "language") parts.shift();
  let value: unknown = lang;
  for (const part of parts) {
    if (value == null || typeof value !== "object") break;
    value = (value as Record<string, unknown>)[part];
  }
  return value != null ? String(value) : key;
}
