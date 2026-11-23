import {
  dayBefore,
  formatTokens,
  formatUsd,
  groupUsage,
  USAGE_GROUPINGS,
  type UsageGrouping,
  usageNotes,
} from "@t3tools/client-runtime/ai-usage-view";
import { quotaShareText } from "@t3tools/client-runtime/grants-view";
import type { EnvironmentId, Grant, GrantVaultUsage } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { grantsEnvironment } from "../../state/grants";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "../ai-accounts/failureMessage";

/** The groupings that make sense for one loan (its account is one). */
const GROUPINGS = USAGE_GROUPINGS.filter(([value]) => value !== "account");

/** One loan's use, as web's Loans list shows it: an AI account's or a Vault group's. */
export function LoanUse(props: { readonly environmentId: EnvironmentId; readonly grant: Grant }) {
  return props.grant.resource.kind === "vault-group" ? (
    <VaultLoanUse {...props} />
  ) : (
    <AiLoanUse {...props} />
  );
}

/**
 * An AI account loan's use in the last 30 days, through the gateway: by User, Space or day, never a
 * Thread or a prompt (the Hub narrows it to what the viewer may see). An API key's estimated cost;
 * a subscription never in money, only its approximate quota share.
 */
function AiLoanUse(props: { readonly environmentId: EnvironmentId; readonly grant: Grant }) {
  const { environmentId, grant } = props;
  const [grouping, setGrouping] = useState<UsageGrouping>("user");
  const [today] = useState(() => new Date());
  const query = useEnvironmentQuery(
    aiGatewayEnvironment.usageSummary({
      environmentId,
      input: { grantId: grant.id, fromDay: dayBefore(today, 30) },
    }),
  );
  const summary = query.data;
  const priced = grant.aiAccount?.type === "api-key";
  const quotaShare = summary?.quotaShare ?? [];
  const notes = summary === null ? [] : usageNotes(summary.totals);
  return (
    <View
      accessibilityLabel={`Use of ${grant.resource.name ?? "the loan"}`}
      className="gap-1 px-4 pb-3"
    >
      <Text className="text-xs font-t3-medium text-foreground">
        Last 30 days through the AI gateway
      </Text>
      {query.error !== null ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {query.error}
        </Text>
      ) : summary === null ? (
        <Text className="text-xs text-foreground-muted">
          {query.isPending ? "Reading the use…" : ""}
        </Text>
      ) : summary.totals.requests === 0 && quotaShare.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          No request went through it in this period.
        </Text>
      ) : (
        <>
          <Text className="text-xs text-foreground">
            {summary.totals.requests.toLocaleString("en-US")}{" "}
            {summary.totals.requests === 1 ? "request" : "requests"} ·{" "}
            {formatTokens(summary.totals.inputTokens)} in ·{" "}
            {formatTokens(summary.totals.outputTokens)} out
            {priced && summary.estimatedUsd !== undefined && summary.estimatedUsd !== null
              ? ` · ≈ ${formatUsd(summary.estimatedUsd)} estimated`
              : ""}
          </Text>
          {quotaShare.map((share) => (
            <Text key={share.windowId} className="text-xs text-foreground">
              {quotaShareText(share)}
            </Text>
          ))}
          {notes.length === 0 ? null : (
            <Text className="text-xs text-foreground-muted">{notes.join(" · ")}</Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            {GROUPINGS.map(([value, words]) => (
              <Button
                key={value}
                label={words}
                accessibilityLabel={`Group the use by ${words.toLowerCase()}`}
                tone={grouping === value ? "primary" : "secondary"}
                size="compact"
                onPress={() => setGrouping(value)}
              />
            ))}
          </View>
          {groupUsage(summary, grouping).map((group) => (
            <Text key={group.key} className="text-xs text-foreground-muted">
              {group.label}: {group.totals.requests} · {formatTokens(group.totals.inputTokens)} in ·{" "}
              {formatTokens(group.totals.outputTokens)} out
              {priced && group.estimatedUsd !== null ? ` · ${formatUsd(group.estimatedUsd)}` : ""}
            </Text>
          ))}
        </>
      )}
      <Text className="text-xs text-foreground-muted">
        Only requests through the Hub's AI gateway are counted for a loan: never prompts or Threads,
        and nothing used with the account outside this Hub.
        {priced
          ? " Cost is estimated from list prices: not a bill and not a cap."
          : " A subscription's quota share is approximate."}
      </Text>
    </View>
  );
}

/**
 * A lent Vault group's use: per UTC day, User of the borrowing Space and name, how many processes
 * received it. Names and counts only, never a value, a Thread or a prompt.
 */
function VaultLoanUse(props: { readonly environmentId: EnvironmentId; readonly grant: Grant }) {
  const { environmentId, grant } = props;
  const vaultUsage = useAtomCommand(grantsEnvironment.vaultUsage, "read a loan's use");
  const [usage, setUsage] = useState<GrantVaultUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useEffectEvent((target: EnvironmentId, grantId: Grant["id"]) =>
    vaultUsage({ environmentId: target, input: { grantId } }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the loan's use from the Hub when the panel opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId, grant.id).then((read) => {
      if (cancelled) return;
      if (read._tag === "Success") {
        setUsage(read.value);
        setError(null);
      } else {
        setError(commandFailureMessage(read, "Could not read the loan's use."));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, grant.id]);
  return (
    <View
      accessibilityLabel={`Use of ${grant.resource.name ?? "the Vault group"}`}
      className="gap-1 px-4 pb-3"
    >
      <Text className="text-xs font-t3-medium text-foreground">
        Processes that received a name of this group
      </Text>
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </Text>
      ) : usage === null ? (
        <Text className="text-xs text-foreground-muted">Reading the use…</Text>
      ) : usage.rows.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          No process has received a name of it yet.
        </Text>
      ) : (
        usage.rows.map((row) => (
          <Text key={`${row.day}|${row.userId}|${row.name}`} className="text-xs text-foreground">
            {row.day} · {row.userName ?? "A former User"} · {row.name}: {row.deliveries}
          </Text>
        ))
      )}
      <Text className="text-xs text-foreground-muted">
        Counted by UTC day each time a turn, terminal or script of the borrowing Space starts with a
        name of this group: names and counts only, never values, Threads or prompts.
        {usage?.truncated === true ? " Only the most recent rows are shown." : ""}
      </Text>
    </View>
  );
}
