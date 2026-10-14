"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { io: ioClient } = require("socket.io-client");

const { createServer } = require("../app");
const { ROLE, JOKER } = require("../server/game-engine");

// Deterministic rng so the draw/deal never hits a degenerate tie loop.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const silent = { log() {}, error() {} };

async function startServer(overrides = {}) {
  const dbPath = path.join(os.tmpdir(), `dalmuti-test-${Date.now()}-${Math.random()}.db`);
  const server = createServer({
    dbPath,
    rng: seededRng(12345),
    log: silent,
    taxWindowMs: 5000,
    revolutionWindowMs: 5000,
    // The suite exercises the account system, so default it on. Guest-mode
    // tests pass authEnabled: false explicitly.
    authEnabled: true,
    ...overrides,
  });
  await new Promise((r) => server.httpServer.listen(0, r));
  const port = server.httpServer.address().port;
  return {
    server,
    port,
    async stop() {
      await server.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(dbPath + suffix); } catch (e) { /* ignore */ }
      }
    },
  };
}

let userSeq = 0;

async function registerUser(port, username) {
  const res = await fetch(`http://localhost:${port}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  if (!res.ok) throw new Error("register failed: " + res.status);
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

// Connect a socket. Unless { anon: true }, register a throwaway account first
// and carry its session cookie, matching how the real client authenticates.
async function connect(port, opts = {}) {
  let cookie = "";
  if (!opts.anon) {
    const name = "u" + ++userSeq + "_" + Math.floor(Math.random() * 1e6);
    cookie = await registerUser(port, name);
  }
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : {},
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Deterministically resolve whichever start-of-hand phase is active, instead of
// waiting for the tax/revolution timer.
function settlePhases(manager, room) {
  if (room.phase && room.phase.type === "revolution") {
    manager.resolveRevolution(room, null);
  }
  if (room.phase && room.phase.type === "tax") {
    manager.resolveTaxes(room);
  }
}

test("lobby view never leaks hands", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await once(a, "refresh waiting room");
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Lobby", false);
    await delay(50);
    b.emit("join game room", Object.keys(ctx.server.manager.rooms.open)[0]);
    await delay(50);

    const view = ctx.server.manager.lobbyView();
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("hand"), false);
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("private rooms are absent from the lobby view", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    await delay(30);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Public", false);
    a.emit("create game room", "Secret", true);
    await delay(80);

    const view = ctx.server.manager.lobbyView();
    assert.equal(Object.keys(view).includes("1-Public"), true);
    assert.equal(Object.keys(view).includes("2-Secret"), false);
    a.close();
  } finally {
    await ctx.stop();
  }
});

test("room view reports who played last and how many cards they held", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "LastPlay", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(50);
    a.emit("ready");
    b.emit("ready");
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    settlePhases(ctx.server.manager, room);
    const leaderId = room.game.socialOrder[0];
    const leaderSock = leaderId === a.id ? a : b;
    room.sockets[leaderId].hand = [1, 12];
    room.game.cur_order_idx = room.sockets[leaderId].seat;
    room.game.last = null;

    leaderSock.emit("play", { 1: 1 });
    await delay(80);

    const view = ctx.server.manager.roomView(room, leaderId);
    assert.equal(view.last.num, 1);
    assert.equal(view.last.count, 1);
    assert.equal(view.last.by, leaderId);
    assert.equal(view.last.handCount, room.sockets[leaderId].hand.length);
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("per-recipient room view only contains the recipient's hand", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(30);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Room1", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(50);

    const room = ctx.server.manager.rooms.open[roomName];
    room.sockets[a.id].hand = [1, 2, 3];
    room.sockets[b.id].hand = [4, 5, 6];

    const viewA = ctx.server.manager.roomView(room, a.id);
    assert.deepEqual(viewA.hand, [1, 2, 3]);
    // No player entry may carry a hand; only counts are exposed.
    for (const p of Object.values(viewA.players)) {
      assert.equal("hand" in p, false);
      assert.equal(typeof p.handCount, "number");
    }
    assert.equal(viewA.players[b.id].handCount, 3);
    assert.equal("hand" in viewA.players[b.id], false);
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("starting a game deals all 80 cards with the true distribution", async () => {
  const ctx = await startServer();
  try {
    const sockets = [];
    for (let i = 0; i < 7; i++) sockets.push(await connect(ctx.port));
    await delay(50);
    sockets[0].emit("set new nickname", "P0", "");
    sockets[0].emit("create game room", "Deal", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    for (let i = 1; i < 7; i++) {
      sockets[i].emit("set new nickname", "P" + i, "");
      sockets[i].emit("join game room", roomName);
    }
    await delay(100);
    for (const s of sockets) s.emit("ready");
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    settlePhases(ctx.server.manager, room);
    const hands = Object.values(room.sockets).map((p) => p.hand);
    const total = hands.reduce((n, h) => n + h.length, 0);
    assert.equal(total, 80, "all cards dealt");
    const sizes = hands.map((h) => h.length).sort((a, b) => a - b);
    assert.deepEqual(sizes, [11, 11, 11, 11, 12, 12, 12]);
    for (const s of sockets) s.close();
  } finally {
    await ctx.stop();
  }
});

test("a full game: taxes are player-chosen, play works, game finishes", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Full", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(50);
    a.emit("ready");
    b.emit("ready");
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    settlePhases(ctx.server.manager, room);
    assert.equal(room.game.state, 1, "playing after taxes");

    // Hand-craft hands so the test is deterministic.
    const aId = a.id;
    const bId = b.id;
    room.sockets[aId].hand = [1, 2];
    room.sockets[bId].hand = [11, 12];
    const leaderId = room.game.socialOrder[0];
    const followerId = room.game.socialOrder[1];

    // Leader plays a single 1 (the Great Dalmuti card).
    const leaderSock = leaderId === aId ? a : b;
    const followerSock = followerId === aId ? a : b;
    room.sockets[leaderId].hand = [1, 12];
    room.sockets[followerId].hand = [11, 12];
    room.game.cur_order_idx = room.sockets[leaderId].seat;
    room.game.last = null;

    leaderSock.emit("play", { 1: 1 });
    await delay(80);
    assert.equal(room.sockets[leaderId].hand.includes(1), false, "leader played the 1");

    // Follower cannot beat a 1, so passes, ending the round.
    followerSock.emit("play", {});
    await delay(80);

    // Leader now holds only the 12; play it to finish.
    room.game.cur_order_idx = room.sockets[leaderId].seat;
    leaderSock.emit("play", { 12: 1 });
    await delay(120);

    assert.equal(room.game.state, 0, "game ended when one player remained");
    assert.ok(room.leaderBoard, "leaderboard produced");
    assert.equal(room.leaderBoard[0].sid, leaderId);
    assert.equal(room.leaderBoard[0].role, ROLE.GREATER_DALMUTI);
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("a room created with a target score carries it and can end a session", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    b.emit("set new nickname", "Bob", "");
    // 5th argument is the session target (default 15).
    a.emit("create game room", "Session", false, false, 4);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("join game room", roomName);
    await delay(50);

    const room = ctx.server.manager.rooms.open[roomName];
    assert.equal(room.targetPoints, 4, "target stored on the room");
    const view = ctx.server.manager.roomView(room, a.id);
    assert.equal(view.targetPoints, 4, "target exposed in the room view");
    assert.equal(view.sessionOver, false);

    // Force a finished hand and assert the session ends (4 seats, target 4:
    // the winner of a two-player hand scores 2, so seed one player at 3 first).
    room.sockets[a.id].points = 3;
    room.finishedOrder = [a.id, b.id];
    ctx.server.manager.finishGame(room);
    assert.equal(room.sessionOver, true, "a player reached the target");
    assert.equal(ctx.server.manager.roomView(room, a.id).sessionOver, true);

    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("passing on an empty field is rejected server-side", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Pass", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(50);
    a.emit("ready");
    b.emit("ready");
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    settlePhases(ctx.server.manager, room);
    const leaderId = room.game.socialOrder[0];
    const leaderSock = leaderId === a.id ? a : b;
    room.game.cur_order_idx = room.sockets[leaderId].seat;
    room.game.last = null;

    const alertPromise = once(leaderSock, "alert");
    leaderSock.emit("play", {});
    const key = await alertPromise;
    assert.equal(key, "language.mustPlay");
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("malformed selections are rejected and cannot alter hands", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Bad", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(50);
    a.emit("ready");
    b.emit("ready");
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    settlePhases(ctx.server.manager, room);
    const leaderId = room.game.socialOrder[0];
    const leaderSock = leaderId === a.id ? a : b;
    room.game.cur_order_idx = room.sockets[leaderId].seat;
    room.game.last = null;
    const before = room.sockets[leaderId].hand.slice();

    const bad = [
      { 1: -1 },
      { 1: 1.5 },
      { 14: 1 },
      { __proto__: { polluted: true } },
      "not-an-object",
      [{ 1: 1 }],
    ];
    for (const selection of bad) {
      leaderSock.emit("play", selection);
      await delay(20);
    }
    assert.deepEqual(room.sockets[leaderId].hand, before, "hand untouched by bad input");
    assert.equal({}.polluted, undefined);
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("a 9th joiner becomes a spectator instead of being rejected", async () => {
  const ctx = await startServer();
  try {
    const sockets = [];
    for (let i = 0; i < 9; i++) sockets.push(await connect(ctx.port));
    await delay(50);
    sockets[0].emit("set new nickname", "P0", "");
    sockets[0].emit("create game room", "Spec", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    for (let i = 1; i < 9; i++) {
      sockets[i].emit("set new nickname", "P" + i, "");
      sockets[i].emit("join game room", roomName);
      await delay(20);
    }
    await delay(80);
    const room = ctx.server.manager.rooms.open[roomName];
    const spectators = Object.values(room.sockets).filter((p) => p.spectator);
    assert.equal(spectators.length, 1, "exactly one spectator");
    assert.equal(Object.values(room.sockets).filter((p) => !p.spectator).length, 8);
    for (const s of sockets) s.close();
  } finally {
    await ctx.stop();
  }
});

test("reconnection restores the same seat and hand", async () => {
  const ctx = await startServer();
  try {
    const a = await connect(ctx.port);
    const b = await connect(ctx.port);
    await delay(50);
    a.emit("set new nickname", "Alice", "");
    a.emit("create game room", "Recon", false);
    await delay(50);
    const roomName = Object.keys(ctx.server.manager.rooms.open)[0];
    b.emit("set new nickname", "Bob", "");
    b.emit("join game room", roomName);
    await delay(80);

    const room = ctx.server.manager.rooms.open[roomName];
    const token = room.sockets[a.id].token;
    const seat = room.sockets[a.id].seat;
    const name = room.sockets[a.id].nickname;
    room.sockets[a.id].hand = [3, 4, 5];

    a.close();
    await delay(50);

    const a2 = await connect(ctx.port);
    a2.emit("reconnect", token);
    await delay(80);

    const restored = room.sockets[a2.id];
    assert.ok(restored, "player reattached");
    assert.equal(restored.seat, seat);
    assert.deepEqual(restored.hand, [3, 4, 5]);
    assert.equal(restored.nickname, name, "the display name survives the reconnect");
    a2.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});

test("an unauthenticated socket cannot create or join rooms", async () => {
  const ctx = await startServer();
  try {
    const anon = await connect(ctx.port, { anon: true });
    await delay(30);

    const alertPromise = once(anon, "alert");
    anon.emit("create game room", "Nope", false);
    const key = await alertPromise;
    assert.equal(key, "language.authRequired");
    assert.equal(ctx.server.manager.roomCount(), 0, "no room was created");

    const joinAlert = once(anon, "alert");
    anon.emit("join game room", "1-Whatever");
    assert.equal(await joinAlert, "language.authRequired");
    anon.close();
  } finally {
    await ctx.stop();
  }
});

test("a logged-in player's nickname is bound to their account name", async () => {
  const ctx = await startServer();
  try {
    const cookie = await registerUser(ctx.port, "boundname1");
    const socket = await new Promise((resolve, reject) => {
      const s = ioClient(`http://localhost:${ctx.port}`, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Cookie: cookie },
      });
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
    await delay(30);
    socket.emit("set new nickname", "Imposter", "");
    const sender = await once(socket, "update sender");
    assert.equal(sender.nickname, "boundname1", "nickname cannot be spoofed");
    socket.close();
  } finally {
    await ctx.stop();
  }
});

