import { JOKER, type CardSelection, type LastPlay } from "./types";

/* Client-side mirror of server/game-engine.js checkRule, used only to enable the
 * Play button and to explain an invalid pick. The server remains the authority;
 * this never blocks a move the server would accept. */

export function selectionRanks(selection: CardSelection): number[] {
  return Object.keys(selection).map(Number);
}

export function selectionTotal(selection: CardSelection): number {
  let sum = 0;
  for (const count of Object.values(selection)) sum += count;
  return sum;
}

/** True when the selection could legally be led (table empty). */
export function canLead(selection: CardSelection): boolean {
  const ranks = selectionRanks(selection);
  if (ranks.length === 0) return false;
  if (ranks.length > 2) return false;
  if (ranks.length === 2 && !selection[JOKER]) return false;
  return true;
}

/** True when the selection legally follows the cards currently on the table. */
export function followsField(last: LastPlay, selection: CardSelection): boolean {
  const ranks = selectionRanks(selection);
  if (ranks.length === 0) return false;
  if (ranks.length > 2) return false;
  if (ranks.length === 2 && !selection[JOKER]) return false;
  if (selectionTotal(selection) !== last.count) return false;

  for (const rank of ranks) {
    if (ranks.length === 2 && rank === JOKER) continue;
    if (last.num - rank <= 0) return false;
  }
  return true;
}

export type MoveKind = "pass" | "play" | "invalid";

/** Classify a button press: play a selection, pass, or reject it. */
export function classifyMove(
  last: LastPlay | null,
  selection: CardSelection,
  tableEmpty: boolean
): MoveKind {
  if (selectionTotal(selection) === 0) return tableEmpty ? "invalid" : "pass";
  if (tableEmpty) return canLead(selection) ? "play" : "invalid";
  return followsField(last ?? { num: 0, count: 0, by: "" }, selection) ? "play" : "invalid";
}

/** Number of cards the field demands, or 0 when leading. */
export function fieldCount(last: LastPlay | null): number {
  return last && last.num ? last.count : 0;
}

/**
 * Whether the Play/Pass button must be disabled. It is inert off-turn, and while
 * leading (empty table) an empty selection cannot pass — the server rejects a
 * pass on an empty field, so the button must not offer one.
 */
export function playButtonDisabled(
  myTurn: boolean,
  hasSelection: boolean,
  tableEmpty: boolean
): boolean {
  return !myTurn || (!hasSelection && tableEmpty);
}

/**
 * True when the player holds at least one legal answer to the field. Mirrors
 * `followsField`/`checkRule`: a set of `count` copies of a lower rank, or the
 * `{Joker, lower rank}` pair. Used to skip the pass confirmation when passing is
 * the player's only action. Leading is always "playable" (you must play).
 */
export function hasLegalPlay(hand: readonly number[], last: LastPlay | null): boolean {
  if (!last || !last.num) return true;

  const need = last.count;
  const counts = new Map<number, number>();
  for (const card of hand) counts.set(card, (counts.get(card) ?? 0) + 1);

  for (const [rank, have] of counts) {
    if (rank !== JOKER && rank < last.num && have >= need) return true;
  }
  if (need === 2 && (counts.get(JOKER) ?? 0) >= 1) {
    for (const [rank, have] of counts) {
      if (rank !== JOKER && rank < last.num && have >= 1) return true;
    }
  }
  return false;
}

/**
 * The ranks that could ever take part in a legal play for the given field, or
 * `null` when there is no hint to give (the table is empty and almost anything
 * may be led). Used only to dim the hand; the server stays the authority.
 *
 * A legal follow is either one non-Joker card, or the pair {Joker, lower rank},
 * and its total must equal the field's count. So every rank below the field's
 * rank can answer; the Joker can only answer a *two*-card field (a Joker pair is
 * two cards and can never match a one- or three-card field). The field count does
 * not otherwise restrict which ranks are playable.
 */
export function playableRanks(last: LastPlay | null, tableEmpty: boolean): Set<number> | null {
  if (tableEmpty || !last) return null;

  const playable = new Set<number>();
  for (let rank = 1; rank < JOKER; rank++) {
    if (last.num - rank > 0) playable.add(rank);
  }
  if (last.count === 2 && last.num > 1) playable.add(JOKER);
  return playable;
}
