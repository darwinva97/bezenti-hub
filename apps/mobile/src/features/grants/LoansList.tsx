import { useAtomValue } from "@effect/atom-react";
import {
  endingWarning,
  groupLenderSays,
  groupLentLoans,
  lenderSees,
  lentCountText,
  limitsText,
  loanDescription,
  loanStatusParts,
  nounOf,
  offerStatusText,
  receivedSections,
  recipientLabel,
  stateText,
  targetLabel,
} from "@t3tools/client-runtime/grants-view";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Grant } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import type { SavedRemoteConnection } from "../../lib/connection";
import { grantsEnvironment } from "../../state/grants";
import { reasonOf } from "../../state/space-admin";
import { reloadSpaces } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "../ai-accounts/failureMessage";
import { acceptLoan, MACHINE_ON_WEB_NOTE } from "./acceptLoan";
import { LoanUse } from "./LoanUse";

interface Loans {
  readonly given: ReadonlyArray<Grant>;
  readonly received: ReadonlyArray<Grant>;
}

async function settle<A>(pending: Promise<AtomCommandResult<A, unknown>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(commandFailureMessage(result, "That change did not go through."));
}

const nameOf = (grant: Grant) => grant.resource.name ?? `A ${nounOf(grant)}`;

/**
 * Settings → Loans on a phone: waiting, borrowed, ended and lent loans with web's words
 * (`grants-view`). Accepting a machine (strong factor) and lending (limits) stay on web and
 * desktop; the Hub decides again on every call.
 */
export function LoansList(props: { readonly connection: SavedRemoteConnection }) {
  return <LoansPage key={props.connection.environmentId} connection={props.connection} />;
}

