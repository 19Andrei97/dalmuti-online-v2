import type { CardSelection } from "./types";

/* Card selection model shared by the hand and the tax prompt.
 *
 * The old UI toggled a single card per click, so playing a set of, say, four
 * peasants took four clicks and passing a mis-click was easy. This model makes
 * the common actions one click:
 *
 *   - toggleRank(v): click a rank -> select every copy you hold of it (capped to
 *     the required count when the table demands one), click again -> deselect all.
 *   - toggleOne(v):  fine adjustment of a single copy (Shift-click / long press).
 *
 * A non-zero `limit` mirrors the rule that a follow play must match the number of
 * cards on the table, and the tax prompt must hand over an exact count. */

export class SelectionModel {
  private held = new Map<number, number>();
  private sel = new Map<number, number>();
  private limit = 0;
  private playable: Set<number> | null = null;

  setHand(hand: readonly number[]): void {
    this.held.clear();
    for (const card of hand) this.held.set(card, (this.held.get(card) ?? 0) + 1);
    // Drop selections that are no longer backed by the hand.
    for (const [value, count] of this.sel) {
      const have = this.held.get(value) ?? 0;
      if (have === 0) this.sel.delete(value);
      else if (count > have) this.sel.set(value, have);
    }
    this.clampToLimit();
  }

  /**
   * Ranks that may take part in a play (a rule hint), or `null` for "no hint"
   * (e.g. leading, or the tax prompt where every card is selectable).
   */
  setPlayable(ranks: Set<number> | null): void {
    this.playable = ranks;
  }

  isPlayable(value: number): boolean {
    return this.playable === null || this.playable.has(value);
  }

  /** Required number of cards, or 0 for "no requirement" (leading / open pick). */
  setLimit(n: number): void {
    this.limit = Math.max(0, n);
    this.clampToLimit();
  }

  /** Trim picks that exceed the current limit (e.g. a smaller follow play). */
  private clampToLimit(): void {
    if (this.limit <= 0) return;
    let total = this.total();
    if (total <= this.limit) return;
    for (const [value, count] of [...this.sel]) {
      if (total <= this.limit) break;
      const drop = Math.min(count, total - this.limit);
      const next = count - drop;
      if (next === 0) this.sel.delete(value);
      else this.sel.set(value, next);
      total -= drop;
    }
  }

  get limitValue(): number {
    return this.limit;
  }

  total(): number {
    let sum = 0;
    for (const count of this.sel.values()) sum += count;
    return sum;
  }

  countOf(value: number): number {
    return this.held.get(value) ?? 0;
  }

  selectedCountOf(value: number): number {
    return this.sel.get(value) ?? 0;
  }

  isRankSelected(value: number): boolean {
    return (this.sel.get(value) ?? 0) > 0;
  }

  isRankFullySelected(value: number): boolean {
    const have = this.held.get(value) ?? 0;
    return have > 0 && (this.sel.get(value) ?? 0) === have;
  }

  selection(): CardSelection {
    const out: CardSelection = {};
    for (const [value, count] of this.sel) if (count > 0) out[value] = count;
    return out;
  }

  isEmpty(): boolean {
    return this.total() === 0;
  }

  clear(): void {
    this.sel.clear();
  }

  private remaining(): number {
    return this.limit > 0 ? this.limit - this.total() : Infinity;
  }

  /**
   * Cap on how many copies of a rank can be picked in one go. When the field
   * demands `limit` cards, a rank's bulk pick is trimmed to the copies actually
   * needed (and never more than you hold).
   */
  private maxSelectable(value: number): number {
    const have = this.held.get(value) ?? 0;
    return this.limit > 0 ? Math.min(have, this.limit) : have;
  }

  /** Select a rank's copies (capped to the field count), or clear it if already picked. */
  toggleRank(value: number): boolean {
    if (!this.isPlayable(value)) return false;
    const have = this.held.get(value) ?? 0;
    if (have === 0) return false;

    if (this.isRankSelected(value)) {
      this.sel.delete(value);
      return true;
    }

    const room = this.remaining();
    const add = Math.min(this.maxSelectable(value), room);
    if (add <= 0) return false;
    this.sel.set(value, add);
    return true;
  }

  /** Add or remove a single copy of a rank. */
  toggleOne(value: number): boolean {
    if (!this.isPlayable(value)) return false;
    const have = this.held.get(value) ?? 0;
    if (have === 0) return false;
    const cur = this.sel.get(value) ?? 0;

    if (cur < this.maxSelectable(value) && this.remaining() > 0) {
      this.sel.set(value, cur + 1);
      return true;
    }
    if (cur > 0) {
      const next = cur - 1;
      if (next === 0) this.sel.delete(value);
      else this.sel.set(value, next);
      return true;
    }
    return false;
  }
}
