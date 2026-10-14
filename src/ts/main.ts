/* The Great Dalmuti - typed client controller (lobby + game room). */
import {
  byId,
  clear,
  closeDialog,
  el,
  maybeById,
  openDialog,
  qsa,
  setText,
  show,
} from "./dom";
import { loadLanguage, resolveMessage, type Language } from "./i18n";
import { applyLanguageUI, wireLanguageMenu } from "./lang-menu";
import { connect, type TypedSocket } from "./socket";
import { SelectionModel } from "./selection";
import { classifyMove, fieldCount, hasLegalPlay, playableRanks } from "./client-rules";
import { GameState, JOKER, type AuthInfo, type LobbyView, type PlayerView, type RoomData, type Role } from "./types";

// Must match the server's autoPassDelayMs so the visible countdown lines up.
const AUTO_PASS_MS = 5000;

const CARD_CLASS: readonly string[] = [
  "dalmuti",
  "archbishop",
  "marshal",
  "baroness",
  "abbess",
  "knight",
  "seamstress",
  "mason",
  "cook",
  "shepherdess",
  "stonecutter",
  "peasant",
  "jolly",
];

interface Session {
  socket: TypedSocket;
  lang: Language;
  room: RoomData | null;
  authEnabled: boolean;
  currentUser: { username: string } | null;
  selection: SelectionModel;
  taxSelection: SelectionModel;
  lastPlayedKey: string | null;
  fieldCardsKey: string | null;
  handKey: string | null;
  taxKey: string | null;
  autoPassKey: string | null;
  autoPassTimer: number | null;
  autoPassEnds: number;
}

function cardClass(value: number): string {
  return CARD_CLASS[value - 1] ?? "peasant";
}

function currentRoomId(): string {
  const parts = location.pathname.split("/");
  return parts[parts.length - 1] ?? "";
}

function rankLabel(value: number): string {
  return value === JOKER ? "Joker" : `Card ${value}`;
}

async function boot(): Promise<void> {
  const lang = await loadLanguage().catch(() => null);
  if (!lang) return;

  const session: Session = {
    socket: connect(),
    lang,
    room: null,
    authEnabled: false,
    currentUser: null,
    selection: new SelectionModel(),
    taxSelection: new SelectionModel(),
    lastPlayedKey: null,
    fieldCardsKey: null,
    handKey: null,
    taxKey: null,
    autoPassKey: null,
    autoPassTimer: null,
    autoPassEnds: 0,
  };

  applyStaticTranslations(lang);
  wireSharedChrome(session);
  wireLobby(session);
  wireRoom(session);
  wireServerEvents(session);

  // Resume a dropped session (seat + hand) before anything else.
  const reconnectToken = localStorage.getItem("reconnectToken");
  if (reconnectToken) session.socket.emit("reconnect", reconnectToken);
  session.socket.emit("init");

  await initAuth(session);
}

/* ---- static translations ---------------------------------------------- */

function applyStaticTranslations(lang: Language): void {
  const map: Record<string, string> = {
    "btn-create-room": lang.create,
    "btn-join-room": lang.join,
    "create-room-title": lang.create,
    "join-room-title": lang.join,
    "new-room-name-label": lang.newRoomName,
    "join-room-label": lang.newRoomName,
    "hide-label": lang.hide,
    "no-tax-label": lang.noTaxFirst,
    "target-points-label": lang.targetPoints,
    "target-points-hint": lang.targetPointsHint,
    "reset-session-btn": lang.resetSession,
    "create-room-confirm": lang.btnCreate,
    "nickname-title": lang.titleNickModal,
    "nickname-label": lang.setNickname,
    "nickname-save": lang.save,
    "join-room-confirm": lang.btnJoin,
    info: lang.info,
    "how-to-play": lang.howToPlay,
    "play-btn": lang.pass,
    "ready-btn": lang.ready,
    "add-bot-btn": lang.addBot,
    "share-title": lang.shareTit,
    "share-label": lang.shareInvite,
    "share-close": lang.close,
    "leaderboard-title": lang.leaderboard,
    "add-bot-title": lang.addBotTitle,
    "bot-difficulty-label": lang.botDifficulty,
    "add-bot-confirm": lang.botAdd,
    "fill-bots": lang.fillBots,
    "select-hint": lang.selectHint,
    "revolution-text": lang.revolutionPrompt,
  };
  for (const [id, value] of Object.entries(map)) setText(maybeById(id) ?? document.createElement("span"), value);

  // Icon buttons carry SVG, so their label is a tooltip/aria-label, not text.
  for (const [id, label] of [["share-btn", lang.share], ["fullscreen-btn", lang.fullscreen]] as const) {
    const btn = maybeById(id);
    if (btn) {
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
  }

  const input = maybeById<HTMLInputElement>("message-input");
  if (input) input.placeholder = lang.write;
  setText(maybeById("send-chat") ?? document.createElement("span"), lang.send);

  const difficulty: Record<string, string> = {
    easy: lang.difficultyEasy,
    medium: lang.difficultyMedium,
    hard: lang.difficultyHard,
  };
  for (const option of qsa<HTMLOptionElement>("#bot-difficulty option")) {
    const key = option.value;
    if (difficulty[key]) option.textContent = difficulty[key];
  }

  applyLanguageUI();
}

/* ---- shared chrome (toast, fullscreen, nickname dialog) ---------------- */

function toast(message: string): void {
  const box = maybeById("toast");
  const text = maybeById("toast-message");
  if (!box || !text) return;
  text.textContent = message;
  show(box, true);
  window.clearTimeout(Number(box.dataset.timer ?? "0"));
  const timer = window.setTimeout(() => show(box, false), 3200);
  box.dataset.timer = String(timer);
}

function wireSharedChrome(session: Session): void {
  const fs = maybeById("fullscreen-btn");
  fs?.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  });

  const nickname = maybeById("nickname");
  nickname?.addEventListener("click", () => {
    const dlg = maybeById<HTMLDialogElement>("dlg-nickname");
    if (!dlg) return;
    if (session.authEnabled && session.currentUser) {
      const input = maybeById<HTMLInputElement>("nickname-input");
      if (input) input.value = session.currentUser.username;
    }
    openDialog(dlg);
  });

  wireLanguageMenu();

  const chatToggle = maybeById("chat-toggle");
  const chatPanel = maybeById("chat-panel");
  chatToggle?.addEventListener("click", () => {
    chatPanel?.classList.toggle("chat-open");
  });
  maybeById("chat-close")?.addEventListener("click", () => {
    chatPanel?.classList.remove("chat-open");
  });

  const send = maybeById("send-chat");
  const input = maybeById<HTMLInputElement>("message-input");
  send?.addEventListener("click", () => sendChat(session));
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      sendChat(session);
    }
  });

  for (const dialog of qsa<HTMLDialogElement>("dialog.modal")) {
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) closeDialog(dialog);
    });
  }
}

