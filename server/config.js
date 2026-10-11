"use strict";

const { Game, game_state, SEATS } = require("./game-engine");

// In-memory room store. `open` holds public rooms, `hide` holds private ones.
const roomsInfo = { roomNumber: 0, rooms: { open: {}, hide: {} } };

class Player {
  constructor(nickname, cur_room) {
    this.nickname = nickname;
    this.cur_room = cur_room;
    this.seat = -1;
    this.ready = false;
    this.hand = [];
    this.points = 0;
    this.pointsReceived = false;
    this.spectator = false;
    this.connected = true;
    // Bots hold a seat like a player but have no socket and are always ready.
    this.isBot = false;
    this.difficulty = null;
  }

  reset() {
    this.hand = [];
    this.ready = false;
    this.pointsReceived = false;
    this.spectator = false;
  }

  leaveRoom() {
    this.seat = -1;
    this.cur_room = "waiting room";
  }
}

function createRoom(name, hide) {
  return {
    name,
    hide: !!hide,
    seats: new Array(SEATS).fill(false),
    sockets: {},
    game: new Game(),
    leaderBoard: null,
    finishedOrder: [],
    createdAt: Date.now(),
  };
}

function storeFor(rooms, hide) {
  return hide ? rooms.hide : rooms.open;
}

function findRoom(rooms, name) {
  if (rooms.open[name])
    return { store: rooms.open, room: rooms.open[name], hide: false };
  if (rooms.hide[name])
    return { store: rooms.hide, room: rooms.hide[name], hide: true };
  return null;
}

module.exports = {
  Player,
  game_state,
  Game,
  SEATS,
  roomsInfo,
  createRoom,
  storeFor,
  findRoom,
};