function LoansPage(props: { readonly connection: SavedRemoteConnection }) {
  const { connection } = props;
  const environmentId = connection.environmentId;
  const listGiven = useAtomCommand(grantsEnvironment.listGiven, "list your loans");
  const listReceived = useAtomCommand(grantsEnvironment.listReceived, "list your Spaces' loans");
  const reject = useAtomCommand(grantsEnvironment.reject, "reject a loan");
  const cancel = useAtomCommand(grantsEnvironment.cancel, "cancel a loan");
  const end = useAtomCommand(grantsEnvironment.end, "end a loan");
  const mayChange = useAtomValue(grantsEnvironment.end.permissionAtom(environmentId));
  const [loans, setLoans] = useState<Loans | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [usageOf, setUsageOf] = useState<string | null>(null);
  // A Vault group's loan, accepted with or without becoming one of the Space's defaults.
  const [acceptingGroup, setAcceptingGroup] = useState<{
    readonly id: string;
    readonly useAsDefault: boolean;
  } | null>(null);

  const fetchLoans = useEffectEvent(async (target: EnvironmentId): Promise<Loans> => {
    const [given, received] = await Promise.all([
      settle(listGiven({ environmentId: target, input: {} })),
      settle(listReceived({ environmentId: target, input: {} })),
    ]);
    return { given: given.grants, received: received.grants };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the User's loans from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void fetchLoans(environmentId).then(
      (read) => {
        if (!cancelled) setLoans(read);
      },
      (cause: unknown) => {
        if (!cancelled) setError(reasonOf(cause, "Could not read the loans."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const reload = async () => {
    try {
      setLoans(await fetchLoans(environmentId));
      setError(null);
    } catch (cause) {
      setError(reasonOf(cause, "Could not read the loans."));
    }
  };

  /** One change, then the lists again; a decision also refreshes the Spaces' waiting counts. */
  const run = async (change: () => Promise<unknown>, decides: boolean) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setAcceptingGroup(null);
      await reload();
      if (decides) void reloadSpaces(connection);
    } catch (cause) {
      setError(reasonOf(cause, "That change did not go through."));
    } finally {
      setPending(false);
    }
  };

  const confirmEnd = (grant: Grant) => {
    const takeBack = grant.can.revoke;
    const toRotate =
      takeBack && grant.resource.kind === "vault-group"
        ? (grant.vaultGroup?.toRotate ?? []).map((entry) => entry.name)
        : [];
    Dialog.confirm({
      title: `${takeBack ? "Take back" : "Give back"} ${grant.resource.name ?? `this ${nounOf(grant)}`}?`,
      message: `${endingWarning(grant)}${
        toRotate.length === 0
          ? ""
          : ` Values may have been read. Rotate these Secrets: ${toRotate.join(", ")}.`
      }`,
      cancelText: "Keep it",
      confirmText: takeBack ? "Take back" : "Give back",
      destructive: true,
      onConfirm: () =>
        void run(() => settle(end({ environmentId, input: { grantId: grant.id } })), false),
    });
  };

  const panelButton = (grant: Grant) => (
    <Button
      label={usageOf === grant.id ? "Hide use" : "Use"}
      accessibilityLabel={`${usageOf === grant.id ? "Hide use" : "Use"} of ${nameOf(grant)}`}
      tone="text"
      size="compact"
      onPress={() => setUsageOf(usageOf === grant.id ? null : grant.id)}
    />
  );

  if (loans === null) {
    return (
      <View className="gap-3">
        {error === null ? (
          <Text className="px-2 text-sm text-foreground-muted">Loading loans…</Text>
        ) : (
          <ErrorRow message={error} onRetry={() => void reload()} />
        )}
      </View>
    );
  }

  const { waiting, borrowed, ended } = receivedSections(loans.received);
  const lentGroups = groupLentLoans(loans.given);
  const nothing = waiting.length + borrowed.length + ended.length + lentGroups.length === 0;

  return (
    <View className="gap-6">
      {error === null ? null : <ErrorRow message={error} onRetry={() => void reload()} />}
      {nothing ? (
        <Text className="px-2 text-sm text-foreground-muted">
          No loans yet. Lend a machine, an AI account or a Vault group from the web or desktop app.
        </Text>
      ) : null}
      {waiting.length === 0 ? null : (
        <ListSection title="Waiting for you">
          {waiting.map((grant) => {
            const machine = grant.resource.kind === "environment";
            const choosing = acceptingGroup?.id === grant.id ? acceptingGroup : null;
            return (
              <View
                key={grant.id}
                accessibilityLabel={`Waiting: ${nameOf(grant)}`}
                className="gap-1 px-4 py-3"
              >
                <Text className="text-base text-foreground">
                  {nameOf(grant)} for {targetLabel(grant, "your Space")}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  Waiting for you: lent by {grant.lender.name ?? "another User"} ·{" "}
                  {limitsText(grant.limits)}
                </Text>
                <Text className="text-sm text-warning-foreground">{lenderSees(grant)}</Text>
                {machine ? (
                  <Text className="text-sm text-foreground-muted">{MACHINE_ON_WEB_NOTE}</Text>
                ) : null}
                {choosing !== null ? (
                  <View className="gap-2">
                    <Text className="text-sm text-foreground-muted">
                      {groupLenderSays(grant.lender.name ?? "Its lender")} Your Space sees its
                      Variables and the names of its Secrets, never a Secret's value.
                    </Text>
                    <ListToggleRow
                      label={`Also use it as a default of ${targetLabel(grant, "this Space")}`}
                      description="Every Thread there receives it, after the Space's own defaults"
                      value={choosing.useAsDefault}
                      disabled={pending}
                      onValueChange={(useAsDefault) =>
                        setAcceptingGroup({ id: grant.id, useAsDefault })
                      }
                    />
                    <View className="flex-row gap-2">
                      <Button
                        label="Accept"
                        accessibilityLabel={`Confirm accepting ${nameOf(grant)}`}
                        tone="primary"
                        size="compact"
                        disabled={pending}
                        onPress={() =>
                          void run(
                            () =>
                              acceptLoan(connection, grant, {
                                useAsDefault: choosing.useAsDefault,
                              }),
                            true,
                          )
                        }
                      />
                      <Button
                        label="Cancel"
                        tone="text"
                        size="compact"
                        disabled={pending}
                        onPress={() => setAcceptingGroup(null)}
                      />
                    </View>
                  </View>
                ) : mayChange ? (
                  <View className="flex-row gap-2">
                    {machine ? null : (
                      <Button
                        label={grant.resource.kind === "vault-group" ? "Accept…" : "Accept"}
                        accessibilityLabel={`Accept ${nameOf(grant)}`}
                        tone="primary"
                        size="compact"
                        disabled={pending}
                        onPress={() =>
                          grant.resource.kind === "vault-group"
                            ? setAcceptingGroup({ id: grant.id, useAsDefault: true })
                            : void run(() => acceptLoan(connection, grant), true)
                        }
                      />
                    )}
                    <Button
                      label="Reject"
                      accessibilityLabel={`Reject ${nameOf(grant)}`}
                      size="compact"
                      disabled={pending}
                      onPress={() =>
                        void run(
                          () => settle(reject({ environmentId, input: { grantId: grant.id } })),
                          true,
                        )
                      }
                    />
                  </View>
                ) : null}
              </View>
            );
          })}
        </ListSection>
      )}
      {borrowed.length === 0 ? null : (
        <ListSection title="Borrowed by your Spaces">
          {borrowed.map((grant) => {
            const hasUse =
              grant.resource.kind === "ai-account" ||
              (grant.resource.kind === "vault-group" && grant.can.return);
            return (
              <View key={grant.id} accessibilityLabel={`Borrowed: ${nameOf(grant)}`}>
                <View className="gap-1 px-4 py-3">
                  <Text className="text-base text-foreground">
                    {nameOf(grant)} in {targetLabel(grant, "your Space")}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {loanDescription(grant, "received")}
                  </Text>
                  <Text className="text-sm text-foreground-muted">{lenderSees(grant)}</Text>
                  <View className="flex-row gap-2">
                    {hasUse ? panelButton(grant) : null}
                    {mayChange && grant.can.return ? (
                      <Button
                        label="Give back"
                        accessibilityLabel={`Give back ${nameOf(grant)}`}
                        tone="danger"
                        size="compact"
                        disabled={pending}
                        onPress={() => confirmEnd(grant)}
                      />
                    ) : null}
                  </View>
                </View>
                {usageOf === grant.id ? (
                  <LoanUse environmentId={environmentId} grant={grant} />
                ) : null}
              </View>
            );
          })}
        </ListSection>
      )}
      {ended.length === 0 ? null : (
        <ListSection title="Ended loans to your Spaces">
          {ended.map((grant) => (
            <View
              key={grant.id}
              accessibilityLabel={`Ended: ${nameOf(grant)}`}
              className="gap-1 px-4 py-3"
            >
              <Text className="text-base text-foreground">
                {nameOf(grant)} in {targetLabel(grant, "your Space")}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {loanDescription(grant, "received")}
              </Text>
            </View>
          ))}
        </ListSection>
      )}
      {lentGroups.length === 0 ? null : (
        <ListSection title="Lent by you">
          {lentGroups.map((group) => (
            <View key={group.key} accessibilityLabel={`${group.name} is lent to`}>
              <Text className="px-4 pt-3 text-base text-foreground">
                {group.name} · {lentCountText(group)}
              </Text>
              {group.loans.map((grant) => {
                const recipient = recipientLabel(grant);
                // A link nobody applied says why it works or not; an applied one is a loan.
                const unapplied =
                  grant.offer !== undefined && grant.offer.status !== "used" ? grant.offer : null;
                const detail = [
                  unapplied !== null
                    ? offerStatusText(unapplied)
                    : grant.state === "active"
                      ? null
                      : stateText(grant),
                  limitsText(grant.limits),
                  ...loanStatusParts(grant),
                ]
                  .filter((part) => part !== null)
                  .join(" · ");
                // A link nobody applied has no use to view.
                const hasUse =
                  grant.target !== null &&
                  (grant.resource.kind === "ai-account" || grant.resource.kind === "vault-group");
                const mayEnd = mayChange && (grant.can.revoke || grant.can.cancel);
                const toRotate = grant.state === "ended" ? (grant.vaultGroup?.toRotate ?? []) : [];
                return (
                  <View key={grant.id} accessibilityLabel={`${group.name} lent to ${recipient}`}>
                    <View className="gap-1 px-4 py-2">
                      <Text className="text-sm text-foreground">{recipient}</Text>
                      <Text className="text-xs text-foreground-muted">{detail}</Text>
                      {toRotate.length === 0 ? null : (
                        <Text className="text-xs text-warning-foreground">
                          Values may have been read. Rotate these Secrets in Vaults:{" "}
                          {toRotate.map((entry) => entry.name).join(", ")}.
                        </Text>
                      )}
                      {hasUse || mayEnd ? (
                        <View className="flex-row gap-2">
                          {hasUse ? panelButton(grant) : null}
                          {mayEnd ? (
                            <Button
                              label={grant.can.cancel ? "Cancel" : "Take back"}
                              accessibilityLabel={`${grant.can.cancel ? "Cancel" : "Take back"} ${group.name} lent to ${recipient}`}
                              tone="danger"
                              size="compact"
                              disabled={pending}
                              onPress={() =>
                                grant.can.cancel
                                  ? void run(
                                      () =>
                                        settle(
                                          cancel({ environmentId, input: { grantId: grant.id } }),
                                        ),
                                      false,
                                    )
                                  : confirmEnd(grant)
                              }
                            />
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                    {usageOf === grant.id ? (
                      <LoanUse environmentId={environmentId} grant={grant} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          ))}
        </ListSection>
      )}
      <Text className="px-2 text-xs text-foreground-muted">
        Lending a resource, and changing a loan's limits, are done on the web or desktop app.
      </Text>
    </View>
  );
}

function ErrorRow(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="flex-row items-center gap-3 px-2">
      <Text accessibilityRole="alert" className="flex-1 text-sm text-danger-foreground">
        {props.message}
      </Text>
      <Button label="Try again" size="compact" onPress={props.onRetry} />
    </View>
  );
}