function sendChat(session: Session): void {
  const input = maybeById<HTMLInputElement>("message-input");
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  session.socket.emit("chat message", value);
  input.value = "";
}

/* ---- auth -------------------------------------------------------------- */

async function initAuth(session: Session): Promise<void> {
  let data: AuthInfo;
  try {
    const res = await fetch("/api/me");
    data = (await res.json()) as AuthInfo;
  } catch {
    data = { authEnabled: false };
  }

  session.authEnabled = !!data.authEnabled;
  session.currentUser = data.authEnabled && data.username ? { username: data.username } : null;

  if (session.authEnabled) {
    if (session.currentUser) {
      displayNickname(session.currentUser.username);
      session.socket.emit("set new nickname", session.currentUser.username, currentRoomId());
    } else if (location.pathname !== "/login") {
      location.href = "/login";
    }
    return;
  }

  const saved = localStorage.getItem("nickname");
  if (saved) {
    displayNickname(saved);
    session.socket.emit("set new nickname", saved, currentRoomId());
  }
}

function displayNickname(name: string): void {
  const node = maybeById("nickname");
  if (node) node.textContent = name;
}

/* ---- lobby ------------------------------------------------------------- */

function wireLobby(session: Session): void {
  maybeById("btn-create-room")?.addEventListener("click", () => {
    openDialog(byId<HTMLDialogElement>("dlg-create"));
  });
  maybeById("btn-join-room")?.addEventListener("click", () => {
    openDialog(byId<HTMLDialogElement>("dlg-join"));
  });
  maybeById("dlg-create-close")?.addEventListener("click", () => closeDialog(byId("dlg-create")));
  maybeById("dlg-join-close")?.addEventListener("click", () => closeDialog(byId("dlg-join")));
  maybeById("dlg-nickname-close")?.addEventListener("click", () => closeDialog(byId("dlg-nickname")));

  maybeById("create-room-confirm")?.addEventListener("click", () => submitCreateRoom(session));

  // Enter in the name field submits, and an empty name is fine: we generate one.
  const nameField = maybeById<HTMLInputElement>("new-room-name");
  nameField?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submitCreateRoom(session);
    }
  });

  maybeById("join-room-confirm")?.addEventListener("click", () => {
    const name = maybeById<HTMLInputElement>("join-room-input")?.value.trim() ?? "";
    if (!name) {
      toast("Please enter a room name.");
      return;
    }
    clearChat();
    showLoading(session);
    session.socket.emit("join game room", name);
    const field = maybeById<HTMLInputElement>("join-room-input");
    if (field) field.value = "";
    closeDialog(byId("dlg-join"));
  });

  maybeById("nickname-save")?.addEventListener("click", () => {
    const typed = maybeById<HTMLInputElement>("nickname-input")?.value.trim() ?? "";
    if (session.authEnabled) {
      if (session.currentUser) {
        displayNickname(session.currentUser.username);
        session.socket.emit("set new nickname", session.currentUser.username, currentRoomId());
      }
    } else if (typed) {
      localStorage.setItem("nickname", typed);
      displayNickname(typed);
      session.socket.emit("set new nickname", typed, currentRoomId());
    }
    const field = maybeById<HTMLInputElement>("nickname-input");
    if (field) field.value = "";
    closeDialog(byId("dlg-nickname"));
  });
}

function clearChat(): void {
  const box = maybeById("chat-messages");
  if (box) clear(box);
}

/* A friendly default when the player creates a room without naming it. */
const NAME_WORDS = [
  "Royal", "Golden", "Merry", "Brave", "Noble", "Quiet", "Clever", "Jolly",
  "Lucky", "Grand", "Rusty", "Velvet",
];
const NAME_NOUNS = [
  "Tavern", "Court", "Keep", "Guild", "Hall", "Castle", "Market", "Manor",
  "Chapel", "Bridge", "Mill", "Gardens",
];

