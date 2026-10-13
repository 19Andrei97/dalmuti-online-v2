"use strict";

// Session scoring: points earned each hand accumulate in the room until a
// player reaches the configured target, which freezes further hands until the
// host resets the scores.

const test = require("node:test");
const assert = require("node:assert/strict");

const { RoomManager } = require("../server/room-manager");
const { Player, game_state } = require("../server/config");
const { sanitizeTargetPoints } = require("../server/security");

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

function makeManager(opts = {}) {
  const io = makeFakeIo();
  const manager = new RoomManager(io, { log: { log() {}, error() {} }, rng: () => 0.5, ...opts });
  return { io, manager };
}

function addPlayer(room, sid, points = 0) {
  const p = new Player(sid, room.name);
  p.sid = sid;
  p.seat = room.seats.indexOf(false);
  p.ready = true;
  p.points = points;
  room.sockets[sid] = p;
  room.seats[p.seat] = true;
  return p;
}

// Drive finishGame with a fixed finishing order, bypassing the deal/play loop.
function finishWith(manager, room, order) {
  room.finishedOrder = order.slice();
  manager.finishGame(room);
}

test("points accumulate across hands and the target ends the session", () => {
  const { io, manager } = makeManager();
  const room = manager.createRoom("scored", false, "a", false, 5);
  const a = addPlayer(room, "a");
  const b = addPlayer(room, "b");
  const c = addPlayer(room, "c");

  // Hand 1: a wins (3), b second (2), c last (1).
  finishWith(manager, room, ["a", "b", "c"]);
  assert.equal(a.points, 3);
  assert.equal(b.points, 2);
  assert.equal(c.points, 1);
  assert.equal(room.sessionOver, false, "3 < target of 5");

  // Hand 2: a is last (1) -> 4, b wins (3) -> 5, reaching the target.
  finishWith(manager, room, ["b", "c", "a"]);
  assert.equal(a.points, 4);
  assert.equal(b.points, 5);
  assert.equal(c.points, 3);
  assert.equal(room.sessionOver, true, "b reached the target");
  assert.ok(
    io.events.some((e) => e.event === "chat announce" && e.args[0] === "language.sessionWon"),
    "a session-won announcement was emitted"
  );
});

test("a hand alone never ends the session while below the target", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("below", false, "a", false, 100);
  addPlayer(room, "a");
  addPlayer(room, "b");
  finishWith(manager, room, ["a", "b"]);
  assert.equal(room.sessionOver, false);
});

test("the per-hand leaderboard stays independent of the session total", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("split", false, "a", false, 50);
  const a = addPlayer(room, "a");
  const b = addPlayer(room, "b");
  finishWith(manager, room, ["a", "b"]);
  // Per-hand points reset each hand; the session total does not.
  assert.equal(room.leaderBoard[0].points, 2);
  assert.equal(room.leaderBoard[1].points, 1);
  assert.equal(a.points, 2);
  assert.equal(b.points, 1);
});

test("resetSession clears the scores and unfreezes the room (host only)", () => {
  const { io, manager } = makeManager();
  const room = manager.createRoom("reset", false, "host", false, 3);
  const host = addPlayer(room, "host");
  addPlayer(room, "b");
  host.points = 3;
  room.sessionOver = true;

  // A non-host may not reset.
  const intruder = { id: "x", userData: { cur_room: "reset" }, emit() {} };
  manager.resetSession(intruder);
  assert.equal(room.sessionOver, true, "non-host reset is ignored");

  const hostSocket = { id: "host", userData: { cur_room: "reset" }, emit() {} };
  manager.resetSession(hostSocket);
  assert.equal(room.sessionOver, false);
  for (const p of Object.values(room.sockets)) assert.equal(p.points, 0);
  assert.ok(
    io.events.some((e) => e.event === "chat announce" && e.args[0] === "language.sessionReset"),
    "a reset announcement was emitted"
  );
});

test("a finished session does not auto-start another hand", () => {
  const { manager } = makeManager({ taxWindowMs: 1000 });
  const room = manager.createRoom("frozen", false, "a", false, 3);
  addPlayer(room, "a");
  addPlayer(room, "b");

  room.sessionOver = true;
  manager.maybeAutoStart(room);
  assert.equal(room.game.state, game_state.WAITING, "still frozen");

  room.sessionOver = false;
  manager.maybeAutoStart(room);
  assert.equal(room.game.state, game_state.TAXATION, "starts once unfrozen");
  // Drop the tax-phase timer so the test process can exit.
  manager.clearPhase(room);
});

test("roomView exposes the target and session-over flag", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("view", false, "a", false, 21);
  addPlayer(room, "a");
  const view = manager.roomView(room, "a");
  assert.equal(view.targetPoints, 21);
  assert.equal(view.sessionOver, false);
});

test("target points are sanitised: default, floor and cap", () => {
  assert.equal(sanitizeTargetPoints(undefined), 15, "missing -> default");
  assert.equal(sanitizeTargetPoints("abc"), 15, "non-numeric -> default");
  assert.equal(sanitizeTargetPoints(0), 15, "below minimum -> default");
  assert.equal(sanitizeTargetPoints(-4), 15, "negative -> default");
  assert.equal(sanitizeTargetPoints("20"), 20, "numeric string accepted");
  assert.equal(sanitizeTargetPoints(7.9), 7, "floored");
  assert.equal(sanitizeTargetPoints(100000), 500, "capped");
});

test("createRoom defaults the target to 15", () => {
  const { manager } = makeManager();
  const room = manager.createRoom("default");
  assert.equal(room.targetPoints, 15);
});
