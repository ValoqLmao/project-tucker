/**
 * Reaction moves: one- or two-second bits of body language that punctuate what she says.
 * A laugh that shakes her shoulders, a shy look away, a shrug. They are added on top of whatever
 * the idle animation is doing, and are rationed so they stay reactions rather than tics.
 */

/** Offsets in radians. hp/hy/hr: head pitch (+ chin down), yaw, roll. cp/sp: chest and spine pitch. sh: shoulders raised. */
export type MoveOffsets = { hp?: number; hy?: number; hr?: number; cp?: number; sp?: number; sh?: number };
type Move = { dur: number; at: (p: number, side: number) => MoveOffsets };

const bell = (p: number) => Math.sin(Math.PI * p);
const smooth = (x: number) => x * x * (3 - 2 * x);

const MOVES: Record<string, Move> = {
  // Head tips back, shoulders bounce.
  laugh: { dur: 1.2, at: (p) => { const b = bell(p); return { hp: -0.07 * b + Math.sin(p * 24) * 0.012 * b, cp: -0.03 * b, sh: Math.abs(Math.sin(p * 21)) * 0.05 * b }; } },
  // Turns her face away and down, holds, comes back. Her eyes stay on you, so it reads as a shy peek.
  lookAway: { dur: 2, at: (p, s) => { const e = smooth(p < 0.25 ? p / 0.25 : p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3); return { hy: 0.26 * s * e, hp: 0.07 * e, hr: 0.04 * s * e }; } },
  // Small "no" shake.
  shake: { dur: 1, at: (p) => ({ hy: Math.sin(p * Math.PI * 4) * 0.08 * bell(p) }) },
  shrug: { dur: 0.9, at: (p, s) => { const b = bell(p); return { sh: 0.12 * b, hr: 0.05 * s * b }; } },
  // Quick toss of the head; the hair physics does the rest.
  flick: { dur: 0.8, at: (p, s) => { const b = bell(Math.min(1, p * 1.6)); return { hy: 0.15 * s * b * (1 - p), hr: -0.09 * s * b, hp: -0.04 * b }; } },
  // Chest rises, then everything drops.
  sigh: { dur: 1.9, at: (p) => { const up = bell(Math.min(1, p / 0.4)); const down = p > 0.4 ? bell((p - 0.4) / 0.6) : 0; return { cp: -0.03 * up + 0.04 * down, sh: 0.05 * up - 0.03 * down, hp: 0.07 * down }; } },
  startle: { dur: 0.7, at: (p) => { const b = bell(Math.sqrt(p)); return { sp: -0.05 * b, sh: 0.08 * b, hp: -0.05 * b }; } },
  leanIn: { dur: 1.7, at: (p) => { const b = bell(p); return { sp: 0.07 * b, hp: -0.03 * b }; } },
  nod: { dur: 0.9, at: (p) => ({ hp: Math.max(0, Math.sin(p * Math.PI * 2)) * 0.07 * (1 - p * 0.4) }) },
};

// Which move suits which expression, and how often it should actually happen.
const FOR_EXPRESSION: Record<string, [string, number][]> = {
  laughing: [['laugh', 0.9]], happy: [['nod', 0.3]], excited: [['leanIn', 0.5]],
  teasing: [['flick', 0.5], ['leanIn', 0.2]], smug: [['shrug', 0.35], ['flick', 0.3]], flirty: [['leanIn', 0.6]],
  shy: [['lookAway', 0.9]], playful: [['flick', 0.6]], curious: [['leanIn', 0.5]], surprised: [['startle', 0.9]],
  concerned: [['leanIn', 0.5]], sad: [['sigh', 0.35]], sigh: [['sigh', 0.9]], pout: [['lookAway', 0.7]],
  annoyed: [['shake', 0.5]], angry: [['shake', 0.3]], deadpan: [['shrug', 0.3]], warm: [['nod', 0.3]],
};

const ANY_COOLDOWN = 4; // seconds between any two moves
const SAME_COOLDOWN = 14; // seconds before the same move may repeat

export class Moves {
  private current: { move: Move; t: number; side: number } | null = null;
  private sinceAny = 99;
  private last = new Map<string, number>();
  private clock = 0;

  /** Maybe start a move that fits this expression. Stronger feelings are more likely to show in the body. */
  react(expression: string, strength: number) {
    if (this.current || this.sinceAny < ANY_COOLDOWN) return;
    for (const [name, chance] of FOR_EXPRESSION[expression] ?? []) {
      if (this.clock - (this.last.get(name) ?? -99) < SAME_COOLDOWN) continue;
      if (Math.random() > chance * Math.min(1, strength + 0.25)) continue;
      this.current = { move: MOVES[name], t: 0, side: Math.random() < 0.5 ? -1 : 1 };
      this.last.set(name, this.clock);
      this.sinceAny = 0;
      return;
    }
  }

  update(dt: number): MoveOffsets {
    this.clock += dt;
    this.sinceAny += dt;
    if (!this.current) return {};
    this.current.t += dt;
    const p = this.current.t / this.current.move.dur;
    if (p >= 1) { this.current = null; return {}; }
    return this.current.move.at(p, this.current.side);
  }
}