function generateRoomName(): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(NAME_WORDS)} ${pick(NAME_NOUNS)}`;
}

/** Create a room: Enter or the button both land here. An empty name is fine. */
function submitCreateRoom(session: Session): void {
  const field = maybeById<HTMLInputElement>("new-room-name");
  const name = field?.value.trim() || generateRoomName();
  const hide = maybeById<HTMLInputElement>("hide-room")?.checked ?? false;
  const noTax = maybeById<HTMLInputElement>("no-tax-room")?.checked ?? false;
  const targetRaw = Number(maybeById<HTMLInputElement>("target-points")?.value);
  const targetPoints = Number.isFinite(targetRaw) && targetRaw >= 1 ? Math.floor(targetRaw) : 15;

  clearChat();
  showLoading(session);
  session.socket.emit("create game room", name, hide, noTax, targetPoints);
  if (field) field.value = "";
  closeDialog(byId("dlg-create"));
}

function showLoading(session: Session): void {
  setText(maybeById("lobby-title") ?? document.createElement("span"), session.lang.connecting);
  const list = maybeById("room-list");
  if (list) clear(list);
}

/* ---- room: buttons ----------------------------------------------------- */

function wireRoom(session: Session): void {
  maybeById("ready-btn")?.addEventListener("click", (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    session.socket.emit("ready");
    btn.textContent = btn.textContent === session.lang.notReady ? session.lang.ready : session.lang.notReady;
  });

  maybeById("play-btn")?.addEventListener("click", () => onPlay(session));

  maybeById("home-btn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    session.socket.emit("leave room");
  });

  maybeById("add-bot-btn")?.addEventListener("click", () => openDialog(byId("dlg-add-bot")));
  maybeById("reset-session-btn")?.addEventListener("click", () => session.socket.emit("reset session"));
  maybeById("share-btn")?.addEventListener("click", () => openDialog(byId("dlg-share")));
  maybeById("dlg-add-bot-close")?.addEventListener("click", () => closeDialog(byId("dlg-add-bot")));
  maybeById("add-bot-confirm")?.addEventListener("click", () => {
    session.socket.emit("add bot", maybeById<HTMLSelectElement>("bot-difficulty")?.value ?? "medium");
  });
  maybeById("fill-bots")?.addEventListener("click", () => {
    session.socket.emit("fill bots", maybeById<HTMLSelectElement>("bot-difficulty")?.value ?? "medium");
  });

  maybeById("share-close")?.addEventListener("click", () => closeDialog(byId("dlg-share")));
}

function onPlay(session: Session): void {
  const btn = maybeById<HTMLButtonElement>("play-btn");
  if (!btn || btn.disabled) return;
  const rd = session.room;
  if (!rd) return;

  const selection = session.selection.selection();
  const tableEmpty = !(rd.last && rd.last.num);
  const kind = classifyMove(rd.last, selection, tableEmpty);

  if (kind === "play") {
    session.socket.emit("play", selection);
    resetHandSelection(session);
    return;
  }
  if (kind === "pass") {
    // When no card in hand can answer the field, passing is the only action -
    // don't make the player confirm it.
    const forced = !hasLegalPlay(rd.hand, rd.last ?? null);
    if (forced || window.confirm(session.lang.confirmPass)) {
      session.socket.emit("play", {});
      resetHandSelection(session);
    }
    return;
  }
  toast(tableEmpty ? session.lang.mustPlay : session.lang.wrongCard);
}

/** Drop the picked cards right away so the next hand starts clean. */
function resetHandSelection(session: Session): void {
  session.selection.clear();
  paintSelection(session, collectHandNodes());
  updatePlayButton(session);
}

/* ---- server events ----------------------------------------------------- */

function wireServerEvents(session: Session): void {
  session.socket.on("refresh waiting room", (rooms, userCount) => renderLobby(session, rooms, userCount));
  session.socket.on("update sender", (sender) => {
    if (sender.token) localStorage.setItem("reconnectToken", sender.token);
    displayNickname(sender.nickname);
    setText(maybeById("room-title") ?? document.createElement("span"), `${session.lang.roomTitle} ${sender.cur_room}`);
    const share = maybeById<HTMLInputElement>("share-input");
    if (share) share.value = sender.cur_room;
  });
  session.socket.on("connectUrl", (url) => {
    location.href = url;
  });
  session.socket.on("alert", (key) => toast(resolveMessage(session.lang, key)));
  session.socket.on("refresh game room", (data) => onRoomUpdate(session, data));
  session.socket.on("chat message", (nickname, msg, sid) => {
    const div = el("div", { class: "mb-0.5 break-words" });
    div.appendChild(el("b", { text: `${nickname}:` }));
    div.appendChild(document.createTextNode(` ${msg}`));
    if (session.socket.id === sid) div.classList.add("text-forest-dark");
    appendChat(div);
  });
  session.socket.on("chat connection", (user) => {
    const suffix = user.connected === false ? session.lang.disconnected : session.lang.connected;
    appendChat(el("div", { class: "font-bold", text: user.nickname + suffix }));
  });
  session.socket.on("chat announce", (key, color, nickname, nickname1) => {
    let text = resolveMessage(session.lang, key);
    if (nickname && nickname1) text = `${nickname1} ${text} ${nickname}`;
    else if (nickname) text = `${nickname} ${text}`;
    const div = el("div", { class: "font-bold", text });
    div.style.color = color;
    appendChat(div);
  });
  session.socket.on("chat announce taxs", (_key, color, sent, received) => {
    const div = el("div", { class: "font-bold" });
    div.appendChild(document.createTextNode(`${session.lang.taxs[0]} ${sent}`));
    div.appendChild(el("br"));
    div.appendChild(document.createTextNode(`${session.lang.taxs[1]} ${received}`));
    div.style.color = color;
    appendChat(div);
  });
  session.socket.on("revolution phase", (info) => {
    const btn = maybeById<HTMLButtonElement>("revolution-btn");
    const panel = maybeById("revolution-panel");
    if (btn) {
      btn.disabled = false;
      btn.onclick = () => {
        session.socket.emit("declare revolution");
        btn.disabled = true;
      };
    }
    if (panel) show(panel, true);
    setText(
      maybeById("revolution-text") ?? document.createElement("span"),
      info.greater ? session.lang.revolutionPromptGreater : session.lang.revolutionPrompt
    );
    toast(info.greater ? session.lang.revolutionPromptGreater : session.lang.revolutionPrompt);
  });
  // Only the Dalmuti picks cards to return; the Peon's tribute is automatic.
  session.socket.on("tax phase", (info) => {
    const panel = maybeById("tax-panel");
    if (panel) show(panel, true);
    setText(
      maybeById("tax-title") ?? document.createElement("span"),
      session.lang.taxDalmutiPrompt
    );
    const submit = maybeById<HTMLButtonElement>("tax-submit");
    if (submit) {
      submit.disabled = true;
      submit.onclick = () => {
        session.socket.emit("tax", session.taxSelection.selection());
        session.taxSelection.clear();
        const p = maybeById("tax-panel");
        if (p) show(p, false);
      };
    }
    renderTaxCards(session, info.count);
  });

  // The Peon is told what they paid, not asked - a fast auto-swap must never
  // leave them unaware that the tax happened. A toast fires immediately and a
  // persistent banner stays for a few seconds (the toast alone is easy to miss).
  session.socket.on("tax owed", (info) => {
    toast(`${session.lang.taxDue} ${info.count} → ${info.partner}`);
  });

  session.socket.on("tax result", (info) => {
    toast(`${session.lang.taxPaid}: ${info.sent} → ${info.received} (${info.partner})`);
    const banner = maybeById("tax-result");
    const text = maybeById("tax-result-text");
    if (banner && text) {
      text.textContent = `${session.lang.taxPaid}: ${info.sent} → ${info.received} (${info.partner})`;
      show(banner, true);
      window.clearTimeout(Number(banner.dataset.timer ?? "0"));
      const timer = window.setTimeout(() => show(banner, false), 6000);
      banner.dataset.timer = String(timer);
    }
  });
}

function appendChat(node: HTMLElement): void {
  const box = maybeById("chat-messages");
  if (!box) return;
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
}

function renderLobby(session: Session, rooms: LobbyView, userCount: number): void {
  const list = maybeById("room-list");
  const title = maybeById("lobby-title");
  if (!list || !title) return;
  clear(list);

  const entries = Object.entries(rooms);
  for (const [name, room] of entries) {
    const status =
      room.state === GameState.WAITING
        ? session.lang.wait
        : room.state === GameState.PLAYING
          ? session.lang.playing
          : "";
    const row = el("button", {
      class: "room-row",
      attrs: { type: "button" },
      children: [
        el("span", { text: `${session.lang.roomTitle} ${name}` }),
        el("span", {
          class: "text-sm text-ink-soft",
          text: `${session.lang.players} ${room.players} / ${room.capacity} · ${status}`,
        }),
      ],
    });
    row.addEventListener("click", () => {
      clearChat();
      showLoading(session);
      session.socket.emit("join game room", name);
    });
    list.appendChild(row);
  }

  if (entries.length === 0) {
    list.appendChild(el("p", { class: "text-center text-ink-soft", text: session.lang.noRoom }));
  }

  title.textContent = `${session.lang.title} — ${entries.length} ${session.lang.room} · ${userCount} ${session.lang.usersOnline}`;
}

/* ---- room rendering ---------------------------------------------------- */

function onRoomUpdate(session: Session, data: RoomData): void {
  session.room = data;
  renderRoom(session, data);
}

function renderRoom(session: Session, data: RoomData): void {
  const readyBtn = maybeById<HTMLButtonElement>("ready-btn");
  const homeBtn = maybeById<HTMLButtonElement>("home-btn");
  if (data.state === GameState.WAITING) {
    if (readyBtn) readyBtn.disabled = false;
  } else if (readyBtn) {
    readyBtn.disabled = true;
    readyBtn.textContent = session.lang.ready;
  }
  if (homeBtn) homeBtn.disabled = false;

  const addBotBtn = maybeById<HTMLButtonElement>("add-bot-btn");
  if (addBotBtn) {
    const canManage = data.you === data.host && data.state === GameState.WAITING;
    show(addBotBtn, canManage);
    addBotBtn.disabled = !data.canAddBot;
  }
  renderBotList(session, data);

  renderSlots(session, data);
  markMySeat(data);
  renderHand(session, data);
  renderField(session, data);
  renderHandFinished(session, data);
  renderSessionOver(session, data);
  setPlayable(session, data);
  renderLeaderboard(session, data);

  const panel = maybeById("tax-panel");
  if (data.phase && data.phase.type === "tax" && panel && !panel.classList.contains("hidden")) {
    renderTaxCards(session, session.taxSelection.limitValue);
  }
  if (!data.phase || data.phase.type !== "revolution") {
    const rev = maybeById("revolution-panel");
    if (rev) show(rev, false);
  }
  if (!data.phase || data.phase.type !== "tax") {
    if (panel) show(panel, false);
  }
}

function seatOf(data: RoomData, sid: string): number | null {
  const player = data.players[sid];
  return player ? player.seat : null;
}

function setPlayable(session: Session, data: RoomData): void {
  for (let i = 0; i < 8; i++) maybeById(`slot${i}`)?.classList.remove("currentTurn");
  const playBtn = maybeById<HTMLButtonElement>("play-btn");
  if (playBtn) playBtn.disabled = true;

  const cur = data.state === GameState.PLAYING ? data.cur_order_idx : -1;
  let myTurn = false;
  for (const [sid, player] of Object.entries(data.players)) {
    if (cur !== player.seat) continue;
    maybeById(`slot${cur}`)?.classList.add("currentTurn");
    if (sid === data.you) {
      myTurn = true;
      if (playBtn) playBtn.disabled = false;
    }
  }

  const hint = maybeById("turn-hint");
  const tableEmpty = !(data.last && data.last.num);
  const onlyPass =
    myTurn && !tableEmpty && data.last ? !hasLegalPlay(data.hand, data.last) : false;
  // Leading (empty table) means any cards are legal; say so, so a fresh trick is
  // never mistaken for a follow that still needs a lower rank.
  const baseText = tableEmpty ? session.lang.leadNow : session.lang.yourTurn;
  if (hint) {
    show(hint, data.state === GameState.PLAYING && myTurn);
    if (!myTurn) hint.textContent = "";
    else if (!onlyPass) hint.textContent = baseText;
  }
  updateAutoPass(session, myTurn, onlyPass, baseText);
  if (myTurn) updatePlayButton(session);
}

// When the player on turn has no legal answer, the server passes them after 5 s.
// Show a matching countdown so the wait is explained; the client only mirrors the
// server's decision (it can never pass on its own).
function updateAutoPass(session: Session, myTurn: boolean, onlyPass: boolean, baseText: string): void {
  const hint = maybeById("turn-hint");
  const active = myTurn && onlyPass;
  const key = `${active ? 1 : 0}:${session.room ? session.room.cur_order_idx : -1}`;
  if (key === session.autoPassKey) return;
  session.autoPassKey = key;

  if (session.autoPassTimer !== null) {
    window.clearInterval(session.autoPassTimer);
    session.autoPassTimer = null;
  }
  if (hint) {
    hint.classList.toggle("text-herald", active);
    hint.classList.toggle("text-gold-light", !active);
  }
  if (!active || !session.room) {
    if (hint && myTurn) hint.textContent = baseText;
    return;
  }

  session.autoPassEnds = Date.now() + AUTO_PASS_MS;
  const paint = (): void => {
    if (!hint) return;
    const left = Math.max(0, Math.ceil((session.autoPassEnds - Date.now()) / 1000));
    hint.textContent = `${session.lang.yourTurn} — ${session.lang.autoPassIn} ${left}…`;
  };
  paint();
  session.autoPassTimer = window.setInterval(() => {
    if (!hint || hint.classList.contains("hidden")) {
      window.clearInterval(session.autoPassTimer as number);
      session.autoPassTimer = null;
      return;
    }
    paint();
  }, 250);
}

function renderSlots(session: Session, data: RoomData): void {
  for (let i = 0; i < 8; i++) {
    const container = maybeById(`player${i}`);
    const role = maybeById(`role${i}`);
    if (role) role.className = "role-art";
    if (!container) continue;
    clear(container);
  }

  const bySeat = new Map<number, { sid: string; player: RoomData["players"][string] }>();
  for (const [sid, player] of Object.entries(data.players)) {
    if (player.seat >= 0 && !player.spectator) bySeat.set(player.seat, { sid, player });
  }

  for (const [, { sid, player }] of bySeat) {
    const seat = player.seat;
    const container = maybeById(`player${seat}`);
    if (!container) continue;
    const name = el("div", { class: "font-display font-bold break-all" });
    name.appendChild(document.createTextNode(player.nickname));
    if (sid === data.you) name.appendChild(el("span", { class: "you-tag", text: session.lang.you }));
    if (player.isBot) name.appendChild(el("span", { class: "badge", text: session.lang.botLabel }));
    container.appendChild(name);

    container.appendChild(
      el("div", { class: "text-sm", text: `${session.lang.cards} ${player.handCount}` })
    );

    if (data.state === GameState.WAITING) {
      container.appendChild(
        el("div", {
          class: player.ready ? "text-sm text-forest-dark font-bold" : "text-sm text-herald font-bold",
          text: player.ready ? session.lang.ready : session.lang.notReady,
        })
      );
    } else if (player.handCount === 0) {
      container.appendChild(el("div", { class: "text-sm text-forest-dark font-bold", text: session.lang.winner }));
    } else if (player.role) {
      setRoleArt(seat, player.role);
    }
  }

  const spectators = Object.entries(data.players).filter(([, p]) => p.spectator);
  const specList = maybeById("spectator-list");
  if (specList) {
    clear(specList);
    if (spectators.length) {
      specList.appendChild(el("div", { class: "font-display font-semibold", text: session.lang.spect }));
      for (const [, p] of spectators) {
        specList.appendChild(el("div", { text: p.nickname }));
      }
    }
  }
}

function setRoleArt(seat: number, role: Role): void {
  const node = maybeById(`role${seat}`);
  if (node) node.className = `role-art role-${role}`;
}

/** Ring the recipient's own seat so they can find themselves at a glance. */
function markMySeat(data: RoomData): void {
  for (let i = 0; i < 8; i++) maybeById(`slot${i}`)?.classList.remove("mySeat");
  const me = data.players[data.you];
  if (me && !me.spectator && me.seat >= 0) {
    maybeById(`slot${me.seat}`)?.classList.add("mySeat");
  }
}

function renderBotList(session: Session, data: RoomData): void {
  const list = maybeById("bot-list");
  if (!list) return;
  clear(list);
  const bots = Object.entries(data.players).filter(([, p]) => p.isBot);
  if (!bots.length) return;
  list.appendChild(el("div", { class: "font-display font-bold", text: session.lang.botsTitle }));
  for (const [sid, bot] of bots) {
    const row = el("div", { class: "flex items-center justify-between my-1 gap-2" });
    const label = difficultyLabel(session, bot.difficulty);
    row.appendChild(el("span", { text: `${bot.nickname} (${label})` }));
    const remove = el("button", { class: "btn btn-herald px-2 py-1 text-sm", text: session.lang.removeBot });
    remove.addEventListener("click", () => session.socket.emit("remove bot", sid));
    row.appendChild(remove);
    list.appendChild(row);
  }
}

function difficultyLabel(session: Session, diff: string | null): string {
  if (diff === "easy") return session.lang.difficultyEasy;
  if (diff === "hard") return session.lang.difficultyHard;
  return session.lang.difficultyMedium;
}

/* ---- hand -------------------------------------------------------------- */

function renderHand(session: Session, data: RoomData): void {
  const hand = maybeById("hand");
  if (!hand) return;

  session.selection.setHand(data.hand);
  session.selection.setLimit(fieldCount(data.last));
  const tableEmpty = !(data.last && data.last.num);
  session.selection.setPlayable(playableRanks(data.last, tableEmpty));

  // Rebuild only when the multiset of cards changes; a plain room refresh keeps
  // the DOM (and the player's selection) intact.
  const key = data.hand.slice().sort((a, b) => a - b).join(",");
  if (key === session.handKey) {
    paintSelection(session, collectHandNodes());
    updatePlayButton(session);
    return;
  }
  session.handKey = key;
  clear(hand);

  const sorted = data.hand.slice().sort((a, b) => a - b);
  for (const value of sorted) {
    const card = el("div", {
      class: `cards ${cardClass(value)} selectable`,
      attrs: {
        role: "button",
        tabindex: "0",
        "data-value": String(value),
        "aria-label": rankLabel(value),
        "aria-pressed": "false",
      },
    });
    attachCardInput(card, (single) => {
      if (single) session.selection.toggleOne(value);
      else session.selection.toggleRank(value);
      paintSelection(session, collectHandNodes());
      updatePlayButton(session);
    });
    hand.appendChild(card);
  }

  paintSelection(session, collectHandNodes());
  updatePlayButton(session);
}

function collectHandNodes(): Map<number, HTMLElement[]> {
  const nodes = new Map<number, HTMLElement[]>();
  for (const card of qsa<HTMLElement>("#hand .cards")) {
    const value = Number(card.dataset.value);
    const bucket = nodes.get(value) ?? [];
    bucket.push(card);
    nodes.set(value, bucket);
  }
  return nodes;
}

function paintSelection(session: Session, nodes: Map<number, HTMLElement[]>): void {
  for (const [value, bucket] of nodes) {
    const count = session.selection.selectedCountOf(value);
    const playable = session.selection.isPlayable(value);
    bucket.forEach((node, index) => {
      const on = index < count;
      node.classList.toggle("selected", on);
      node.classList.toggle("unplayable", !playable);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

function updatePlayButton(session: Session): void {
  const btn = maybeById<HTMLButtonElement>("play-btn");
  if (!btn) return;
  const rd = session.room;
  if (!rd) return;
  const selection = session.selection.selection();
  const hasSelection = Object.keys(selection).length > 0;

  if (hasSelection) {
    btn.textContent = session.lang.play;
    btn.classList.remove("btn-herald");
    btn.classList.add("btn-forest");
  } else {
    btn.textContent = session.lang.pass;
    btn.classList.remove("btn-forest");
    btn.classList.add("btn-herald");
  }
}

/** Click = toggle whole rank; Shift-click or long-press = one copy. */
function attachCardInput(card: HTMLElement, toggle: (single: boolean) => void): void {
  let timer = 0;
  let longPress = false;

  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse") return;
    longPress = false;
    timer = window.setTimeout(() => {
      longPress = true;
      toggle(true);
    }, 450);
  });
  const cancel = (): void => window.clearTimeout(timer);
  card.addEventListener("pointerup", cancel);
  card.addEventListener("pointerleave", cancel);
  card.addEventListener("pointercancel", cancel);
  card.addEventListener("click", (ev) => {
    if (longPress) {
      longPress = false;
      return;
    }
    toggle(ev.shiftKey);
  });
  card.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle(ev.shiftKey);
    }
  });
}

/* ---- field ------------------------------------------------------------- */

function renderField(session: Session, data: RoomData): void {
  const field = maybeById("field-section");
  const who = maybeById("who-played");
  const empty = maybeById("field-empty");
  if (!field) return;

  // The table only shows cards while a hand is actually being played. Between
  // hands (waiting for ready, revolution/tax phase) it must be empty, so clear
  // it and drop the cached keys. Without this the last play of a finished hand
  // could linger in the middle of the table until someone leads the next hand.
  if (data.state !== GameState.PLAYING) {
    clear(field);
    if (who) {
      clear(who);
      who.classList.remove("who-won");
    }
    if (empty) show(empty, false);
    session.fieldCardsKey = null;
    session.lastPlayedKey = null;
    return;
  }

  // Render from the display copy `shown` (not the rule state `last`): after a
  // trick ends `last` is cleared but `shown` keeps the winning play on the table
  // until someone leads again.
  const last = data.shown;
  // The cards flip only when the play changes; the "won the trick" state arrives
  // as a later refresh (after the winner is known) and must relabel without
  // replaying the animation.
  const cardsKey = last ? `${last.by}:${last.num}:${last.count}:${(last.cards ?? []).join(",")}` : "empty";
  const labelKey = `${cardsKey}:${last ? last.handCount : ""}:${last && last.trickOver ? 1 : 0}`;
  if (labelKey === session.lastPlayedKey) return;
  const rebuild = cardsKey !== session.fieldCardsKey;
  session.lastPlayedKey = labelKey;
  session.fieldCardsKey = cardsKey;

  if (rebuild) {
    clear(field);
    if (who) {
      clear(who);
      who.classList.remove("who-won");
    }
    if (empty) show(empty, data.state === GameState.PLAYING && (!last || !last.num));
    if (!last || !last.num) {
      if (empty) empty.textContent = session.lang.newTrick;
      return;
    }
  }

  // A finisher (handCount 0) won the hand; a `trickOver` play won a completed
  // trick. Both must read differently from the neutral "played:" label so the
  // next player knows the table is a fresh lead, not a follow.
  if (!last || !last.num) return;
  const finished = typeof last.handCount === "number" && last.handCount === 0;
  if (who && last.by) {
    const player = data.players[last.by];
    if (player) {
      if (finished) who.textContent = `${player.nickname} ${session.lang.wonHand}`;
      else if (last.trickOver) who.textContent = session.lang.wonTrick.replace("{name}", player.nickname);
      else who.textContent = `${player.nickname} ${session.lang.placed}`;
    }
  }
  if (who) who.classList.toggle("who-won", finished || !!last.trickOver);

  // The winning play stays visible only while the trick is active. Once a trick has
  // been won or a hand has finished, the table must be cleared so the next player
  // clearly sees a fresh lead instead of a stale follow.
  if (!rebuild) {
    if (finished || !!last.trickOver) {
      clear(field);
      if (empty) {
        empty.textContent = session.lang.newTrick;
        show(empty, true);
      }
      session.fieldCardsKey = "empty";
      session.lastPlayedKey = "empty";
    }
    return;
  }

  for (let i = 0; i < last.count; i++) {
    // Show the card actually played: a Joker stays a Joker even when it stood in
    // for another rank, so everyone can see it was used.
    const value = (last.cards && last.cards[i]) ?? last.num;
    const back = el("div", { class: "flip-face backCard absolute inset-0" });
    const face = el("div", { class: `flip-face flip-back cards ${cardClass(value)}` });
    const inner = el("div", { class: "flip-inner card-enter", children: [back, face] });
    field.appendChild(inner);
  }
  // Record the un-flipped state in a style recalc before adding `active`,
  // otherwise the browser coalesces both changes and the rotateY transition
  // never runs (cards would appear already flipped, or not at all).
  void field.offsetWidth;
  window.requestAnimationFrame(() => {
    for (const inner of qsa(".flip-inner", field)) inner.classList.add("active");
  });
}

/* ---- hand finished banner ---------------------------------------------- */

/** Show a prominent banner when the recipient has gone out for the hand. */
function renderHandFinished(session: Session, data: RoomData): void {
  const banner = maybeById("hand-finished");
  if (!banner) return;
  const me = data.players[data.you];
  const out = !!me && !me.spectator && me.handCount === 0;
  setText(maybeById("hand-finished-text") ?? document.createElement("span"), session.lang.youWonHand);
  show(banner, out && data.state === GameState.PLAYING);
}

/* ---- session score ----------------------------------------------------- */

// Shown once a player reaches the session target. The host can clear the scores
// and start a fresh session; the room keeps its seats, hands are frozen meanwhile.
function renderSessionOver(session: Session, data: RoomData): void {
  const banner = maybeById("session-over");
  if (!banner) return;
  const isHost = data.you === data.host;
  const winner = data.sessionOver ? topScorer(data) : null;
  const text =
    winner && winner.nickname
      ? `${winner.nickname} ${session.lang.sessionWon}`
      : session.lang.sessionOver;
  setText(maybeById("session-over-text") ?? document.createElement("span"), text);
  show(banner, data.sessionOver);
  const resetBtn = maybeById("reset-session-btn");
  if (resetBtn) show(resetBtn, data.sessionOver && isHost);
}

function topScorer(data: RoomData): PlayerView | null {
  let best: PlayerView | null = null;
  for (const p of Object.values(data.players)) {
    if (p.spectator) continue;
    if (!best || p.points > best.points) best = p;
  }
  return best;
}

// The scoreboard subtitle names the running target, e.g. "Session score
// (target 15)". Falls back to the plain label when the room has no target.
function sessionScoreTitle(lang: Language, data: RoomData): string {
  const label = lang.sessionScore;
  if (!data.targetPoints) return label;
  return label.includes("{target}")
    ? label.replace("{target}", String(data.targetPoints))
    : `${label} · ${data.targetPoints}`;
}

/* ---- tax --------------------------------------------------------------- */

function renderTaxCards(session: Session, count: number): void {
  const holder = maybeById("tax-hand");
  const rd = session.room;
  if (!holder || !rd) return;

  session.taxSelection.setHand(rd.hand);
  session.taxSelection.setLimit(count);

  const key = `${count}|${rd.hand.slice().sort((a, b) => a - b).join(",")}`;
  if (key === session.taxKey) {
    paintTaxSelection(session, collectTaxNodes());
    return;
  }
  session.taxKey = key;
  clear(holder);

  const unique = [...new Set(rd.hand)].sort((a, b) => a - b);
  for (const value of unique) {
    const copies = rd.hand.filter((c) => c === value).length;
    const card = el("div", {
      class: `cards ${cardClass(value)} selectable`,
      attrs: { role: "button", tabindex: "0", "data-value": String(value), "aria-label": rankLabel(value) },
    });
    attachCardInput(card, (single) => {
      if (single) session.taxSelection.toggleOne(value);
      else session.taxSelection.toggleRank(value);
      paintTaxSelection(session, collectTaxNodes());
    });
    holder.appendChild(card);
    if (copies > 1) holder.appendChild(el("span", { class: "self-end mb-2 text-sm", text: `×${copies}` }));
  }

  paintTaxSelection(session, collectTaxNodes());
}

function collectTaxNodes(): Map<number, HTMLElement[]> {
  const nodes = new Map<number, HTMLElement[]>();
  for (const card of qsa<HTMLElement>("#tax-hand .cards")) {
    const value = Number(card.dataset.value);
    const bucket = nodes.get(value) ?? [];
    bucket.push(card);
    nodes.set(value, bucket);
  }
  return nodes;
}

function paintTaxSelection(session: Session, nodes: Map<number, HTMLElement[]>): void {
  for (const [value, bucket] of nodes) {
    const count = session.taxSelection.selectedCountOf(value);
    bucket.forEach((node, index) => node.classList.toggle("selected", index < count));
  }
  const submit = maybeById<HTMLButtonElement>("tax-submit");
  if (submit) submit.disabled = session.taxSelection.total() !== session.taxSelection.limitValue;
}

/* ---- leaderboard ------------------------------------------------------- */

function renderLeaderboard(session: Session, data: RoomData): void {
  const stats = maybeById("statistics");
  if (!stats) return;
  clear(stats);

  const title = maybeById("session-score-title");
  if (title) title.textContent = sessionScoreTitle(session.lang, data);

  // One row per seated player, ranked by running session total. After a hand the
  // leaderboard is authoritative (finishing order + roles); during a hand we
  // fall back to the live players so the totals stay visible as they grow.
  type Row = { sid: string; nickname: string; role: Role | null; total: number };
  let rows: Row[];
  if (data.leaderBoard) {
    rows = data.leaderBoard.map((r) => {
      const p = data.players[r.sid];
      return { sid: r.sid, nickname: r.nickname, role: r.role, total: p ? p.points : r.points };
    });
  } else {
    rows = Object.entries(data.players)
      .filter(([, p]) => !p.spectator)
      .map(([sid, p]) => ({
        sid,
        nickname: p.nickname,
        role: p.role ?? (data.roles ? data.roles[sid] ?? null : null),
        total: p.points,
      }));
  }
  rows.sort((a, b) => b.total - a.total);

  for (const row of rows) {
    const size =
      row.role === "greaterDalmuti"
        ? "text-xl text-gold-dark"
        : row.role === "lesserDalmuti"
          ? "text-lg"
          : row.role === "lesserPeon" || row.role === "greaterPeon"
            ? "text-sm"
            : "text-base";
    stats.appendChild(
      el("div", {
        class: `w-full font-bold ${size}`,
        text: `${row.nickname}: ${row.total} / ${data.targetPoints}`,
      })
    );
    // Role heraldry is painted only between hands (renderSlots owns it during
    // play); it marks the seats the finished hand just assigned.
    const seat = seatOf(data, row.sid);
    if (seat != null && row.role && data.state === GameState.WAITING) setRoleArt(seat, row.role);
  }
}

/* ---- entry ------------------------------------------------------------- */

void boot();
