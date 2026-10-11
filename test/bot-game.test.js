"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { io: ioClient } = require("socket.io-client");

const { createServer } = require("../app");
const { RoomManager } = require("../server/room-manager");
const { Player, game_state, SEATS } = require("../server/config");

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const silent = { log() {}, error() {} };

function makeFakeIo() {
  const events = [];
  return {
    events,
    to(target) {
      return {
        emit(event, ...args) {
          events.push({ target, event, args });
        },
      };
    },
  };
}

// A manager whose bot timers fire immediately, so bot turns chain at once.
function makeManager(opts = {}) {
  const io = makeFakeIo();
  const manager = new RoomManager(io, {
    log: silent,
    rng: seededRng(999),
    botDelayMs: 0,
    taxWindowMs: 5000,
    revolutionWindowMs: 5000,
    ...opts,
  });
  return { io, manager };
}

function fakeSocket(id, roomName) {
  const emits = [];
  return {
    id,
    userData: { cur_room: roomName },
    emits,
    emit(event, ...args) {
      emits.push({ event, args });
    },
    leave() {},
    join() {},
  };
}

function addHuman(manager, room, sid, opts = {}) {
  const p = new Player(sid, room.name);
  p.sid = sid;
  p.seat = opts.seat != null ? opts.seat : room.seats.indexOf(false);
  p.ready = !!opts.ready;
  room.sockets[sid] = p;
  if (p.seat >= 0) room.seats[p.seat] = true;
  return p;
}

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let done = false;
      try {
        done = predicate();
      } catch (e) {
        return reject(e);
      }
      if (done) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("a table of bots plays a full hand to completion", async () => {
  const { manager } = makeManager();
  const room = manager.createRoom("bots-only", false, "host");
  const host = fakeSocket("host", "bots-only");

  manager.addBot(host, "easy");
  manager.addBot(host, "medium");
  manager.addBot(host, "hard");
  manager.addBot(host, "hard");
  assert.equal(manager.seatedCount(room), 4);
  // No human is seated, so the hand must not start on its own.
  assert.equal(room.game.state, game_state.WAITING);

  manager.startGame(room);
  await waitFor(() => room.game.state === game_state.WAITING);

  assert.ok(room.leaderBoard, "a leaderboard was produced");
  assert.equal(room.leaderBoard.length, 4);
  assert.equal(new Set(room.leaderBoard.map((r) => r.sid)).size, 4);
  // Bots are re-armed for the next hand.
  for (const p of manager.botsIn(room)) assert.equal(p.ready, true);
});

test("only the host may add bots, and only while waiting", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("guarded", false, "host");
  const host = fakeSocket("host", "guarded");
  const other = fakeSocket("other", "guarded");

  // A non-host gets an error and no bot is added.
  manager.addBot(other, "hard");
  assert.equal(manager.botsIn(room).length, 0);
  assert.ok(other.emits.some((e) => e.event === "alert" && e.args[0] === "language.notHost"));

  manager.addBot(host, "hard");
  assert.equal(manager.botsIn(room).length, 1);

  // An unknown difficulty is rejected.
  manager.addBot(host, "impossible");
  assert.equal(manager.botsIn(room).length, 1);

  // Once the game starts, bots cannot be changed.
  manager.addBot(host, "hard");
  addHuman(manager, room, "human", { ready: true });
  manager.startGame(room);
  assert.notEqual(room.game.state, game_state.WAITING);
  manager.addBot(host, "easy");
  assert.equal(manager.botsIn(room).length, 2);
});

test("fillBots seats a bot in every empty seat up to the table size", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("filling", false, "host");
  const host = fakeSocket("host", "filling");
  addHuman(manager, room, "human");

  manager.fillBots(host, "medium");
  assert.equal(manager.seatedCount(room), SEATS);
  assert.equal(manager.botsIn(room).length, SEATS - 1);
  // The human has not readied, so the game must not have started.
  assert.equal(room.game.state, game_state.WAITING);
});

