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
import { loadLanguage, resolveMessage, setLanguage, currentLang, type LangCode, type Language } from "./i18n";
import { connect, type TypedSocket } from "./socket";
import { SelectionModel } from "./selection";
import { classifyMove, fieldCount, playableRanks } from "./client-rules";
import { GameState, JOKER, type AuthInfo, type LobbyView, type RoomData, type Role } from "./types";

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
  handKey: string | null;
  taxKey: string | null;
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
    handKey: null,
    taxKey: null,
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
    "create-room-confirm": lang.btnCreate,
    "nickname-title": lang.titleNickModal,
    "nickname-label": lang.setNickname,
    "nickname-save": lang.save,
    "join-room-confirm": lang.btnJoin,
    info: lang.info,
    "how-to-play": lang.howToPlay,
    "choose-lang-label": lang.chooseLang,
    "play-btn": lang.pass,
    "ready-btn": lang.ready,
    "add-bot-btn": lang.addBot,
    "share-btn": lang.share,
    "share-title": lang.shareTit,
    "share-label": lang.shareInvite,
    "share-close": lang.close,
    "leaderboard-title": lang.leaderboard,
    "add-bot-title": lang.addBotTitle,
    "bot-difficulty-label": lang.botDifficulty,
    "add-bot-confirm": lang.botAdd,
    "fill-bots": lang.fillBots,
    "fullscreen-btn": lang.fullscreen,
    "select-hint": lang.selectHint,
    "revolution-text": lang.revolutionPrompt,
  };
  for (const [id, value] of Object.entries(map)) setText(maybeById(id) ?? document.createElement("span"), value);

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

  const active = currentLang();
  for (const code of ["en", "it", "bg"] as LangCode[]) {
    const link = maybeById<HTMLAnchorElement>(`lang-${code}`);
    if (!link) continue;
    link.classList.toggle("font-bold", code === active);
    link.classList.toggle("text-gold-dark", code === active);
    link.setAttribute("aria-current", code === active ? "true" : "false");
  }
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

  for (const code of ["en", "it", "bg"] as LangCode[]) {
    maybeById(`lang-${code}`)?.addEventListener("click", (ev) => {
      ev.preventDefault();
      setLanguage(code);
    });
  }

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

  maybeById("create-room-confirm")?.addEventListener("click", () => {
    const name = maybeById<HTMLInputElement>("new-room-name")?.value.trim() ?? "";
    const hide = maybeById<HTMLInputElement>("hide-room")?.checked ?? false;
    if (!name) {
      toast("Please enter a room name.");
      return;
    }
    clearChat();
    showLoading(session);
    session.socket.emit("create game room", name, hide);
    const field = maybeById<HTMLInputElement>("new-room-name");
    if (field) field.value = "";
    closeDialog(byId("dlg-create"));
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
    if (window.confirm(session.lang.confirmPass)) {
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
  session.socket.on("chat announce taxs", (key, color, paid, received) => {
    const resolved = resolveMessage(session.lang, key);
    const lines: [string, string] = [resolved, ""];
    const div = el("div", { class: "font-bold" });
    div.appendChild(document.createTextNode(`${lines[0]} ${paid}`));
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
  session.socket.on("tax phase", (info) => {
    const panel = maybeById("tax-panel");
    if (panel) show(panel, true);
    setText(
      maybeById("tax-title") ?? document.createElement("span"),
      info.role === "peon" ? session.lang.taxPeonPrompt : session.lang.taxDalmutiPrompt
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
  renderHand(session, data);
  renderField(session, data);
  setPlayable(session, data);
  renderLeaderboard(data);

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
  if (hint) {
    show(hint, data.state === GameState.PLAYING && myTurn);
    hint.textContent = myTurn ? session.lang.yourTurn : "";
  }
  if (myTurn) updatePlayButton(session);
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

  for (const [, { player }] of bySeat) {
    const seat = player.seat;
    const container = maybeById(`player${seat}`);
    if (!container) continue;
    const name = el("div", { class: "font-display font-bold break-all" });
    name.appendChild(document.createTextNode(player.nickname));
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
  if (!field) return;

  const last = data.state === GameState.PLAYING ? data.last : null;
  const key = last ? `${last.by}:${last.num}:${last.count}:${last.handCount}` : "empty";
  if (key === session.lastPlayedKey) return;
  session.lastPlayedKey = key;

  clear(field);
  if (who) clear(who);
  if (!last || !last.num) return;

  if (who && last.by) {
    const player = data.players[last.by];
    if (player) {
      const finished = typeof last.handCount === "number" && last.handCount === 0;
      who.textContent = `${player.nickname} ${finished ? session.lang.winner : session.lang.placed}`;
    }
  }

  for (let i = 0; i < last.count; i++) {
    const back = el("div", { class: "flip-face backCard absolute inset-0" });
    const face = el("div", { class: `flip-face flip-back cards ${cardClass(last.num)}` });
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

function renderLeaderboard(data: RoomData): void {
  const stats = maybeById("statistics");
  if (!stats) return;
  clear(stats);
  if (!data.leaderBoard) return;

  for (const row of data.leaderBoard) {
    const size =
      row.role === "greaterDalmuti"
        ? "text-xl text-gold-dark"
        : row.role === "lesserDalmuti"
          ? "text-lg"
          : row.role === "lesserPeon" || row.role === "greaterPeon"
            ? "text-sm"
            : "text-base";
    stats.appendChild(el("div", { class: `w-full font-bold ${size}`, text: `${row.nickname}: ${row.points}` }));
    const seat = seatOf(data, row.sid);
    if (seat != null && row.role) setRoleArt(seat, row.role);
  }
}

/* ---- entry ------------------------------------------------------------- */

void boot();
