"use strict";

const crypto = require("crypto");
const { Player, Game, game_state, SEATS } = require("./config");
const engine = require("./game-engine");
const {
  sanitizeNickname,
  sanitizeRoomName,
  sanitizeChat,
  createRateLimiter,
} = require("./security");

const MAX_ROOMS = 200;

// Owns all rooms, the game flow and the socket protocol. Kept free of Express
// so it can be driven directly from tests.
class RoomManager {
  constructor(io, opts = {}) {
    this.io = io;
    this.log = opts.log || console;
    this.rng = opts.rng || Math.random;
    this.rooms = { open: {}, hide: {} };
    this.roomNumber = 0;
    this.userCount = 0;
    this.connectNumber = 1;
    this.tokens = new Map(); // reconnect token -> { room, sid }
    this.timers = new Map(); // room name -> active phase timer
    this.taxWindowMs = opts.taxWindowMs != null ? opts.taxWindowMs : 20000;
    this.revolutionWindowMs =
      opts.revolutionWindowMs != null ? opts.revolutionWindowMs : 15000;
    this.allowRoom = createRateLimiter({ limit: 5, windowMs: 60000 });
    this.allowChat = createRateLimiter({ limit: 10, windowMs: 10000 });
    this.userStore = opts.userStore || null;
    // Enforce authentication whenever a user store is available. Tests that
    // exercise raw game logic can opt out with requireAuth: false.
    this.requireAuth = opts.requireAuth != null ? opts.requireAuth : !!this.userStore;
  }

  // Resolve the authenticated identity from the shared Express session.
  sessionUser(socket) {
    const sess = socket.request && socket.request.session;
    const id = sess && sess.passport && sess.passport.user;
    if (!id || !this.userStore) return null;
    return this.userStore.findById(id) || null;
  }

  // ---- helpers ------------------------------------------------------------

  roomEntry(name) {
    if (this.rooms.open[name]) return { room: this.rooms.open[name], store: this.rooms.open };
    if (this.rooms.hide[name]) return { room: this.rooms.hide[name], store: this.rooms.hide };
    return null;
  }

  roomCount() {
    return Object.keys(this.rooms.open).length + Object.keys(this.rooms.hide).length;
  }

  players(room) {
    return Object.values(room.sockets);
  }

  readyCount(room) {
    return this.players(room).filter((p) => p.ready && !p.spectator).length;
  }

  seatedCount(room) {
    return this.players(room).filter((p) => !p.spectator).length;
  }

  // Public lobby view of a room (no hands).
  lobbyView() {
    const out = {};
    for (const [name, room] of Object.entries(this.rooms.open)) {
      out[name] = {
        name,
        players: this.seatedCount(room),
        capacity: SEATS,
        state: room.game.state,
      };
    }
    return out;
  }

  // Per-recipient room view. Only the recipient's own hand is included.
  roomView(room, sid) {
    const players = {};
    for (const [psid, p] of Object.entries(room.sockets)) {
      players[psid] = {
        nickname: p.nickname,
        seat: p.seat,
        ready: p.ready,
        spectator: p.spectator,
        connected: p.connected,
        points: p.points,
        handCount: p.hand.length,
        role: room.game.roles ? room.game.roles[psid] || null : null,
      };
    }
    const you = room.sockets[sid];
    return {
      name: room.name,
      hide: room.hide,
      you: sid,
      seats: room.seats,
      players,
      hand: you ? you.hand.slice() : [],
      state: room.game.state,
      round: room.game.round,
      cur_order_idx: room.game.cur_order_idx,
      order: room.game.order,
      last: room.game.last,
      roles: room.game.roles,
      socialOrder: room.game.socialOrder,
      leaderBoard: room.leaderBoard,
      phase: room.phase || null,
    };
  }

  broadcastRoom(room) {
    for (const sid of Object.keys(room.sockets)) {
      this.io.to(sid).emit("refresh game room", this.roomView(room, sid));
    }
  }

  broadcastLobby() {
    this.io.to("waiting room").emit("refresh waiting room", this.lobbyView(), this.userCount);
  }

  alert(socket, key) {
    socket.emit("alert", key);
  }

