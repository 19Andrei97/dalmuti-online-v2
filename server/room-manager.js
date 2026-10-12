"use strict";

const crypto = require("crypto");
const { Player, Game, game_state, SEATS } = require("./config");
const engine = require("./game-engine");
const bot = require("./bot");
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
    this.botTimers = new Map(); // room name -> pending bot action timer
    this.botDelayMs = opts.botDelayMs != null ? opts.botDelayMs : 700;
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

  botsIn(room) {
    return this.players(room).filter((p) => p.isBot);
  }

  humanSeatedCount(room) {
    return this.players(room).filter((p) => !p.spectator && !p.isBot).length;
  }

  // ---- bots ---------------------------------------------------------------

  // Run a bot action after a short, human-like delay. Timers are tracked per
  // room so they can be cancelled when the room empties or a game ends.
  scheduleBot(room, fn) {
    const timer = setTimeout(() => {
      this.botTimers.delete(room.name);
      fn();
    }, this.botDelayMs);
    if (timer.unref) timer.unref();
    this.botTimers.set(room.name, timer);
  }

  clearBotTimers(room) {
    const t = this.botTimers.get(room.name);
    if (t) {
      clearTimeout(t);
      this.botTimers.delete(room.name);
    }
  }

  // Decide what the bot currently on turn should do, then apply it exactly as a
  // client play would.
  runBotTurn(room) {
    if (room.game.state !== game_state.PLAYING || room.phase) return;
    const idx = room.game.cur_order_idx;
    const entry = Object.entries(room.sockets).find(
      ([, p]) => p.isBot && p.seat === idx
    );
    if (!entry) return;
    const sid = entry[0];
    const me = room.sockets[sid];
    const selection = bot.choosePlay(me.hand, room.game.last, me.difficulty, this.rng);

    if (!selection) {
      // A leader must play when they can; only an empty hand may pass.
      if (room.game.last || me.hand.length === 0) {
        room.game.cur_order[me.seat] = 0;
        room.game.nextPlayer({}, null, room);
        this.broadcastRoom(room);
      }
    } else {
      this.applyPlay(room, sid, selection);
    }
    this.scheduleNextBotTurn(room);
  }

  // Queue a bot turn if the player now on turn is a bot (single-shot per room).
  scheduleNextBotTurn(room) {
    if (room.game.state !== game_state.PLAYING || room.phase) return;
    if (this.botTimers.has(room.name)) return;
    const idx = room.game.cur_order_idx;
    const isBot = Object.values(room.sockets).some((p) => p.isBot && p.seat === idx);
    if (!isBot) return;
    this.scheduleBot(room, () => this.runBotTurn(room));
  }

  // Public lobby view of a room (no hands). Private rooms live in a separate
  // map and are deliberately never listed here.
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
        isBot: !!p.isBot,
        difficulty: p.difficulty || null,
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
      shown: room.game.shown,
      roles: room.game.roles,
      socialOrder: room.game.socialOrder,
      leaderBoard: room.leaderBoard,
      phase: room.phase || null,
      host: room.hostSid || null,
      canAddBot: this.seatedCount(room) < SEATS,
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

    socket.on("create game room", (rawName, hide, noTax) => {
      if (!this.ensureAuth(socket)) return;
      if (!this.allowRoom(socket.id)) return this.alert(socket, "language.rateLimited");
      if (this.roomCount() >= MAX_ROOMS) return this.alert(socket, "language.tooManyRooms");
      const name = sanitizeRoomName(rawName);
      if (!name) return this.alert(socket, "language.badRoomName");
      this.roomNumber++;
      const idRoom = `${this.roomNumber}-${name}`;
      this.createRoom(idRoom, !!hide, socket.id, !!noTax);
      this.joinRoom(socket, idRoom);
      socket.emit("connectUrl", `/room/${encodeURIComponent(idRoom)}`);
    });

    socket.on("add bot", (difficulty) => this.addBot(socket, difficulty));
    socket.on("fill bots", (difficulty) => this.fillBots(socket, difficulty));
    socket.on("remove bot", (botSid) => this.removeBot(socket, botSid));

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

  createRoom(name, hide, hostSid = null, noTax = false) {
    const room = {
      name,
      hide,
      seats: new Array(SEATS).fill(false),
      sockets: {},
      game: new Game(),
      leaderBoard: null,
      finishedOrder: [],
      phase: null,
      hostSid,
      // House rule: skip the very first taxation, so the first hand has no
      // Dalmuti/Peon seats (blank heraldry) and play starts immediately.
      noTaxFirstRound: !!noTax,
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

  // ---- bots ---------------------------------------------------------------

  // Add a bot to the host's room. Bots are auto-ready and never rejoin, so they
  // are simply stored like a seat-holding player (without a socket).
  addBot(socket, difficulty) {
    if (!this.ensureAuth(socket)) return;
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return this.alert(socket, "language.noRoom");
    const { room } = entry;

    if (room.hostSid !== socket.id) return this.alert(socket, "language.notHost");
    if (room.game.state !== game_state.WAITING || room.phase) {
      return this.alert(socket, "language.botNotNow");
    }
    if (!bot.isDifficulty(difficulty)) return this.alert(socket, "language.badBot");

    const seat = room.seats.indexOf(false);
    if (seat === -1) return this.alert(socket, "language.roomFull");

    const sid = `bot-${crypto.randomBytes(8).toString("hex")}`;
    const p = new Player(this.botName(difficulty), room.name);
    p.sid = sid;
    p.seat = seat;
    p.ready = true;
    p.isBot = true;
    p.difficulty = difficulty;
    p.connected = true;

    room.seats[seat] = true;
    room.sockets[sid] = p;

    this.io.to(room.name).emit("chat connection", this.playerView(p));
    this.broadcastRoom(room);
    this.maybeAutoStart(room);
  }

  // Remove a bot from the room. Any seated human may do so while waiting.
  removeBot(socket, botSid) {
    if (!this.ensureAuth(socket)) return;
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    if (room.game.state !== game_state.WAITING || room.phase) {
      return this.alert(socket, "language.botNotNow");
    }
    const p = room.sockets[botSid];
    if (!p || !p.isBot) return this.alert(socket, "language.badBot");

    room.seats[p.seat] = false;
    delete room.sockets[botSid];
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  // Fill every empty seat with a bot of the host's chosen difficulty.
  fillBots(socket, difficulty) {
    if (!this.ensureAuth(socket)) return;
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return this.alert(socket, "language.noRoom");
    const { room } = entry;
    if (room.hostSid !== socket.id) return this.alert(socket, "language.notHost");
    if (room.game.state !== game_state.WAITING || room.phase) {
      return this.alert(socket, "language.botNotNow");
    }
    const diff = bot.isDifficulty(difficulty) ? difficulty : bot.DIFFICULTY.MEDIUM;
    while (this.seatedCount(room) < SEATS) {
      if (room.seats.indexOf(false) === -1) break;
      this.addBot(socket, diff);
    }
  }

  botName(difficulty) {
    this.botSeq = (this.botSeq || 0) + 1;
    return `Bot ${this.botSeq}`;
  }

  // Start the hand once a human is present and every seated player (humans
  // included) is ready. Bots are always ready, so adding them alone never
  // starts the game - the host readies up when the table is set.
  maybeAutoStart(room) {
    if (room.game.state !== game_state.WAITING || room.phase) return;
    if (this.humanSeatedCount(room) < 1) return;
    if (this.seatedCount(room) < 2) return;
    if (this.readyCount(room) !== this.seatedCount(room)) return;
    this.startGame(room);
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
      if (room.game.cur_order_idx === seat) room.game.nextPlayer({}, null, room);
      if (room.game.isOneLeft()) this.finishGame(room);
      else this.scheduleNextBotTurn(room);
    }

    // Bots cannot exist without a human host, so drop the whole room (bots
    // included) once the last human leaves.
    const humans = Object.values(room.sockets).filter((p) => !p.isBot);
    if (humans.length === 0) {
      delete store[room.name];
      this.clearPhase(room);
      this.clearBotTimers(room);
      return;
    }
    // Hand the host role to another human if the host left.
    if (room.hostSid === socket.id) {
      room.hostSid = Object.values(room.sockets).find((p) => !p.isBot).sid;
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
      // The host keeps host rights across a reconnect (new socket id).
      if (room.hostSid === previous.sid) room.hostSid = socket.id;
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
    this.maybeAutoStart(room);
  }

  startGame(room) {
    this.clearPhase(room);
    this.clearBotTimers(room);
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
    } else if (room.noTaxFirstRound && room.game.round === 0) {
      // First-round house rule: no taxes and no roles yet — every seat stays a
      // plain citizen for this hand. Play begins straight away.
      room.game.roles = {};
      this.io.to(room.name).emit("chat announce", "language.noTaxFirst", "blue");
      this.beginPlaying(room);
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
      if (room.sockets[c.sid] && room.sockets[c.sid].isBot) continue;
      this.io.to(c.sid).emit("revolution phase", { greater: c.greater, deadline: room.phase.deadline });
    }
    // A bot that was dealt both Jokers always declares the revolution. Guard on
    // the phase so a human declaring first cannot be re-resolved by this timer.
    const botCandidate = candidates.find(
      (c) => room.sockets[c.sid] && room.sockets[c.sid].isBot
    );
    if (botCandidate) {
      this.scheduleBot(room, () => {
        if (!room.phase || room.phase.type !== "revolution") return;
        this.resolveRevolution(room, { sid: botCandidate.sid, greater: botCandidate.greater });
      });
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
      // Only the Dalmuti picks cards to return. The Peon's tribute is automatic:
      // the lowest cards (never a Joker) are sent, so the Peon is told rather
      // than prompted.
      if (to && !to.isBot) {
        this.io.to(tax.to).emit("tax phase", {
          kind: tax.kind,
          role: "dalmuti",
          count: tax.count,
          partner: from ? from.nickname : "",
          deadline: room.phase.deadline,
        });
      }
      if (from && !from.isBot) {
        this.io.to(tax.from).emit("tax owed", {
          kind: tax.kind,
          count: tax.count,
          partner: to ? to.nickname : "",
        });
      }
    }
    // Bots submit their tax choice automatically.
    if (taxes.some((t) => this.botInTax(room, t))) {
      this.scheduleBot(room, () => this.runBotTax(room));
    }
    const timer = setTimeout(() => this.resolveTaxes(room), this.taxWindowMs);
    this.timers.set(room.name, timer);
  }

  botInTax(room, tax) {
    // Only the Dalmuti side has a choice, so a bot only acts when it is the
    // Dalmuti. A bot Peon pays automatically in resolveTaxes.
    const to = room.sockets[tax.to];
    return !!(to && to.isBot);
  }

  // Have every bot Dalmuti submit its return cards at once, so a human partner
  // is never left waiting on the timer.
  runBotTax(room) {
    const phase = room.phase;
    if (!phase || phase.type !== "tax") return;
    for (const tax of phase.taxes) {
      const p = room.sockets[tax.to];
      if (!p || !p.isBot) continue;
      const key = `${tax.kind}:to`;
      if (phase.submissions[key]) continue;
      const cards = bot.chooseTax(p.hand, tax.count, "dalmuti", p.difficulty, this.rng);
      if (cards.length === tax.count) phase.submissions[key] = { sid: tax.to, cards };
    }
    const need = phase.taxes.length;
    if (Object.keys(phase.submissions).length >= need) this.resolveTaxes(room);
    else this.broadcastRoom(room);
  }

  submitTax(socket, selection) {
    const entry = this.roomEntry(socket.userData.cur_room);
    if (!entry) return;
    const { room } = entry;
    if (!room.phase || room.phase.type !== "tax") return;
    // Only the Dalmuti chooses; a Peon has no cards to pick.
    const tax = room.phase.taxes.find((t) => t.to === socket.id);
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

    room.phase.submissions[`${tax.kind}:to`] = { sid: socket.id, cards };

    // Resolve as soon as every Dalmuti has submitted.
    const need = room.phase.taxes.length;
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

      const toSub = phase.submissions[`${tax.kind}:to`];

      // The Peon always gives their lowest cards automatically.
      const peonCards = engine.peonBestCards(fromPlayer.hand, tax.count);
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
        s.dalmutiCards.join(" & "), s.peonCards.join(" & "));
      this.io.to(s.tax.from).emit("chat announce taxs", "language.taxs", "red",
        s.peonCards.join(" & "), s.dalmutiCards.join(" & "));
      // A dedicated, per-player confirmation so the Peon cannot miss that the
      // tax was paid (the swap can resolve in an instant).
      this.io.to(s.tax.from).emit("tax result", {
        role: "peon",
        partner: s.toPlayer.nickname,
        sent: s.peonCards.join(" & "),
        received: s.dalmutiCards.join(" & "),
      });
    }

    this.beginPlaying(room);
  }

  beginPlaying(room) {
    this.clearPhase(room);
    room.game.state = game_state.PLAYING;
    this.broadcastRoom(room);
    this.scheduleNextBotTurn(room);
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
      // Local echo only (not a room broadcast): passing is private to the
      // passer. A click on an empty selection is also how the client plays a
      // forced pass, so this is the single place a human pass is announced.
      socket.emit("chat announce", "language.passed", "black", me.nickname);
      game.nextPlayer({}, null, room);
      this.broadcastRoom(room);
      this.scheduleNextBotTurn(room);
      return;
    }

    if (!engine.checkValidity(me.hand, selection)) return this.alert(socket, "language.wrongCard");
    if (!engine.checkRule(game.last, selection)) return this.alert(socket, "language.wrongCard");

    this.applyPlay(room, socket.id, selection);
  }

  // Apply an already-validated play (from a human or a bot) and advance the turn.
  applyPlay(room, sid, selection) {
    const game = room.game;
    const me = room.sockets[sid];
    if (!me) return;

    me.hand = engine.applyPlay(me.hand, selection);

    // Restore everyone who had passed now that a new play was made.
    for (let i = 0; i < game.cur_order.length; i++) {
      if (game.cur_order[i] === 0) game.cur_order[i] = 1;
    }

    if (me.hand.length === 0) {
      game.updateOrder(me.seat);
      room.finishedOrder.push(sid);
      this.io.to(room.name).emit("chat announce", "language.finished", "green", me.nickname);
      if (game.isOneLeft()) {
        this.finishGame(room);
        return;
      }
    }

    game.nextPlayer(selection, sid, room);
    if (game.last) game.last.handCount = me.hand.length;
    // Keep the display copy in sync so the table shows the play (and marks a
    // finisher as the winner) until the next play replaces it.
    if (game.shown) game.shown.handCount = me.hand.length;
    this.broadcastRoom(room);
    this.scheduleNextBotTurn(room);
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
    this.clearBotTimers(room);
    room.game.end();
    for (const p of this.players(room)) p.reset();
    // Bots never send a ready event, so re-arm them for the next hand.
    for (const p of this.botsIn(room)) p.ready = true;
    room.phase = null;
    this.broadcastRoom(room);
    this.broadcastLobby();
  }
}

module.exports = { RoomManager, MAX_ROOMS };
