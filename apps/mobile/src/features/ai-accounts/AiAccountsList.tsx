import { accountSections } from "@t3tools/client-runtime/ai-accounts-view";
import {
  dayBefore,
  formatTokens,
  groupUsage,
  usageNotes,
} from "@t3tools/client-runtime/ai-usage-view";
import type { AiAccountListResult, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./failureMessage";

const USAGE_DAYS = 30;

/**
 * Settings → AI accounts on a phone: the Hub's list for this User by owner, with status and quota,
 * and the gateway's usage. Read-only: adding, signing in, credentials, loans and order stay
 * on web and desktop; the Hub narrows every answer to what the session may see.
 */
export function AiAccountsList(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const list = useAtomCommand(aiGatewayEnvironment.listAccounts, "list the AI accounts");
  const [loaded, setLoaded] = useState<AiAccountListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date());
  const load = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the AI accounts the Hub lists for this User when the page opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setLoaded(result.value);
        setError(null);
      } else {
        setError(commandFailureMessage(result, "Could not read the AI accounts."));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const usage = useEnvironmentQuery(
    aiGatewayEnvironment.usageSummary({
      environmentId,
      input: { fromDay: dayBefore(today, USAGE_DAYS) },
    }),
  );
  const summary = usage.data;
  const sections = loaded === null ? [] : accountSections(loaded);

  return (
    <View className="gap-6">
      {error === null ? null : (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {loaded === null || sections.length === 0 ? (
        <ListSection title="AI accounts">
          {loaded === null ? (
            error === null ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">Loading AI accounts…</Text>
            ) : null
          ) : (
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              No AI account is available to you. Add your own on the web or desktop app.
            </Text>
          )}
        </ListSection>
      ) : null}
      {sections.map((section) => (
        <ListSection
          key={section.title}
          title={section.title === "Mine" ? "My AI accounts" : section.title}
        >
          {section.rows.map((row) => (
            <View key={row.id} className="gap-1 px-4 py-3">
              <Text className="text-base text-foreground">{row.name}</Text>
              <Text className="text-xs text-foreground-muted">
                {row.providerLabel} · {row.kindLabel} · #{row.priority}
              </Text>
              <Text className="text-sm text-foreground">{row.statusLabel}</Text>
              {row.statusMessage === null ? null : (
                <Text className="text-sm text-foreground-muted">{row.statusMessage}</Text>
              )}
              {row.signedInAs === null ? null : (
                <Text className="text-sm text-foreground-muted">
                  Signed in as {row.signedInAs}.
                </Text>
              )}
              {row.quota === null ? null : (
                <Text className="text-sm text-foreground-muted">{row.quota}</Text>
              )}
            </View>
          ))}
        </ListSection>
      ))}
      <ListSection title="Usage, last 30 days">
        {summary === null ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            {usage.isPending ? "Reading the usage…" : (usage.error ?? "No usage to show.")}
          </Text>
        ) : summary.totals.requests === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            No request went through the AI gateway in this period.
          </Text>
        ) : (
          <View className="gap-1 px-4 py-3">
            <Text className="text-sm text-foreground">
              {summary.totals.requests.toLocaleString("en-US")}{" "}
              {summary.totals.requests === 1 ? "request" : "requests"} ·{" "}
              {formatTokens(summary.totals.inputTokens)} in ·{" "}
              {formatTokens(summary.totals.outputTokens)} out
            </Text>
            {usageNotes(summary.totals).length === 0 ? null : (
              <Text className="text-xs text-foreground-muted">
                {usageNotes(summary.totals).join(" · ")}
              </Text>
            )}
            {groupUsage(summary, "account").map((group) => (
              <Text key={group.key} className="text-sm text-foreground-muted">
                {group.label}: {group.totals.requests} · {formatTokens(group.totals.inputTokens)} in
                · {formatTokens(group.totals.outputTokens)} out
              </Text>
            ))}
          </View>
        )}
      </ListSection>
      <Text className="px-2 text-xs text-foreground-muted">
        Sign-in, credentials and the AI gateway are managed on web or desktop. Keys and credentials
        are never shown here.
      </Text>
    </View>
  );
}