test("removing a bot frees its seat", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("removing", false, "host");
  const host = fakeSocket("host", "removing");

  manager.addBot(host, "medium");
  const botSid = manager.botsIn(room)[0].sid;
  assert.equal(manager.seatedCount(room), 1);

  manager.removeBot(host, botSid);
  assert.equal(manager.seatedCount(room), 0);
  assert.equal(manager.botsIn(room).length, 0);
  assert.equal(room.seats.every((s) => s === false), true);
});

test("leaving removes the room when no humans remain (bots are not left behind)", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("host-leaves", false, "host");
  const host = fakeSocket("host", "host-leaves");
  const human = addHuman(manager, room, "human");
  manager.addBot(host, "hard");
  assert.equal(Object.keys(manager.rooms.open).includes("host-leaves"), true);

  const humanSocket = fakeSocket("human", "host-leaves");
  humanSocket.userData = human;
  manager.removeFromRoom(humanSocket, room, manager.rooms.open);

  assert.equal(manager.rooms.open["host-leaves"], undefined, "empty room dropped");
  assert.equal(manager.botsIn(room).length, 1, "stale room object is simply discarded");
});

// ---- end-to-end over sockets ---------------------------------------------

async function startServer(overrides = {}) {
  const dbPath = path.join(os.tmpdir(), `dalmuti-bot-${Date.now()}-${Math.random()}.db`);
  const server = createServer({
    dbPath,
    rng: seededRng(12345),
    log: silent,
    botDelayMs: 10,
    taxWindowMs: 5000,
    revolutionWindowMs: 5000,
    authEnabled: false,
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

function connect(port) {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("guest host adds a bot over sockets and the hand starts automatically", async () => {
  const ctx = await startServer();
  try {
    const host = await connect(ctx.port);
    const other = await connect(ctx.port);
    await delay(30);
    host.emit("set new nickname", "Host", "");
    other.emit("set new nickname", "Other", "");
    host.emit("create game room", "WithBots", false);
    await delay(50);
    const room = ctx.server.manager.rooms.open[Object.keys(ctx.server.manager.rooms.open)[0]];
    assert.equal(room.hostSid, host.id);

    // A non-host cannot add bots.
    other.emit("join game room", room.name);
    await delay(30);
    const alert = new Promise((res) => other.once("alert", res));
    other.emit("add bot", "hard");
    assert.equal(await alert, "language.notHost");
    assert.equal(ctx.server.manager.botsIn(room).length, 0);

    // The host adds one bot and readies up; with the bot ready the game starts
    // once the other human readies too.
    host.emit("add bot", "hard");
    await delay(40);
    assert.equal(ctx.server.manager.botsIn(room).length, 1);
    const bot = ctx.server.manager.botsIn(room)[0];
    assert.equal(bot.ready, true);
    assert.equal(bot.difficulty, "hard");
    assert.equal(room.game.state, game_state.WAITING, "not everyone is ready yet");

    host.emit("ready");
    await delay(40);
    assert.equal(room.game.state, game_state.WAITING, "other human still not ready");

    other.emit("ready");
    await waitFor(() => room.game.state !== game_state.WAITING);
    assert.notEqual(room.game.state, game_state.WAITING, "game started with a bot");

    host.close();
    other.close();
  } finally {
    await ctx.stop();
  }
});

test("the host can fill and clear bot seats over sockets while waiting", async () => {
  const ctx = await startServer();
  try {
    const host = await connect(ctx.port);
    await delay(30);
    host.emit("set new nickname", "Host", "");
    host.emit("create game room", "Fill", false);
    await delay(50);
    const room = ctx.server.manager.rooms.open[Object.keys(ctx.server.manager.rooms.open)[0]];

    host.emit("fill bots", "easy");
    await delay(80);
    assert.equal(ctx.server.manager.seatedCount(room), SEATS);
    assert.equal(ctx.server.manager.botsIn(room).length, SEATS - 1);
    assert.equal(room.game.state, game_state.WAITING, "host not ready, no start");

    for (const bot of ctx.server.manager.botsIn(room).slice()) {
      host.emit("remove bot", bot.sid);
    }
    await delay(100);
    assert.equal(ctx.server.manager.seatedCount(room), 1, "only the host remains");
    assert.equal(room.game.state, game_state.WAITING);
    host.close();
  } finally {
    await ctx.stop();
  }
});
