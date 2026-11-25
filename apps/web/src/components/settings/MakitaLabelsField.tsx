import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  MAKITA_MAX_LABELS,
  type MakitaRepos,
  type SpaceId,
} from "@t3tools/contracts";
import { useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { makitaEnvironment } from "../../state/makita";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** The names in the field: separated by commas, trimmed, without empties. */
export const labelNamesOf = (text: string) =>
  text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

/**
 * Makita ticket 24: the labels Makita may add or remove on its issue or pull request, as names
 * separated by commas, and the labels that already exist in the chosen repositories to pick from.
 */
export function MakitaLabelsField(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly repos: MakitaRepos;
  readonly triggerLabel: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled: boolean;
}) {
  const readLabels = useAtomCommand(makitaEnvironment.repoLabels, "read the repositories' labels");
  const [offered, setOffered] = useState<ReadonlyArray<string> | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = labelNamesOf(props.value);
  const chosen = new Set(names.map((name) => name.toLowerCase()));
  const trigger = props.triggerLabel.trim().toLowerCase();
  const canPick = "all" in props.repos || props.repos.projects.length > 0;

  const read = async () => {
    setReading(true);
    setError(null);
    const result = await readLabels({
      environmentId: props.environmentId,
      input: { spaceId: props.spaceId, repos: props.repos },
    });
    setReading(false);
    if (result._tag === "Success") setOffered(result.value.labels);
    else setError(errorMessageOf(squashAtomCommandFailure(result), "Could not read the labels."));
  };

  return (
    <div className="flex flex-col gap-1 text-xs font-medium">
      Labels Makita may set
      <Input
        aria-label="Labels Makita may set"
        nativeInput
        disabled={props.disabled}
        placeholder="bug, area: login, confirmed bug"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <p className="font-normal text-muted-foreground">
        {`Separated by commas, up to ${MAKITA_MAX_LABELS}. Makita adds or removes only these on its issue or pull request, never the label that hands issues to it. Leave it empty and Makita never labels.`}
      </p>
      {offered === null ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="self-start"
          disabled={props.disabled || reading || !canPick}
          onClick={() => void read()}
        >
          {reading ? "Reading…" : "Show the labels in these repositories"}
        </Button>
      ) : offered.length === 0 ? (
        <p className="font-normal text-muted-foreground">No labels in these repositories yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1 font-normal" aria-label="Labels in these repositories">
          {offered.map((name) => {
            const taken = chosen.has(name.toLowerCase()) || name.toLowerCase() === trigger;
            return (
              <li key={name}>
                <Button
                  type="button"
                  size="xs"
                  variant={taken ? "secondary" : "outline"}
                  disabled={props.disabled || taken || names.length >= MAKITA_MAX_LABELS}
                  onClick={() => props.onChange([...names, name].join(", "))}
                >
                  {name}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error === null ? null : (
        <p className="font-normal text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