test("health: authentication endpoints work end-to-end", async () => {
  const ctx = await startServer();
  try {
    const base = `http://localhost:${ctx.port}`;
    const reg = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "player1", password: "password123" }),
    });
    assert.equal(reg.status, 201);

    const me = await fetch(`${base}/api/me`);
    assert.equal(me.status, 401, "unauthenticated request rejected");

    const bad = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "player1", password: "wrongpass" }),
    });
    assert.equal(bad.status, 401);
  } finally {
    await ctx.stop();
  }
});

test("healthz responds 200 without touching auth", async () => {
  const ctx = await startServer({ authEnabled: false });
  try {
    const res = await fetch(`http://localhost:${ctx.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    await ctx.stop();
  }
});

test("guest mode: an anonymous socket can create and play in a room", async () => {
  const ctx = await startServer({ authEnabled: false });
  try {
    assert.equal(ctx.server.userStore, null, "no database in guest mode");

    const me = await fetch(`http://localhost:${ctx.port}/api/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { authEnabled: false, username: null });

    const reg = await fetch(`http://localhost:${ctx.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nope", password: "password123" }),
    });
    assert.equal(reg.status, 403, "account creation disabled");

    const a = await connect(ctx.port, { anon: true });
    const b = await connect(ctx.port, { anon: true });
    await delay(30);

    a.emit("set new nickname", "Alice", "");
    b.emit("set new nickname", "Bob", "");
    await delay(20);

    a.emit("create game room", "GuestRoom", false);
    await delay(30);
    const roomId = Object.keys(ctx.server.manager.rooms.open)[0];
    assert.ok(roomId, "guest created a room id");

    b.emit("join game room", roomId);
    await delay(30);

    assert.equal(ctx.server.manager.roomCount(), 1, "guest created a room");

    // Guests can ready up and the game starts.
    const start = once(a, "chat announce");
    a.emit("ready");
    b.emit("ready");
    const key = await start;
    assert.equal(key, "language.started");
    a.close();
    b.close();
  } finally {
    await ctx.stop();
  }
});
