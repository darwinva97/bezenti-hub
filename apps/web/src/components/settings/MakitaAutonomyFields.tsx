import {
  MAKITA_BAD_WORK_LABEL_SUGGESTION,
  MAKITA_CLOSE_MIN_CONFIDENCE,
  MAKITA_CLOSE_PER_DAY,
  MAKITA_IDLE_PR_DAYS,
  type MakitaAutonomy,
} from "@t3tools/contracts";
import { useState } from "react";

import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

/** What a configuration does on its own (Makita tickets 25–27), in one line of its row. */
export const autonomyText = (autonomy: MakitaAutonomy) =>
  [
    autonomy.newIssues ? "every new issue" : null,
    autonomy.closeIssues
      ? `may close issues (confidence ${autonomy.closeMinConfidence.toFixed(2)}+, ${autonomy.closePerDay} a day)`
      : null,
    autonomy.closeIdlePrsDays === null
      ? null
      : `closes its pull requests idle ${autonomy.closeIdlePrsDays} days`,
    autonomy.badWorkLabel === null
      ? null
      : `label «${autonomy.badWorkLabel}» closes its pull request`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** A number typed as text: what is typed stays, the value is its number (NaN when it is none). */
function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly step: string;
  readonly onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  return (
    <label className="flex items-center gap-2 font-normal">
      <span className="text-muted-foreground">{props.label}</span>
      <Input
        aria-label={props.label}
        nativeInput
        className="w-24"
        inputMode="decimal"
        disabled={props.disabled}
        value={text}
        step={props.step}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          props.onChange(next.trim().length === 0 ? Number.NaN : Number(next));
        }}
      />
    </label>
  );
}

/**
 * «On its own» in the configuration form: every new issue, closing issues with a verdict,
 * closing idle pull requests and the bad-work label. Every option is off until ticked.
 */
export function MakitaAutonomyFields(props: {
  readonly value: MakitaAutonomy;
  readonly pushes: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: MakitaAutonomy) => void;
}) {
  const { value, disabled } = props;
  const set = (patch: Partial<MakitaAutonomy>) => props.onChange({ ...value, ...patch });
  const [label, setLabel] = useState(value.badWorkLabel ?? "");
  return (
    <div className="flex flex-col gap-2 text-xs font-medium">
      On its own
      <label className="flex items-center gap-2 font-normal">
        <Checkbox
          aria-label="Every new issue"
          disabled={disabled}
          checked={value.newIssues}
          onCheckedChange={(checked) => set({ newIssues: checked === true })}
        />
        Every new issue
      </label>
      {value.newIssues ? (
        <p className="rounded-md border border-warning/40 bg-warning/8 p-2 font-normal text-warning-foreground">
          Every issue opened from now on by someone it answers starts a task, without a label or a
          mention: each one spends AI usage. Issues opened by anyone else are ignored (the activity
          shows them) until Makita has a sandbox of its own and can answer anyone.
        </p>
      ) : null}
      <label className="flex items-center gap-2 font-normal">
        <Checkbox
          aria-label="May close issues"
          disabled={disabled}
          checked={value.closeIssues}
          onCheckedChange={(checked) => set({ closeIssues: checked === true })}
        />
        May close issues with a verdict
      </label>
      {value.closeIssues ? (
        <div className="flex flex-col gap-1 pl-6">
          <div className="flex flex-wrap gap-3">
            <NumberField
              label="Least confidence"
              step="0.05"
              disabled={disabled}
              value={value.closeMinConfidence}
              onChange={(closeMinConfidence) => set({ closeMinConfidence })}
            />
            <NumberField
              label="At most a day"
              step="1"
              disabled={disabled}
              value={value.closePerDay}
              onChange={(closePerDay) => set({ closePerDay })}
            />
          </div>
          <p className="font-normal text-muted-foreground">
            {`Makita posts its verdict (wanted, not wanted, duplicate, cannot reproduce, already fixed), its confidence (${MAKITA_CLOSE_MIN_CONFIDENCE.min} to ${MAKITA_CLOSE_MIN_CONFIDENCE.max}) and a reason, then closes. Only issues opened by someone it answers, or that someone it answers handed to it; never a stranger's on a stranger's word. Up to ${MAKITA_CLOSE_PER_DAY.max} a day. Reopening the issue or commenting /makita reopen undoes it, and Makita never closes that issue again.`}
          </p>
        </div>
      ) : null}
      {props.pushes ? (
        <>
          <label className="flex items-center gap-2 font-normal">
            <Checkbox
              aria-label="Close its idle pull requests"
              disabled={disabled}
              checked={value.closeIdlePrsDays !== null}
              onCheckedChange={(checked) =>
                set({ closeIdlePrsDays: checked === true ? MAKITA_IDLE_PR_DAYS.default : null })
              }
            />
            Close its pull requests idle for
            {value.closeIdlePrsDays === null ? (
              " N days"
            ) : (
              <NumberField
                label="Days"
                step="1"
                disabled={disabled}
                value={value.closeIdlePrsDays}
                onChange={(closeIdlePrsDays) => set({ closeIdlePrsDays })}
              />
            )}
          </label>
          {value.closeIdlePrsDays === null ? null : (
            <p className="pl-6 font-normal text-muted-foreground">
              {`From ${MAKITA_IDLE_PR_DAYS.min} to ${MAKITA_IDLE_PR_DAYS.max} days without a comment, review or push. Makita says why on the pull request, closes it, deletes its makita/… branch and ends the task; reopening it is fine. Never one waiting for an approval or while Makita works on it.`}
            </p>
          )}
          <label className="flex flex-col gap-1 font-normal">
            <span className="font-medium">Bad-work label</span>
            <Input
              aria-label="Bad-work label"
              nativeInput
              maxLength={50}
              disabled={disabled}
              placeholder={`Off (for example ${MAKITA_BAD_WORK_LABEL_SUGGESTION})`}
              value={label}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setLabel(next);
                set({ badWorkLabel: next.trim().length === 0 ? null : next });
              }}
            />
            <span className="text-muted-foreground">
              When an approver adds this label to one of Makita's pull requests, the Hub closes it
              at once, deletes its branch and stops the task. Anyone else adding it does nothing.
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}
