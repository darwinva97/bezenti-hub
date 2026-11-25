/**
 * Makita ticket 24, pure: the labels a configuration lets Makita set (checked on save), and which
 * of the names an agent asks for it may set. The trigger label is never one of them.
 */
import { MAKITA_MAX_LABELS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** GitHub's own limit on a label's name. */
const MAX_LABEL_LENGTH = 50;

const decodeNames = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeRepoLabels = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
);

/** The names in `GET /repos/{o}/{r}/labels`; none when it cannot be read. */
export const repoLabelNames = (body: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeRepoLabels(body), () => []).map((label) => label.name);

/** A stored list (`labels_json`), empty when it cannot be read. */
export const labelsOf = (json: string | null | undefined): ReadonlyArray<string> =>
  json === null || json === undefined ? [] : Option.getOrElse(decodeNames(json), () => []);

/**
 * A configuration's list as its creator wrote it: trimmed, each once (ignoring case), at most
 * `MAKITA_MAX_LABELS`, never the trigger label. A refusal says why, in words for the person.
 */
export const checkedLabels = (
  input: ReadonlyArray<string>,
  triggerLabel: string | null,
):
  | { readonly _tag: "ok"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly message: string } => {
  const refused = (message: string) => ({ _tag: "refused", message }) as const;
  const names = input.map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length > MAKITA_MAX_LABELS) {
    return refused(`Name at most ${MAKITA_MAX_LABELS} labels Makita may set.`);
  }
  const long = names.find((name) => name.length > MAX_LABEL_LENGTH || /[\r\n]/u.test(name));
  if (long !== undefined) {
    return refused(`«${long.slice(0, 60)}» is not a label name (up to ${MAX_LABEL_LENGTH}).`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) return refused(`«${name}» is listed twice.`);
    seen.add(name.toLowerCase());
  }
  if (triggerLabel !== null && seen.has(triggerLabel.toLowerCase())) {
    return refused(`«${triggerLabel}» hands issues to Makita; Makita can't set it.`);
  }
  return { _tag: "ok", labels: names };
};

/**
 * The configured spelling of each name the agent asked for, or the first it may not set: off the
 * list, or the trigger label (even if someone listed it before the rule).
 */
export const allowedLabels = (
  asked: ReadonlyArray<string>,
  configured: ReadonlyArray<string>,
  triggerLabel: string | null,
):
  | { readonly _tag: "ok"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly name: string } => {
  const byLower = new Map(configured.map((name) => [name.toLowerCase(), name]));
  const labels: Array<string> = [];
  for (const raw of asked) {
    const name = raw.trim();
    const known = byLower.get(name.toLowerCase());
    if (
      known === undefined ||
      (triggerLabel !== null && name.toLowerCase() === triggerLabel.toLowerCase())
    ) {
      return { _tag: "refused", name };
    }
    if (!labels.includes(known)) labels.push(known);
  }
  return { _tag: "ok", labels };
};
