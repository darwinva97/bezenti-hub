import * as Schema from "effect/Schema";

/**
 * Makita tickets 25–27: what a configuration does on its own, like robobun in oven-sh/bun. Every
 * option is off by default and the Hub checks each again at the next event.
 */
export const MakitaAutonomy = Schema.Struct({
  /** Ticket 25: every issue opened from now on by someone it answers starts a task. */
  newIssues: Schema.Boolean,
  /** Ticket 26: the agent may ask the Hub to close its task's issue with a verdict. */
  closeIssues: Schema.Boolean,
  /** The least confidence (0.5–1) a close needs. */
  closeMinConfidence: Schema.Number,
  /** At most this many closes a day by this configuration. */
  closePerDay: Schema.Number,
  /** Ticket 27: its own pull requests idle this many days are closed; null: never. */
  closeIdlePrsDays: Schema.NullOr(Schema.Number),
  /** Ticket 27: an approver's label that closes one of its pull requests at once; null: none. */
  badWorkLabel: Schema.NullOr(Schema.String),
});
export type MakitaAutonomy = typeof MakitaAutonomy.Type;

export const MAKITA_CLOSE_MIN_CONFIDENCE = { min: 0.5, max: 1, default: 0.8 } as const;
export const MAKITA_CLOSE_PER_DAY = { min: 1, max: 50, default: 10 } as const;
export const MAKITA_IDLE_PR_DAYS = { min: 7, max: 180, default: 90 } as const;
export const MAKITA_BAD_WORK_LABEL_SUGGESTION = "slop";

/** Everything off: what a configuration does until its creator turns something on. */
export const MAKITA_AUTONOMY_OFF: MakitaAutonomy = {
  newIssues: false,
  closeIssues: false,
  closeMinConfidence: MAKITA_CLOSE_MIN_CONFIDENCE.default,
  closePerDay: MAKITA_CLOSE_PER_DAY.default,
  closeIdlePrsDays: null,
  badWorkLabel: null,
};
