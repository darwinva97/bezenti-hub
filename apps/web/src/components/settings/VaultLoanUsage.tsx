import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Grant, GrantVaultUsage } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/**
 * Grants ticket 15: a lent Vault group's use. Per day (UTC), User of the borrowing Space and name,
 * how many processes (turns, terminals, scripts) received it. Its lender and the borrowing
 * Space's Admins read it; never a value, a Thread or a prompt.
 */
export function VaultLoanUsage({
  environmentId,
  grant,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: Grant;
}) {
  const vaultUsage = useAtomCommand(grantsEnvironment.vaultUsage, "read a loan's use");
  const [usage, setUsage] = useState<GrantVaultUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useEffectEvent((target: EnvironmentId, grantId: Grant["id"]) =>
    vaultUsage({ environmentId: target, input: { grantId } }).then((read) => {
      if (read._tag === "Success") {
        setUsage(read.value);
        setError(null);
        return;
      }
      setError(errorMessageOf(squashAtomCommandFailure(read), "Could not read the loan's use."));
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the loan's use from the Hub when the panel opens.
  useEffect(() => {
    void load(environmentId, grant.id);
  }, [environmentId, grant.id]);
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      aria-label={`Use of ${grant.resource.name ?? "the Vault group"}`}
    >
      <p className="font-medium">Processes that received a name of this group</p>
      {error !== null ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : usage === null ? (
        <p className="text-muted-foreground">Reading the use…</p>
      ) : usage.rows.length === 0 ? (
        <p className="text-muted-foreground">No process has received a name of it yet.</p>
      ) : (
        <Table aria-label="Loan use by day, User and name">
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-end">Processes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.rows.map((row) => (
              <TableRow key={`${row.day}|${row.userId}|${row.name}`}>
                <TableCell>{row.day}</TableCell>
                <TableCell>{row.userName ?? "A former User"}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-end">{row.deliveries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-muted-foreground">
        Counted by UTC day each time a turn, terminal or script of the borrowing Space starts with a
        name of this group: names and counts only, never values, Threads or prompts.
        {usage?.truncated === true ? " Only the most recent rows are shown." : ""}
      </p>
    </div>
  );
}
