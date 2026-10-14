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

test("a declared revolution names the caller in chat and broadcasts a banner", () => {
  const { io, manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [JOKER, JOKER], d: [4], e: [5] };
  const room = setupRoom(manager, order, hands);
  io.events.length = 0;
  manager.resolveRevolution(room, { sid: "c", greater: false });

  const announce = io.events.find(
    (e) => e.event === "chat announce" && e.args[0] === "language.revolution"
  );
  assert.ok(announce, "the revolution is announced in chat");
  assert.equal(announce.args[2], "C", "the chat line names the caller");

  const banner = io.events.find((e) => e.event === "revolution declared");
  assert.ok(banner, "a banner event is broadcast to the room");
  assert.deepEqual(banner.args[0], { greater: false, nickname: "C" });
});

test("a greater revolution names the caller and flags the banner as greater", () => {
  const { io, manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [3], d: [4], e: [JOKER, JOKER] };
  const room = setupRoom(manager, order, hands);
  io.events.length = 0;
  manager.resolveRevolution(room, { sid: "e", greater: true });

  const announce = io.events.find(
    (e) => e.event === "chat announce" && e.args[0] === "language.greaterRevolution"
  );
  assert.equal(announce.args[2], "E", "the chat line names the caller");

  const banner = io.events.find((e) => e.event === "revolution declared");
  assert.deepEqual(banner.args[0], { greater: true, nickname: "E" });
});

test("a declined revolution never broadcasts a banner", () => {
  const { io, manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1], b: [2], c: [3], d: [4], e: [5] };
  const room = setupRoom(manager, order, hands);
  io.events.length = 0;
  manager.resolveRevolution(room, null);

  assert.equal(
    io.events.some((e) => e.event === "revolution declared"),
    false,
    "no banner when no one declared"
  );
  assert.ok(
    io.events.some((e) => e.event === "chat announce" && e.args[0] === "language.noRevolution")
  );
});

test("taxes: only the Dalmuti chooses, the Peon's tribute is automatic", () => {
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
  // The Peons do not submit; only the two Dalmutis pick their return cards.
  manager.submitTax(fake("a"), { 11: 1, 12: 1 }); // Greater Dalmuti returns worst two
  manager.submitTax(fake("b"), { 11: 1 }); // Lesser Dalmuti returns worst one

  assert.equal(room.game.state, game_state.PLAYING, "taxes resolved -> playing");
  assert.deepEqual(room.sockets.e.hand, [8, 9, 11, 12], "peon gave best 6,7 automatically");
  assert.deepEqual(room.sockets.a.hand, [1, 2, 6, 7]);
  assert.deepEqual(room.sockets.d.hand, [5, 6, 7, 11]);
  assert.deepEqual(room.sockets.b.hand, [3, 4, 4, 10]);
});

test("taxes: a Peon never surrenders a Joker and a Dalmuti never returns one", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = {
    a: [1, 2, 3, 4, 12, JOKER], // Greater Dalmuti, plenty of non-Jokers
    b: [3, 4, 10, 11],
    c: [5, 6, 7, 8],
    d: [4, 5, 6, 7],
    e: [JOKER, 8, 9, 6, 7], // Greater Peon holding a Joker
  };
  const room = setupRoom(manager, order, hands);
  manager.beginTaxPhase(room);
  manager.resolveTaxes(room); // fallbacks only

  // Peon gives the two lowest non-Jokers (6, 7), keeping the Joker.
  assert.ok(room.sockets.e.hand.includes(JOKER), "peon keeps the Joker");
  assert.deepEqual(room.sockets.e.hand.slice().sort((x, y) => x - y), [4, 8, 9, 12, JOKER]);
  // Dalmuti returns its two worst non-Jokers (12, 4), never the Joker.
  assert.ok(room.sockets.a.hand.includes(JOKER), "dalmuti keeps the Joker");
  assert.deepEqual(room.sockets.a.hand.slice().sort((x, y) => x - y), [1, 2, 3, 6, 7, JOKER]);
});

