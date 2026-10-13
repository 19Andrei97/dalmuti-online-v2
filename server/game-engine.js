"use strict";

// Pure game rules for The Great Dalmuti. No socket/transport code here so the
// rules can be unit tested and live in a single place.

const SEATS = 8;
const JOKER = 13;

const CARD = {
  GREAT_DALMUTI: 1,
  PEASANT: 12,
  JOKER: JOKER,
};

const ROLE = {
  GREATER_DALMUTI: "greaterDalmuti",
  LESSER_DALMUTI: "lesserDalmuti",
  GREATER_PEON: "greaterPeon",
  LESSER_PEON: "lesserPeon",
  MERCHANT: "merchant",
};

const game_state = {
  WAITING: 0,
  PLAYING: 1,
  TAXATION: 2,
};

function prepareDeck() {
  const deck = [];
  for (let card = CARD.PEASANT; card >= CARD.GREAT_DALMUTI; card--) {
    for (let cnt = card; cnt >= 1; cnt--) deck.push(card);
  }
  deck.push(JOKER, JOKER);
  return deck;
}

function shuffle(array, rng = Math.random) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// Reject prototype pollution, unknown keys and non-positive-integer counts.
// Returns a normalized {card: count} map, or null when the selection is illegal.
function validateSelection(selected_card) {
  if (!isPlainObject(selected_card)) return null;
  const normalized = {};
  for (const key of Object.keys(selected_card)) {
    if (!/^([1-9]|1[0-3])$/.test(key)) return null;
    const count = selected_card[key];
    if (!Number.isInteger(count) || count <= 0) return null;
    normalized[Number(key)] = count;
  }
  return normalized;
}

