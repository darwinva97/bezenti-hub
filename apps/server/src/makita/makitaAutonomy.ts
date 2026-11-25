/**
 * Makita tickets 25–27: a configuration's `autonomy_json`, read leniently (every option off when
 * absent), checked when its creator saves it, and what changed for the audit. Pure.
 */
import {
  MAKITA_AUTONOMY_OFF,
  MAKITA_CLOSE_MIN_CONFIDENCE,
  MAKITA_CLOSE_PER_DAY,
  MAKITA_IDLE_PR_DAYS,
  type MakitaAutonomy,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What the column holds: the options, and since when «Every new issue» is on (Hub time). */
export interface StoredAutonomy extends MakitaAutonomy {
  readonly newIssuesSince: string | null;
}

const Stored = Schema.Struct({
  newIssues: Schema.optional(Schema.Boolean),
  newIssuesSince: Schema.optional(Schema.NullOr(Schema.String)),
  closeIssues: Schema.optional(Schema.Boolean),
  closeMinConfidence: Schema.optional(Schema.Number),
  closePerDay: Schema.optional(Schema.Number),
  closeIdlePrsDays: Schema.optional(Schema.NullOr(Schema.Number)),
  badWorkLabel: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

/** The stored options; anything missing or unreadable is off. */
export const storedAutonomyOf = (json: string | null | undefined): StoredAutonomy => {
  const read = Option.getOrUndefined(decodeStored(json ?? "{}"));
  const off = MAKITA_AUTONOMY_OFF;
  return {
    newIssues: read?.newIssues ?? off.newIssues,
    newIssuesSince: read?.newIssues === true ? (read.newIssuesSince ?? null) : null,
    closeIssues: read?.closeIssues ?? off.closeIssues,
    closeMinConfidence: read?.closeMinConfidence ?? off.closeMinConfidence,
    closePerDay: read?.closePerDay ?? off.closePerDay,
    closeIdlePrsDays: read?.closeIdlePrsDays ?? off.closeIdlePrsDays,
    badWorkLabel: read?.badWorkLabel ?? off.badWorkLabel,
  };
};

/** What a viewer sees of it. */
export const autonomyView = (stored: StoredAutonomy): MakitaAutonomy => ({
  newIssues: stored.newIssues,
  closeIssues: stored.closeIssues,
  closeMinConfidence: stored.closeMinConfidence,
  closePerDay: stored.closePerDay,
  closeIdlePrsDays: stored.closeIdlePrsDays,
  badWorkLabel: stored.badWorkLabel,
});

/** The options a creator saves, checked; `triggerLabel` is the label that hands issues over. */
export const checkAutonomy = (
  input: MakitaAutonomy,
  triggerLabel: string | null,
):
  | { readonly _tag: "ok"; readonly value: MakitaAutonomy }
  | { readonly _tag: "refused"; readonly message: string } => {
  const refused = (message: string) => ({ _tag: "refused", message }) as const;
  const confidence = input.closeMinConfidence;
  if (
    !Number.isFinite(confidence) ||
    confidence < MAKITA_CLOSE_MIN_CONFIDENCE.min ||
    confidence > MAKITA_CLOSE_MIN_CONFIDENCE.max
  ) {
    return refused(
      `The confidence a close needs is between ${MAKITA_CLOSE_MIN_CONFIDENCE.min} and ${MAKITA_CLOSE_MIN_CONFIDENCE.max}.`,
    );
  }
  const perDay = input.closePerDay;
  if (
    !Number.isInteger(perDay) ||
    perDay < MAKITA_CLOSE_PER_DAY.min ||
    perDay > MAKITA_CLOSE_PER_DAY.max
  ) {
    return refused(
      `Makita closes from ${MAKITA_CLOSE_PER_DAY.min} to ${MAKITA_CLOSE_PER_DAY.max} issues a day.`,
    );
  }
  const days = input.closeIdlePrsDays;
  if (
    days !== null &&
    (!Number.isInteger(days) || days < MAKITA_IDLE_PR_DAYS.min || days > MAKITA_IDLE_PR_DAYS.max)
  ) {
    return refused(
      `Idle pull requests are closed after ${MAKITA_IDLE_PR_DAYS.min} to ${MAKITA_IDLE_PR_DAYS.max} days.`,
    );
  }
  const raw = input.badWorkLabel ?? "";
  const label = raw.trim();
  if (label.length > 50 || (raw.length > 0 && label.length === 0)) {
    return refused("Name the bad-work label in up to 50 characters, or leave it empty.");
  }
  if (label.length > 0 && label.toLowerCase() === triggerLabel?.trim().toLowerCase()) {
    return refused("The bad-work label must differ from the label that hands an issue to Makita.");
  }
  return {
    _tag: "ok",
    value: {
      newIssues: input.newIssues,
      closeIssues: input.closeIssues,
      closeMinConfidence: Math.round(confidence * 100) / 100,
      closePerDay: perDay,
      closeIdlePrsDays: days,
      badWorkLabel: label.length === 0 ? null : label,
    },
  };
};

const FIELD_NAMES: ReadonlyArray<readonly [keyof MakitaAutonomy, string]> = [
  ["newIssues", "new_issues"],
  ["closeIssues", "close_issues"],
  ["closeMinConfidence", "close_issues"],
  ["closePerDay", "close_issues"],
  ["closeIdlePrsDays", "close_idle_prs"],
  ["badWorkLabel", "bad_work_label"],
];

/**
 * What to store after a save: the checked options (or, left out, the stored ones), with
 * «Every new issue» dated from the moment it is switched on, and the fields that changed.
 */
export const nextAutonomy = (
  previousJson: string | null,
  input: MakitaAutonomy | undefined,
  at: string,
): {
  readonly json: string;
  readonly view: MakitaAutonomy;
  readonly changed: ReadonlyArray<string>;
} => {
  const previous = storedAutonomyOf(previousJson);
  const view = input ?? autonomyView(previous);
  const stored: StoredAutonomy = {
    ...view,
    newIssuesSince: view.newIssues
      ? previous.newIssues && previous.newIssuesSince !== null
        ? previous.newIssuesSince
        : at
      : null,
  };
  const changed = [
    ...new Set(
      FIELD_NAMES.filter(([field]) => previous[field] !== view[field]).map(([, name]) => name),
    ),
  ];
  return { json: JSON.stringify(stored), view, changed };
};

/** The options on, by name, for the audit (`none` when everything is off). */
export const autonomyNames = (view: MakitaAutonomy) => {
  const on = [
    view.newIssues ? "new-issues" : null,
    view.closeIssues ? "close-issues" : null,
    view.closeIdlePrsDays === null ? null : "close-idle-prs",
    view.badWorkLabel === null ? null : "bad-work-label",
  ].filter((name) => name !== null);
  return on.length === 0 ? "none" : on.join(",");
};