test("taxes: the Peon is notified of the automatic payment and its result", () => {
  const { io, manager } = makeManager();
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

  const owed = io.events.filter((e) => e.event === "tax owed");
  // Both Peons are told what they owe, and are never sent the pick prompt.
  assert.deepEqual(owed.map((e) => e.target).sort(), ["d", "e"]);
  assert.equal(owed.find((e) => e.target === "e").args[0].count, 2);
  assert.equal(owed.find((e) => e.target === "d").args[0].count, 1);
  assert.equal(io.events.some((e) => e.event === "tax phase" && e.target === "e"), false);
  assert.equal(
    io.events.some((e) => e.event === "tax phase" && e.target === "a"),
    true,
    "only the Dalmuti is prompted"
  );

  io.events.length = 0;
  manager.resolveTaxes(room);
  const result = io.events.filter((e) => e.event === "tax result");
  assert.deepEqual(result.map((e) => e.target).sort(), ["d", "e"]);
  const peonE = result.find((e) => e.target === "e").args[0];
  assert.equal(peonE.partner, "A", "names the Dalmuti");
  assert.equal(peonE.sent, "6 & 7", "shows the cards sent");
  assert.equal(peonE.received, "12 & 11", "shows the cards received");
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

test("the first-round 'no taxes' house rule skips taxation and blanks the roles", () => {
  const { io, manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"]; // a=GD, b=LD, c=merchant, d=LP, e=GP
  const hands = { a: [1, 2], b: [3, 4], c: [5, 6], d: [7, 8], e: [9, 10] };
  const room = setupRoom(manager, order, hands);
  room.noTaxFirstRound = true;
  room.game.round = -1; // startGame advances this to 0 (the first hand)
  manager.startGame(room);

  assert.equal(room.game.state, game_state.PLAYING, "play begins without taxes");
  assert.equal(room.phase, null, "no tax phase was created");
  assert.deepEqual(room.game.roles, {}, "roles blanked so seats show plain citizens");
  assert.ok(
    io.events.some((e) => e.event === "chat announce" && e.args[0] === "language.noTaxFirst"),
    "the no-tax rule is announced"
  );
});

test("without the house rule the first hand still taxes", () => {
  const { manager } = makeManager();
  const order = ["a", "b", "c", "d", "e"];
  const hands = { a: [1, 2], b: [3, 4], c: [5, 6], d: [7, 8], e: [9, 10] };
  const room = setupRoom(manager, order, hands);
  room.game.round = -1;
  manager.startGame(room);

  assert.equal(room.game.state, game_state.TAXATION, "default keeps the official tax");
  assert.ok(
    Object.values(room.game.roles).includes(ROLE.GREATER_DALMUTI),
    "a Greater Dalmuti is still seated"
  );
});

// ---- auto-pass of a player with no legal answer ---------------------------

// A PLAYING room with `b` on turn and a known field on the table.
function playingRoom(manager, hands, last) {
  const order = ["a", "b", "c", "d", "e"];
  const room = setupRoom(manager, order, hands);
  room.game.state = game_state.PLAYING;
  room.game.last = last;
  room.game.cur_order_idx = 1; // b to act
  return room;
}

test("a human with no legal play is auto-passed after the grace period", async () => {
  const { io, manager } = makeManager();
  manager.autoPassDelayMs = 20;
  // A field of a single 8: b's 9 cannot answer it, but c's 5 can, so the pass must
  // move the turn to c and stop there.
  const room = playingRoom(
    manager,
    { a: [1, 2], b: [9], c: [5, 6], d: [7, 8], e: [4, 4] },
    { num: 8, count: 1, by: "a", handCount: 1, cards: [8] }
  );

  manager.scheduleAutoPass(room);
  assert.ok(manager.autoPassTimers.has(room.name), "a pass is queued for b");

  await new Promise((r) => setTimeout(r, 70));
  assert.equal(room.game.cur_order[1], 0, "b is marked as passed");
  assert.equal(room.game.cur_order_idx, 2, "turn moved on to c");
  const announce = io.events.find(
    (e) => e.event === "chat announce" && e.args[0] === "language.autoPassed"
  );
  assert.ok(announce, "an auto-pass notice is broadcast");
  assert.equal(announce.args[2], "B", "the notice names the passed player");
});

test("a player who can still answer keeps their turn (no auto-pass)", async () => {
  const { io, manager } = makeManager();
  manager.autoPassDelayMs = 20;
  // b's 4 beats a field of 8, so b has a legal play and must not be skipped.
  const room = playingRoom(
    manager,
    { a: [1, 2], b: [4], c: [5, 6], d: [7, 8], e: [4, 4] },
    { num: 8, count: 1, by: "a", handCount: 1, cards: [8] }
  );

  manager.scheduleAutoPass(room);
  assert.equal(manager.autoPassTimers.has(room.name), false, "no timer for a playable turn");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(room.game.cur_order[1], 1, "b has not passed");
  assert.equal(room.game.cur_order_idx, 1, "b keeps the turn");
  assert.equal(
    io.events.some((e) => e.args && e.args[0] === "language.autoPassed"),
    false,
    "no auto-pass notice"
  );
});

test("a bot is never auto-passed by the human path", () => {
  const { manager } = makeManager();
  manager.autoPassDelayMs = 20;
  const room = playingRoom(
    manager,
    { a: [1, 2], b: [9], c: [5, 6], d: [7, 8], e: [4, 4] },
    { num: 1, count: 1, by: "a", handCount: 1, cards: [1] }
  );
  room.sockets.b.isBot = true;

  manager.scheduleAutoPass(room);
  assert.equal(manager.autoPassTimers.has(room.name), false, "bots schedule themselves");
});

test("auto-pass chains to the next human who also cannot answer", async () => {
  const { manager } = makeManager();
  manager.autoPassDelayMs = 20;
  // Field of a single 5: neither b (9) nor c (7) can answer, but d (3) can, so the
  // auto-pass must hand off from b to c and then stop on d.
  const room = playingRoom(
    manager,
    { a: [1, 2], b: [9], c: [7], d: [3], e: [4, 4] },
    { num: 5, count: 1, by: "a", handCount: 1, cards: [5] }
  );

  manager.scheduleAutoPass(room);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(room.game.cur_order[1], 0, "b was auto-passed");
  assert.equal(room.game.cur_order[2], 0, "c was auto-passed too (turn handed off)");
  assert.equal(room.game.cur_order_idx, 3, "the chain stops on d, who can answer");
});


test("a completed trick is flagged trickOver in the view so the client can say 'lead again'", () => {
  const { manager } = makeManager();
  const room = setupRoom(manager, ["a", "b", "c"], { a: [1, 5, 5], b: [9, 9], c: [10, 10] });
  room.game.state = game_state.PLAYING;
  room.game.cur_order_idx = 0;

  manager.applyPlay(room, "a", { 1: 1 }); // a leads a 1
  const mid = manager.roomView(room, "b");
  assert.equal(mid.last.num, 1, "a live field is a follow");
  assert.equal(mid.shown.trickOver, undefined, "a live play is not a won trick");

  // b and c cannot answer, so the trick completes and returns to a.
  room.game.cur_order[1] = 0;
  room.game.nextPlayer({}, null, room);
  room.game.cur_order[2] = 0;
  room.game.nextPlayer({}, null, room);

  const after = manager.roomView(room, "a");
  assert.equal(after.last, null, "the rule state is cleared for a fresh lead");
  assert.equal(after.shown.num, 1, "the won trick stays on the table");
  assert.equal(after.shown.trickOver, true, "the display copy marks the won trick");
  assert.equal(after.cur_order_idx, 0, "the trick winner leads again");
});