  clearPhase(room) {
    const t = this.timers.get(room.name);
    if (t) {
      clearTimeout(t);
      this.timers.delete(room.name);
    }
    room.phase = null;
  }

  // ---- socket wiring ------------------------------------------------------

  // True when the socket may perform room actions. When authentication is
  // required, only logged-in sockets qualify; otherwise (tests) everything does.
  ensureAuth(socket) {
    if (!this.requireAuth) return true;
    if (socket.userData.userId) return true;
    this.alert(socket, "language.authRequired");
    return false;
  }

  attach(socket) {
    this.userCount++;
    const account = this.sessionUser(socket);
    socket.userData = new Player(
      account ? account.username : "Guest" + this.connectNumber,
      "waiting room"
    );
    socket.userData.sid = socket.id;
    socket.userData.token = crypto.randomBytes(16).toString("hex");
    socket.userData.userId = account ? account.id : null;
    socket.userData.authUsername = account ? account.username : null;
    this.connectNumber++;
    this.tokens.set(socket.userData.token, { room: null, sid: socket.id });
    socket.join("waiting room");

    socket.emit("update sender", this.senderView(socket));
    this.broadcastLobby();
    this.log.log("NEW:", socket.userData.nickname, "connected");

    socket.on("init", () => {
      socket.emit("update sender", this.senderView(socket));
    });

    socket.on("reconnect", (token) => {
      if (typeof token !== "string") return;
      if (this.reconnect(socket, token)) {
        socket.emit("update sender", this.senderView(socket));
      }
    });

    socket.on("set new nickname", (rawNickname, roomId) => {
      // An authenticated player's display name is their account name.
      const nickname = socket.userData.authUsername || sanitizeNickname(rawNickname);
      if (!nickname) return this.alert(socket, "language.badNickname");
      socket.userData.nickname = nickname;
      if (typeof roomId === "string" && this.roomEntry(roomId)) {
        if (!this.ensureAuth(socket)) return;
        this.joinRoom(socket, roomId);
      }
      socket.emit("update sender", this.senderView(socket));
    });

    socket.on("create game room", (rawName, hide) => {
      if (!this.ensureAuth(socket)) return;
      if (!this.allowRoom(socket.id)) return this.alert(socket, "language.rateLimited");
      if (this.roomCount() >= MAX_ROOMS) return this.alert(socket, "language.tooManyRooms");
      const name = sanitizeRoomName(rawName);
      if (!name) return this.alert(socket, "language.badRoomName");
      this.roomNumber++;
      const idRoom = `${this.roomNumber}-${name}`;
      this.createRoom(idRoom, !!hide);
      this.joinRoom(socket, idRoom);
      socket.emit("connectUrl", `/room/${encodeURIComponent(idRoom)}`);
    });

    socket.on("join game room", (roomId) => {
      if (!this.ensureAuth(socket)) return;
      if (typeof roomId !== "string" || !this.roomEntry(roomId)) {
        this.alert(socket, "language.noRoom");
        return this.broadcastLobby();
      }
      this.joinRoom(socket, roomId);
      socket.emit("connectUrl", `/room/${encodeURIComponent(roomId)}`);
    });

    socket.on("leave room", () => {
      this.leaveRoom(socket);
      socket.emit("connectUrl", "/");
    });

    socket.on("chat message", (rawMsg) => {
      if (!this.allowChat(socket.id)) return this.alert(socket, "language.rateLimited");
      const msg = sanitizeChat(rawMsg);
      if (!msg) return;
      const room = socket.userData.cur_room;
      if (room === "waiting room") {
        this.io.to("waiting room").emit("chat message", socket.userData.nickname, msg, socket.id);
      } else {
        this.io.to(room).emit("chat message", socket.userData.nickname, msg, socket.id);
      }
    });

    socket.on("ready", () => this.toggleReady(socket));
    socket.on("play", (selected_card) => this.play(socket, selected_card));
    socket.on("declare revolution", () => this.declareRevolution(socket));
    socket.on("tax", (selection) => this.submitTax(socket, selection));
    socket.on("disconnect", () => this.disconnect(socket));
  }

  senderView(socket) {
    return {
      nickname: socket.userData.nickname,
      cur_room: socket.userData.cur_room,
      seat: socket.userData.seat,
      ready: socket.userData.ready,
      spectator: socket.userData.spectator,
      token: socket.userData.token,
    };
  }

