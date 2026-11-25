import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  MAKITA_HUB_MAX_TASKS_LIMIT,
  type MakitaAccountView,
} from "@t3tools/contracts";
import { useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { makitaEnvironment } from "../../state/makita";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InfoTip } from "./InfoTip";
import { SettingsSection } from "./settingsLayout";

/**
 * Platform → Makita (Makita ticket 22): the Owner's ceiling on Makita tasks at work at once
 * across every configuration of the Hub. It wins over each configuration's own limit.
 */
export function MakitaHubTaskLimit({
  environmentId,
  account,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: MakitaAccountView;
  readonly onSaved: (account: MakitaAccountView | null) => void;
}) {
  const save = useAtomCommand(makitaEnvironment.setTaskLimit, "change Makita's task limit");
  const [value, setValue] = useState(String(account.maxTasks));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = Number(value);
  const valid = Number.isInteger(next) && next >= 1 && next <= MAKITA_HUB_MAX_TASKS_LIMIT;
  const changed = valid && next !== account.maxTasks;

  return (
    <SettingsSection
      id="makita-task-limit"
      title="Tasks at once"
      titleAction={
        <InfoTip label="About Makita's task limit">
          How many Makita tasks may work at the same time across all configurations of this Hub.
          Each configuration also has its own limit; the lower one wins. More issues wait in line
          and start as tasks end. A reply on an issue Makita already works on never waits.
        </InfoTip>
      }
    >
      <form
        className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed) return;
          setPending(true);
          void save({ environmentId, input: { maxTasks: next } })
            .then((result) => {
              if (result._tag === "Success") {
                setError(null);
                onSaved(result.value.account);
                return;
              }
              setError(
                errorMessageOf(squashAtomCommandFailure(result), "Could not change the limit."),
              );
            })
            .finally(() => setPending(false));
        }}
      >
        <label className="flex items-center gap-2">
          At most
          <Input
            aria-label="Makita tasks at once across the Hub"
            className="w-20"
            nativeInput
            type="number"
            min={1}
            max={MAKITA_HUB_MAX_TASKS_LIMIT}
            disabled={pending}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          tasks at once across all configurations
        </label>
        <Button size="xs" type="submit" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {error === null ? null : (
          <p className="w-full text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </form>
    </SettingsSection>
  );
}