function handToCounts(hand) {
  const counts = {};
  for (const card of hand) {
    const c = Number(card);
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

// Every selected card must actually be held in sufficient quantity.
function checkValidity(hand, selection) {
  const counts = handToCounts(hand);
  for (const [card, count] of Object.entries(selection)) {
    if (!counts[card] || counts[card] < count) return false;
  }
  return true;
}

function selectionCount(selection) {
  let count = 0;
  for (const val of Object.values(selection)) count += val;
  return count;
}

// Rule check for a play against the current field. `last` is {num, count} or
// null when the field is empty (then any legal combination may be led).
function checkRule(last, selection) {
  const cards = Object.keys(selection).map(Number);
  const count = selectionCount(selection);

  if (cards.length > 2) return false;
  if (cards.length === 2 && !selection[JOKER]) return false;

  if (!last) {
    // Leading: a set is one or more cards of the same rank, so a lone Joker is a
    // rank-13 set (and one or two Jokers are a legal lead). A Joker mixed with a
    // real rank stands in for that rank, also a legal lead.
    return true;
  }

  if (last.count !== count) return false;

  for (const card of cards) {
    if (cards.length === 1) {
      // A lone Joker is a 13 — the worst card — so it never beats anything.
      if (last.num - card <= 0) return false;
    } else if (card !== JOKER) {
      if (last.num - card <= 0) return false;
    }
  }
  return true;
}

// True when `hand` holds at least one legal answer to the field `last`. Mirrors
// the client's hasLegalPlay: a set of `last.count` copies of a lower rank, or the
// {Joker, lower rank} pair for a two-card field. A null field (leading) is always
// playable — the leader must play. Used to auto-pass a player who has no move.
function hasLegalPlay(hand, last) {
  if (!last) return true;
  const counts = handToCounts(hand);
  for (const [card, have] of Object.entries(counts)) {
    const rank = Number(card);
    if (rank !== JOKER && rank < last.num && have >= last.count) return true;
  }
  if (last.count === 2 && (counts[JOKER] || 0) >= 1) {
    for (const [card, have] of Object.entries(counts)) {
      const rank = Number(card);
      if (rank !== JOKER && rank < last.num && have >= 1) return true;
    }
  }
  return false;
}

// Remove the selected cards from a hand, returning a new numeric hand.
function applyPlay(hand, selection) {
  const counts = handToCounts(hand);
  for (const [card, count] of Object.entries(selection)) {
    counts[card] = (counts[card] || 0) - count;
  }
  const newHand = [];
  for (const card of Object.keys(counts).map(Number).sort((a, b) => a - b)) {
    for (let i = 0; i < counts[card]; i++) newHand.push(card);
  }
  return newHand;
}

// Expand a selection into an ordered list of card values (Jokers included).
function cardsFromSelection(selection) {
  const cards = [];
  for (const card of Object.keys(selection).map(Number).sort((a, b) => a - b)) {
    for (let i = 0; i < selection[card]; i++) cards.push(card);
  }
  return cards;
}

// ---- Social order / roles -------------------------------------------------

// Assign roles from an ordered list of sids (best rank first).
function computeRoles(socialOrder) {
  const roles = {};
  const n = socialOrder.length;
  socialOrder.forEach((sid, i) => {
    if (i === 0) roles[sid] = ROLE.GREATER_DALMUTI;
    else if (n >= 4 && i === 1) roles[sid] = ROLE.LESSER_DALMUTI;
    else if (n >= 2 && i === n - 1) roles[sid] = ROLE.GREATER_PEON;
    else if (n >= 4 && i === n - 2) roles[sid] = ROLE.LESSER_PEON;
    else roles[sid] = ROLE.MERCHANT;
  });
  return roles;
}

function roleOf(roles, sid) {
  return roles[sid] || null;
}

// Draw cards to seed the first hand's social order. Lower number is better;
// a Joker counts as 13 (worst). Ties are redrawn, with a bounded number of
// attempts so a degenerate rng can never spin forever.
function drawForOrder(sids, rng = Math.random) {
  let remaining = sids.slice();
  const order = [];
  let attempts = 0;
  while (remaining.length > 1 && attempts < 1000) {
    attempts++;
    const deck = shuffle(prepareDeck(), rng);
    const draws = remaining.map((sid, i) => ({ sid, card: deck[i % deck.length] }));
    draws.sort((a, b) => a.card - b.card);
    // Players with a unique best card are seated first.
    const best = draws[0].card;
    const tied = draws.filter((d) => d.card === best);
    if (tied.length === 1) {
      order.push(tied[0].sid);
      remaining = remaining.filter((sid) => sid !== tied[0].sid);
    }
    // On a tie, nobody is seated this pass and the group redraws.
  }
  order.push(...remaining);
  return order;
}

// Deal every card. Higher-ranked players receive the extra cards when the deck
// does not divide evenly, so no card is discarded.
function deal(deck, socialOrder) {
  const hands = {};
  for (const sid of socialOrder) hands[sid] = [];
  const n = socialOrder.length;
  if (n === 0) return hands;
  const base = Math.floor(deck.length / n);
  const remainder = deck.length % n;
  let idx = 0;
  // Deal round-robin so the extra cards fall to the higher-ranked players.
  for (let round = 0; round < base; round++) {
    for (const sid of socialOrder) hands[sid].push(deck[idx++]);
  }
  for (let i = 0; i < remainder; i++) {
    hands[socialOrder[i]].push(deck[idx++]);
  }
  for (const sid of socialOrder) hands[sid].sort((a, b) => a - b);
  return hands;
}

// ---- Taxes ----------------------------------------------------------------

function findRoleSid(roles, role) {
  return Object.keys(roles).find((sid) => roles[sid] === role) || null;
}

// Tax obligations for a hand: the Peons owe cards to the Dalmutis.
function computeTaxes(roles) {
  const taxes = [];
  const gd = findRoleSid(roles, ROLE.GREATER_DALMUTI);
  const gp = findRoleSid(roles, ROLE.GREATER_PEON);
  if (gd && gp) taxes.push({ kind: "greater", from: gp, to: gd, count: 2 });
  const ld = findRoleSid(roles, ROLE.LESSER_DALMUTI);
  const lp = findRoleSid(roles, ROLE.LESSER_PEON);
  if (ld && lp) taxes.push({ kind: "lesser", from: lp, to: ld, count: 1 });
  return taxes;
}

// The Peon surrenders their best (lowest-numbered) cards. Jokers are the worst
// cards, so they sort last and are only ever given up if the Peon holds fewer
// non-Joker cards than the tax demands.
function peonBestCards(hand, count) {
  const sorted = hand.slice().sort((a, b) => a - b);
  return sorted.slice(0, count);
}

// Default return for the Dalmuti when a player does not choose: give away the
// worst (highest-numbered) cards. A Joker is never returned while any other card
// remains, since Jokers are the strongest cards to keep.
function dalmutiWorstCards(hand, count) {
  const nonJokers = hand.filter((c) => c !== JOKER).sort((a, b) => b - a);
  const out = nonJokers.slice(0, count);
  for (const card of hand) {
    if (out.length >= count) break;
    if (card === JOKER) out.push(card);
  }
  return out;
}

function removeCards(hand, cards) {
  const counts = handToCounts(hand);
  for (const card of cards) counts[card] -= 1;
  const out = [];
  for (const card of Object.keys(counts).map(Number).sort((a, b) => a - b)) {
    for (let i = 0; i < counts[card]; i++) out.push(card);
  }
  return out;
}

// ---- Revolution -----------------------------------------------------------

// Any player dealt both Jokers may call a revolution (cancels taxation). If the
// Greater Peon does so it is a Greater Revolution and the whole order reverses.
function revolutionCandidates(hands, roles) {
  const candidates = [];
  for (const sid of Object.keys(hands)) {
    const jokers = hands[sid].filter((c) => c === JOKER).length;
    if (jokers >= 2) {
      candidates.push({
        sid,
        greater: roles[sid] === ROLE.GREATER_PEON,
      });
    }
  }
  return candidates;
}

function reverseOrder(socialOrder) {
  return socialOrder.slice().reverse();
}

// ---- Turn management ------------------------------------------------------

function firstPlayableSeat(cur_order) {
  for (let i = 0; i < cur_order.length; i++) if (cur_order[i] >= 1) return i;
  return -1;
}

// First still-playing seat strictly after `from` (wrapping): the lead passes
// clockwise to the next player who still has cards when the trick winner left
// the table by going out.
function nextPlayableSeatFrom(cur_order, from) {
  const n = cur_order.length;
  for (let step = 1; step <= n; step++) {
    const seat = (from + step) % n;
    if (cur_order[seat] >= 1) return seat;
  }
  return -1;
}

class Game {
  constructor() {
    this.state = game_state.WAITING;
    this.deck = prepareDeck();
    this.round = -1;
    this.cur_order_idx = -1;
    this.order = null;
    this.cur_order = null;
    this.last = null;
    this.shown = null;
    this.socialOrder = null;
    this.roles = {};
    this.revolution = null;
    this.taxes = null;
  }

  isPlaying() {
    return this.state === game_state.PLAYING;
  }

  // Build the participation arrays from the currently ready players and place
  // the first player (the Greater Dalmuti) at the front of the order.
  begin(roomData, socialOrder) {
    this.state = game_state.PLAYING;
    this.round++;
    this.socialOrder = socialOrder;
    this.roles = computeRoles(socialOrder);

    this.order = new Array(SEATS).fill(false);
    this.cur_order = new Array(SEATS).fill(-1);
    for (const sid of socialOrder) {
      const player = roomData.sockets[sid];
      if (!player) continue;
      this.order[player.seat] = true;
      this.cur_order[player.seat] = 1;
    }

    const leaderSid = socialOrder[0];
    const leader = roomData.sockets[leaderSid];
    this.cur_order_idx =
      leader && leader.seat >= 0
        ? leader.seat
        : firstPlayableSeat(this.cur_order);
    this.last = null;
    this.shown = null;
  }

  updateOrder(seat) {
    if (this.order) this.order[seat] = false;
    if (this.cur_order) this.cur_order[seat] = -1;
  }

  nextPlayer(selected_card, playerSid, roomData) {
    if (!this.cur_order) return undefined;
    this.cur_order_idx = (this.cur_order_idx + 1) % this.cur_order.length;
    while (this.cur_order[this.cur_order_idx] < 1) {
      this.cur_order_idx = (this.cur_order_idx + 1) % this.cur_order.length;
    }

    if (selected_card && Object.keys(selected_card).length > 0) {
      this.last = { num: null, count: 0, by: playerSid || null, handCount: null, cards: [] };
      for (const [card, val] of Object.entries(selected_card)) {
        if (Number(card) !== JOKER) this.last.num = Number(card);
        this.last.count += val;
      }
      // A play of only Jokers is a set of 13s (the lone-Joker lead or a Joker
      // pair); give it rank 13 so following and rendering treat it as a field.
      if (this.last.num === null) this.last.num = JOKER;
      // Keep the exact cards played (Jokers included) so the table can show a
      // Joker as a Joker rather than the rank it stood in for.
      this.last.cards = cardsFromSelection(selected_card);
      // Display copy: survives a completed trick so the winner's play stays on
      // the table, while `last` is cleared so the server still treats the next
      // play as a lead. `handCount` is filled in by the caller after the play.
      this.shown = { ...this.last };
    }

    let stillPlaying = 0;
    for (let i = 0; i < this.cur_order.length; i++) {
      if (this.cur_order[i] === 1) stillPlaying++;
    }
    if (stillPlaying <= 1) return this.nextRound(roomData);
    return undefined;
  }

  // A completed trick is won by whoever made the last play, and that player
  // leads the next trick (official rules). `roomData` is only needed if the
  // winner went out on that play and we must fall back to a still-seated leader.
  nextRound(roomData) {
    const winnerSid = this.last && this.last.by ? this.last.by : null;
    const winner = winnerSid && roomData ? roomData.sockets[winnerSid] : null;
    const winnerOut = !!(winner && winner.seat >= 0 && this.order && !this.order[winner.seat]);

    for (let i = 0; i < this.order.length; i++) {
      this.cur_order[i] = this.order[i] ? 1 : -1;
    }
    this.last = null;
    // The finished trick is shown, not cleared: the winner's play stays on the
    // table. When the winner went out (ending the game) handCount is 0, which
    // the client uses to label them the winner.
    this.shown = winnerSid
      ? {
          num: this.shown ? this.shown.num : null,
          count: this.shown ? this.shown.count : 0,
          cards: this.shown ? this.shown.cards : null,
          by: winnerSid,
          handCount: winnerOut ? 0 : this.shown ? this.shown.handCount : null,
        }
      : null;
    // The trick winner leads the next trick. If they went out on that play, the
    // lead passes clockwise to the next player who still has cards.
    if (winner && winner.seat >= 0 && this.cur_order[winner.seat] === 1) {
      this.cur_order_idx = winner.seat;
    } else if (winner && winner.seat >= 0) {
      this.cur_order_idx = nextPlayableSeatFrom(this.cur_order, winner.seat);
    } else {
      this.cur_order_idx = firstPlayableSeat(this.cur_order);
    }
    return true;
  }

  isOneLeft() {
    let cnt = 0;
    for (let i = 0; i < this.order.length; i++) if (this.order[i]) cnt++;
    return cnt <= 1;
  }

  end() {
    this.state = game_state.WAITING;
    this.last = null;
    this.shown = null;
    this.socialOrder = null;
    this.roles = {};
    this.revolution = null;
    this.taxes = null;
  }
}

module.exports = {
  SEATS,
  JOKER,
  CARD,
  ROLE,
  game_state,
  prepareDeck,
  shuffle,
  isPlainObject,
  validateSelection,
  handToCounts,
  checkValidity,
  selectionCount,
  checkRule,
  hasLegalPlay,
  applyPlay,
  cardsFromSelection,
  computeRoles,
  roleOf,
  drawForOrder,
  deal,
  computeTaxes,
  findRoleSid,
  peonBestCards,
  dalmutiWorstCards,
  removeCards,
  revolutionCandidates,
  reverseOrder,
  firstPlayableSeat,
  nextPlayableSeatFrom,
  Game,
};