  // ---- rooms --------------------------------------------------------------

  createRoom(name, hide) {
    const room = {
      name,
      hide,
      seats: new Array(SEATS).fill(false),
      sockets: {},
      game: new Game(),
      leaderBoard: null,
      finishedOrder: [],
      phase: null,
      createdAt: Date.now(),
    };
    (hide ? this.rooms.hide : this.rooms.open)[name] = room;
    return room;
  }

  joinRoom(socket, name) {
    const entry = this.roomEntry(name);
    if (!entry) return false;
    const { room } = entry;
    const isReturning = !!room.sockets[socket.id];

    socket.leave("waiting room");
    socket.join(name);
    socket.userData.cur_room = name;

    let seat = -1;
    for (let i = 0; i < SEATS; i++) {
      if (!room.seats[i]) {
        seat = i;
        break;
      }
    }
    if (seat === -1) {
      // Room full: join as a spectator instead of being rejected.
      socket.userData.spectator = true;
      socket.userData.seat = -1;
      room.sockets[socket.id] = socket.userData;
      this.io.to(name).emit("chat connection", this.playerView(socket.userData));
      this.broadcastRoom(room);
      this.log.log(socket.userData.nickname + " spectating " + name);
      return true;
    }

    room.seats[seat] = true;
    socket.userData.seat = seat;
    socket.userData.spectator = false;
    room.sockets[socket.id] = socket.userData;
    this.tokens.set(socket.userData.token, { room: name, sid: socket.id });

    if (!isReturning) {
      this.io.to(name).emit("chat connection", this.playerView(socket.userData));
    }
    this.broadcastRoom(room);
    this.broadcastLobby();
    socket.emit("update sender", this.senderView(socket));
    this.log.log(socket.userData.nickname + " joined " + name);
    return true;
  }

  playerView(p) {
    return {
      nickname: p.nickname,
      seat: p.seat,
      spectator: p.spectator,
      connected: p.connected,
    };
  }

  leaveRoom(socket) {
    const name = socket.userData.cur_room;
    const entry = name !== "waiting room" ? this.roomEntry(name) : null;
    if (entry) this.removeFromRoom(socket, entry.room, entry.store);
    socket.userData.leaveRoom();
    socket.join("waiting room");
    this.broadcastLobby();
  }

