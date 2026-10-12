"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RoomManager } = require("../server/room-manager");
const { Player, game_state } = require("../server/config");
const engine = require("../server/game-engine");
const { ROLE, JOKER, computeRoles } = engine;

// Minimal transport double: records emissions so we can assert on them without
// touching any game logic.
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

function makeManager() {
  const io = makeFakeIo();
  const manager = new RoomManager(io, { log: { log() {}, error() {} }, rng: () => 0.5 });
  return { io, manager };
}

function addPlayer(manager, room, sid, nickname) {
  const p = new Player(nickname, room.name);
  p.sid = sid;
  p.token = "tok-" + sid;
  room.sockets[sid] = p;
  return p;
}

// Set up a room with a known social order and hands, without going through the
// random deal, so revolution/tax behaviour is deterministic.
function setupRoom(manager, order, hands) {
  const room = manager.createRoom("test-room", false);
  room.game.state = game_state.TAXATION;
  room.game.socialOrder = order.slice();
  room.game.roles = computeRoles(order);
  order.forEach((sid, i) => {
    const p = addPlayer(manager, room, sid, sid.toUpperCase());
    p.seat = i;
    p.ready = true;
    p.hand = hands[sid].slice();
    room.seats[i] = true;
  });
  room.game.order = new Array(8).fill(false);
  room.game.cur_order = new Array(8).fill(-1);
  order.forEach((sid) => {
    const p = room.sockets[sid];
    room.game.order[p.seat] = true;
    room.game.cur_order[p.seat] = 1;
  });
  room.game.cur_order_idx = 0;
  return room;
}

test("a Greater Peon with both Jokers is flagged for a greater revolution", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"]; // a=GD, b=LD, c=merchant, d=LP, e=GP
  const hands = {
    a: [1, 2],
    b: [3, 4],
    c: [5, 6],
    d: [7, 8],
    e: [JOKER, JOKER, 9],
  };
  const room = setupRoom(manager, order, hands);
  const cands = engine.revolutionCandidates(
    Object.fromEntries(order.map((sid) => [sid, room.sockets[sid].hand])),
    room.game.roles
  );
  assert.equal(cands.length, 1);
  assert.equal(cands[0].sid, "e");
  assert.equal(cands[0].greater, true);
});

test("resolveRevolution with a greater revolution reverses seats and roles", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [3], d: [4], e: [JOKER, JOKER] };
  const room = setupRoom(manager, order, hands);
  manager.resolveRevolution(room, { sid: "e", greater: true });

  assert.deepEqual(room.game.socialOrder, ["e", "d", "c", "b", "a"]);
  assert.equal(room.game.roles.e, ROLE.GREATER_DALMUTI);
  assert.equal(room.game.roles.a, ROLE.GREATER_PEON);
  assert.equal(room.sockets.e.seat, 0, "Greater Peon now leads");
  assert.equal(room.game.cur_order_idx, 0);
  assert.equal(room.game.state, game_state.PLAYING, "revolution skips taxes");
});

test("a non-greater revolution only cancels taxes and keeps the order", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [JOKER, JOKER], d: [4], e: [5] };
  const room = setupRoom(manager, order, hands);
  manager.resolveRevolution(room, { sid: "c", greater: false });

  assert.deepEqual(room.game.socialOrder, order, "order unchanged");
  assert.equal(room.game.roles.a, ROLE.GREATER_DALMUTI);
  assert.equal(room.game.roles.c, ROLE.MERCHANT);
  assert.equal(room.game.state, game_state.PLAYING, "taxes skipped, play begins");
});

test("declining a revolution falls through to the tax phase", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [3], d: [4], e: [5] };
  const room = setupRoom(manager, order, hands);
  manager.resolveRevolution(room, null);
  assert.equal(room.phase.type, "tax");
});