  removeFromRoom(socket, room, store) {
    socket.leave(room.name);
    if (room.sockets[socket.id]) {
      if (room.sockets[socket.id].seat >= 0) room.seats[room.sockets[socket.id].seat] = false;
      delete room.sockets[socket.id];
    }
    this.tokens.delete(socket.userData.token);

    if (room.game.state === game_state.PLAYING) {
      const seat = socket.userData.seat;
      room.game.updateOrder(seat);
      if (room.game.cur_order_idx === seat) room.game.nextPlayer({});
      if (room.game.isOneLeft()) this.finishGame(room);
    }

    if (Object.keys(room.sockets).length === 0) {
      delete store[room.name];
      this.clearPhase(room);
      return;
    }
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  disconnect(socket) {
    this.userCount--;
    this.log.log("DISCONNECTED:", socket.userData.nickname);
    const name = socket.userData.cur_room;
    const entry = name !== "waiting room" ? this.roomEntry(name) : null;
    if (entry) {
      // Keep the seat and hand so the player can reconnect with their token.
      socket.userData.connected = false;
      this.broadcastRoom(entry.room);
    }
    this.broadcastLobby();
  }

  // Re-bind a reconnecting socket to the room/seat it held before the drop.
  reconnect(socket, token) {
    const session = this.tokens.get(token);
    if (!session || !session.room) return false;
    const entry = this.roomEntry(session.room);
    if (!entry) {
      this.tokens.delete(token);
      return false;
    }
    const { room } = entry;
    // Find the previous session for this token and carry its game state over.
    let previous = null;
    for (const [sid, p] of Object.entries(room.sockets)) {
      if (p.token === token && sid !== socket.id) {
        previous = p;
        delete room.sockets[sid];
      }
    }
    if (previous) {
      socket.userData.seat = previous.seat;
      socket.userData.hand = previous.hand;
      socket.userData.ready = previous.ready;
      socket.userData.points = previous.points;
      socket.userData.pointsReceived = previous.pointsReceived;
      socket.userData.spectator = previous.spectator;
      if (room.game.roles && previous.sid) {
        room.game.roles[socket.id] = room.game.roles[previous.sid];
        delete room.game.roles[previous.sid];
      }
    }
    socket.leave("waiting room");
    socket.join(session.room);
    socket.userData.cur_room = session.room;
    socket.userData.connected = true;
    socket.userData.sid = socket.id;
    room.sockets[socket.id] = socket.userData;
    this.tokens.set(token, { room: session.room, sid: socket.id });
    this.broadcastRoom(room);
    socket.emit("update sender", this.senderView(socket));
    return true;
  }

  // ---- readiness / game start ---------------------------------------------

  toggleReady(socket) {
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    if (room.game.state !== game_state.WAITING || room.phase) {
      return this.alert(socket, "language.cheat");
    }
    if (socket.userData.spectator) return this.alert(socket, "language.cheat");

    socket.userData.ready = !socket.userData.ready;
    this.broadcastRoom(room);

    if (
      this.seatedCount(room) >= 2 &&
      this.readyCount(room) === this.seatedCount(room) &&
      room.game.state === game_state.WAITING
    ) {
      this.startGame(room);
    }
  }

  startGame(room) {
    this.clearPhase(room);
    const ready = this.players(room).filter((p) => p.ready && !p.spectator);

    // Social order: previous finishing order, or a draw for the first hand.
    let socialOrder;
    if (room.leaderBoard && room.leaderBoard.length) {
      socialOrder = room.leaderBoard.map((row) => row.sid).filter((sid) => room.sockets[sid]);
    } else {
      socialOrder = engine.drawForOrder(ready.map((p) => p.sid), this.rng);
    }

    // Re-seat by social order so the Greater Dalmuti sits first.
    room.seats = new Array(SEATS).fill(false);
    socialOrder.forEach((sid, i) => {
      const p = room.sockets[sid];
      if (p) {
        p.seat = i;
        room.seats[i] = true;
      }
    });

    room.finishedOrder = [];
    for (const p of this.players(room)) {
      p.hand = [];
      p.pointsReceived = false;
    }

    room.game.begin(
      { sockets: Object.fromEntries(socialOrder.map((sid) => [sid, room.sockets[sid]])) },
      socialOrder
    );
    // Hold in a non-WAITING, non-PLAYING state while revolution/taxes resolve
    // so the readiness check cannot start a second game.
    room.game.state = game_state.TAXATION;

    const deck = engine.shuffle(room.game.deck, this.rng);
    room.game.deck = deck;
    const hands = engine.deal(deck, socialOrder);
    for (const sid of socialOrder) room.sockets[sid].hand = hands[sid].slice();

    this.io.to(room.name).emit("chat announce", "language.started", "blue");

    const candidates = engine.revolutionCandidates(
      Object.fromEntries(socialOrder.map((sid) => [sid, room.sockets[sid].hand])),
      room.game.roles
    );
    if (candidates.length) {
      this.beginRevolutionPhase(room, candidates);
    } else {
      this.beginTaxPhase(room);
    }
  }

  // ---- revolution ---------------------------------------------------------

  beginRevolutionPhase(room, candidates) {
    room.phase = {
      type: "revolution",
      deadline: Date.now() + this.revolutionWindowMs,
      candidates: candidates.map((c) => ({ sid: c.sid, greater: c.greater })),
      declared: null,
    };
    // Refresh hands before prompting so the client has the dealt cards.
    this.broadcastRoom(room);
    for (const c of candidates) {
      this.io.to(c.sid).emit("revolution phase", { greater: c.greater, deadline: room.phase.deadline });
    }
    const timer = setTimeout(() => {
      if (!room.phase || room.phase.type !== "revolution") return;
      this.resolveRevolution(room, room.phase.declared);
    }, this.revolutionWindowMs);
    this.timers.set(room.name, timer);
  }

  declareRevolution(socket) {
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    if (!room.phase || room.phase.type !== "revolution") return;
    const cand = room.phase.candidates.find((c) => c.sid === socket.id);
    if (!cand) return this.alert(socket, "language.cheat");
    this.clearPhase(room);
    this.resolveRevolution(room, { sid: socket.id, greater: cand.greater });
  }

  resolveRevolution(room, declared) {
    this.clearPhase(room);
    if (!declared) {
      this.io.to(room.name).emit("chat announce", "language.noRevolution", "black");
      return this.beginTaxPhase(room);
    }

    if (declared.greater) {
      room.game.socialOrder = engine.reverseOrder(room.game.socialOrder);
      room.game.roles = engine.computeRoles(room.game.socialOrder);
      room.seats = new Array(SEATS).fill(false);
      room.game.socialOrder.forEach((sid, i) => {
        const p = room.sockets[sid];
        if (p) {
          p.seat = i;
          room.seats[i] = true;
        }
      });
      room.game.cur_order = new Array(SEATS).fill(-1);
      room.game.order = new Array(SEATS).fill(false);
      room.game.socialOrder.forEach((sid) => {
        const p = room.sockets[sid];
        room.game.order[p.seat] = true;
        room.game.cur_order[p.seat] = 1;
      });
      room.game.cur_order_idx = room.sockets[room.game.socialOrder[0]].seat;
      this.io.to(room.name).emit("chat announce", "language.greaterRevolution", "red");
    } else {
      this.io.to(room.name).emit("chat announce", "language.revolution", "orange");
    }
    // A revolution cancels taxation, so play begins immediately.
    this.beginPlaying(room);
  }

  // ---- taxes --------------------------------------------------------------

  beginTaxPhase(room) {
    const taxes = engine.computeTaxes(room.game.roles);
    if (!taxes.length) return this.beginPlaying(room);

    room.phase = {
      type: "tax",
      deadline: Date.now() + this.taxWindowMs,
      taxes,
      submissions: {},
    };
    // Push the fresh (post-deal) hand to every client before the tax prompt, so
    // the prompt can render the correct cards.
    this.broadcastRoom(room);
    for (const tax of taxes) {
      const from = room.sockets[tax.from];
      const to = room.sockets[tax.to];
      if (from) {
        this.io.to(tax.from).emit("tax phase", {
          kind: tax.kind,
          role: "peon",
          count: tax.count,
          partner: to ? to.nickname : "",
          deadline: room.phase.deadline,
        });
      }
      if (to) {
        this.io.to(tax.to).emit("tax phase", {
          kind: tax.kind,
          role: "dalmuti",
          count: tax.count,
          partner: from ? from.nickname : "",
          deadline: room.phase.deadline,
        });
      }
    }
    const timer = setTimeout(() => this.resolveTaxes(room), this.taxWindowMs);
    this.timers.set(room.name, timer);
  }

  submitTax(socket, selection) {
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    if (!room.phase || room.phase.type !== "tax") return;
    const tax = room.phase.taxes.find(
      (t) => t.from === socket.id || t.to === socket.id
    );
    if (!tax) return this.alert(socket, "language.cheat");

    const normalized = engine.validateSelection(selection);
    if (!normalized) return this.alert(socket, "language.wrongCard");
    const cards = [];
    for (const [card, count] of Object.entries(normalized)) {
      for (let i = 0; i < count; i++) cards.push(Number(card));
    }
    if (cards.length !== tax.count) return this.alert(socket, "language.wrongCard");
    if (!engine.checkValidity(room.sockets[socket.id].hand, normalized)) {
      return this.alert(socket, "language.wrongCard");
    }

    const side = socket.id === tax.from ? "from" : "to";
    room.phase.submissions[`${tax.kind}:${side}`] = { sid: socket.id, cards };

    // Resolve as soon as every party has submitted.
    const need = room.phase.taxes.length * 2;
    if (Object.keys(room.phase.submissions).length >= need) this.resolveTaxes(room);
    else this.broadcastRoom(room);
  }

  resolveTaxes(room) {
    const phase = room.phase;
    if (!phase || phase.type !== "tax") return;
    this.clearPhase(room);

    const swaps = [];
    for (const tax of phase.taxes) {
      const fromPlayer = room.sockets[tax.from];
      const toPlayer = room.sockets[tax.to];
      if (!fromPlayer || !toPlayer) continue;

      const fromSub = phase.submissions[`${tax.kind}:from`];
      const toSub = phase.submissions[`${tax.kind}:to`];

      const peonCards =
        fromSub && fromSub.cards.length === tax.count
          ? fromSub.cards
          : engine.peonBestCards(fromPlayer.hand, tax.count);
      const dalmutiCards =
        toSub && toSub.cards.length === tax.count
          ? toSub.cards
          : engine.dalmutiWorstCards(toPlayer.hand, tax.count);

      swaps.push({ tax, fromPlayer, toPlayer, peonCards, dalmutiCards });
    }

    // Apply all swaps simultaneously from the pre-tax hands.
    for (const s of swaps) {
      const fromHand = engine.removeCards(s.fromPlayer.hand, s.peonCards);
      const toHand = engine.removeCards(s.toPlayer.hand, s.dalmutiCards);
      s.fromPlayer.hand = fromHand.concat(s.dalmutiCards).sort((a, b) => a - b);
      s.toPlayer.hand = toHand.concat(s.peonCards).sort((a, b) => a - b);
    }

    for (const s of swaps) {
      this.io.to(room.name).emit(
        "chat announce",
        "language.swap",
        "blue",
        s.toPlayer.nickname,
        s.fromPlayer.nickname
      );
      this.io.to(s.tax.to).emit("chat announce taxs", "language.taxs", "green",
        s.peonCards.join(" & "), s.dalmutiCards.join(" & "));
      this.io.to(s.tax.from).emit("chat announce taxs", "language.taxs", "red",
        s.dalmutiCards.join(" & "), s.peonCards.join(" & "));
    }

    this.beginPlaying(room);
  }

  beginPlaying(room) {
    this.clearPhase(room);
    room.game.state = game_state.PLAYING;
    this.broadcastRoom(room);
  }

  // ---- play ---------------------------------------------------------------

  play(socket, selected_card) {
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    const game = room.game;

    if (game.state !== game_state.PLAYING) return this.alert(socket, "language.cheat");
    const me = room.sockets[socket.id];
    if (!me || me.seat < 0 || game.cur_order_idx !== me.seat) {
      return this.alert(socket, "language.waitTurn");
    }

    const selection = engine.validateSelection(selected_card);
    if (!selection) return this.alert(socket, "language.wrongCard");
    const count = engine.selectionCount(selection);

    // Pass.
    if (count === 0) {
      if (!game.last) return this.alert(socket, "language.mustPlay");
      game.cur_order[me.seat] = 0;
      game.nextPlayer({});
      this.broadcastRoom(room);
      return;
    }

    if (!engine.checkValidity(me.hand, selection)) return this.alert(socket, "language.wrongCard");
    if (!engine.checkRule(game.last, selection)) return this.alert(socket, "language.wrongCard");

    me.hand = engine.applyPlay(me.hand, selection);

    // Restore everyone who had passed now that a new play was made.
    for (let i = 0; i < game.cur_order.length; i++) {
      if (game.cur_order[i] === 0) game.cur_order[i] = 1;
    }

    if (me.hand.length === 0) {
      game.updateOrder(me.seat);
      room.finishedOrder.push(socket.id);
      this.io.to(room.name).emit("chat announce", "language.finished", "green", me.nickname);
      if (game.isOneLeft()) {
        this.finishGame(room);
        return;
      }
    }

    game.nextPlayer(selection);
    this.broadcastRoom(room);
  }

  finishGame(room) {
    const stillIn = Object.entries(room.sockets)
      .filter(([sid, p]) => p.ready && !p.spectator && !room.finishedOrder.includes(sid))
      .map(([sid]) => sid);
    const order = room.finishedOrder.concat(stillIn);
    const total = order.length;
    const roles = engine.computeRoles(order);
    room.leaderBoard = order.map((sid, i) => ({
      sid,
      nickname: room.sockets[sid] ? room.sockets[sid].nickname : "",
      points: total - i,
      role: engine.roleOf(roles, sid),
    }));

    this.io.to(room.name).emit("chat announce", "language.ended", "red");
    room.game.end();
    for (const p of this.players(room)) p.reset();
    room.phase = null;
    this.broadcastRoom(room);
    this.broadcastLobby();
  }
}

module.exports = { RoomManager, MAX_ROOMS };