test("interactive taxes: players choose the cards and the swap is applied", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = {
    a: [1, 2, 11, 12], // Greater Dalmuti
    b: [3, 4, 10, 11], // Lesser Dalmuti
    c: [5, 6, 7, 8], // merchant
    d: [4, 5, 6, 7], // Lesser Peon
    e: [6, 7, 8, 9], // Greater Peon
  };
  const room = setupRoom(manager, order, hands);
  manager.beginTaxPhase(room);
  assert.equal(room.phase.type, "tax");

  const fake = (id) => ({ id, userData: room.sockets[id], emit() {} });
  manager.submitTax(fake("e"), { 6: 1, 7: 1 }); // Greater Peon gives best two
  manager.submitTax(fake("a"), { 11: 1, 12: 1 }); // Greater Dalmuti returns worst two
  manager.submitTax(fake("d"), { 4: 1 }); // Lesser Peon gives best one
  manager.submitTax(fake("b"), { 11: 1 }); // Lesser Dalmuti returns worst one

  assert.equal(room.game.state, game_state.PLAYING, "taxes resolved -> playing");
  assert.deepEqual(room.sockets.e.hand, [8, 9, 11, 12]);
  assert.deepEqual(room.sockets.a.hand, [1, 2, 6, 7]);
  assert.deepEqual(room.sockets.d.hand, [5, 6, 7, 11]);
  assert.deepEqual(room.sockets.b.hand, [3, 4, 4, 10]);
});

test("tax auto-fallback uses the peon's best and the dalmuti's worst cards", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = {
    a: [1, 2, 11, 12],
    b: [3, 4, 10, 11],
    c: [5, 6, 7, 8],
    d: [4, 5, 6, 7],
    e: [6, 7, 8, 9],
  };
  const room = setupRoom(manager, order, hands);
  manager.beginTaxPhase(room);
  manager.resolveTaxes(room); // no submissions -> fallback

  assert.equal(room.game.state, game_state.PLAYING);
  assert.deepEqual(room.sockets.e.hand, [8, 9, 11, 12], "peon gave best 6,7");
  assert.deepEqual(room.sockets.a.hand, [1, 2, 6, 7], "dalmuti gave worst 11,12");
});

test("the trick winner leads the next trick and is announced on a pass", () => {
  const { io, manager } = makeManager();
  const order = ["a", "b", "c"];
  const hands = { a: [12, 7], b: [3, 4], c: [5, 6] };
  const room = setupRoom(manager, order, hands);
  room.game.state = game_state.PLAYING;
  room.game.cur_order_idx = 0; // a (Greater Dalmuti) leads
  room.game.last = null;

  const sock = (sid) => ({
    id: sid,
    userData: room.sockets[sid],
    emit: (event, ...args) => io.events.push({ event, args }),
  });
  manager.play(sock("a"), { 12: 1 }); // a leads a 12
  manager.play(sock("b"), { 3: 1 }); // b beats it
  manager.play(sock("c"), {}); // c passes
  manager.play(sock("a"), {}); // a passes -> trick ends, b wins

  assert.equal(room.game.cur_order_idx, room.sockets.b.seat, "b (trick winner) leads");
  assert.equal(room.game.last, null, "rule state cleared for the new lead");
  assert.equal(room.game.shown.by, "b", "the winning play stays on display");

  const passAnnounce = io.events.filter(
    (e) => e.event === "chat announce" && e.args[0] === "language.passed"
  );
  assert.ok(passAnnounce.length >= 1, "a human pass is echoed to chat");
});

test("the next hand re-seats players by the previous finishing order", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c"];
  const hands = { a: [1], b: [2], c: [3] };
  const room = setupRoom(manager, order, hands);
  // Previous hand finished c, then a, then b.
  room.leaderBoard = [
    { sid: "c", nickname: "C", points: 3, role: ROLE.GREATER_DALMUTI },
    { sid: "a", nickname: "A", points: 2, role: ROLE.LESSER_DALMUTI },
    { sid: "b", nickname: "B", points: 1, role: ROLE.GREATER_PEON },
  ];
  manager.startGame(room);

  assert.equal(room.sockets.c.seat, 0, "winner leads next hand");
  assert.equal(room.sockets.a.seat, 1);
  assert.equal(room.sockets.b.seat, 2);
  assert.equal(room.game.roles.c, ROLE.GREATER_DALMUTI);
  assert.equal(room.game.roles.b, ROLE.GREATER_PEON);
  assert.equal(room.game.state, game_state.TAXATION, "start awaits taxes");
});
