import type { AiUsageTotals, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useEnvironmentQuery } from "../../state/query";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  dayBefore,
  formatTokens,
  groupUsage,
  uncountedUsage,
  USAGE_GROUPINGS,
  type UsageGrouping,
  usageNotes,
} from "@t3tools/client-runtime/ai-usage-view";

const RANGES = [
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
] as const;

const tokens = (totals: AiUsageTotals) =>
  `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`;

/**
 * Settings → AI accounts → Usage (spec 4 ticket 05): what went through the Hub's AI gateway, per
 * day, User, Space and AI account. Recorded and shown, never limited. The Hub narrows it to what
 * the session may see; nothing here asks for more.
 */
export function AiUsageTab({
  environmentId,
  directAccounts,
}: {
  readonly environmentId: EnvironmentId;
  /** Names of the AI accounts with a direct credential, which this log never sees. */
  readonly directAccounts: ReadonlyArray<string>;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["value"]>("30");
  const [grouping, setGrouping] = useState<UsageGrouping>("day");
  const [today] = useState(() => new Date());
  const days = RANGES.find((item) => item.value === range)?.days ?? 30;
  const query = useEnvironmentQuery(
    aiGatewayEnvironment.usageSummary({
      environmentId,
      input: { fromDay: dayBefore(today, days) },
    }),
  );
  const summary = query.data;
  const groups = summary === null ? [] : groupUsage(summary, grouping);
  const groupingLabel = USAGE_GROUPINGS.find(([value]) => value === grouping)?.[1] ?? "Day";
  return (
    <SettingsSection id="ai-usage" title="Usage">
      <SettingsRow
        title="Requests and tokens"
        description="Everything that went through the Hub's AI gateway, from the counts the providers report. It is recorded and shown, never limited. Prompts and answers are not kept."
        status={
          query.error === null ? null : (
            <span className="text-destructive" role="alert">
              {query.error}
            </span>
          )
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={RANGES}
              value={range}
              onValueChange={(value) => {
                if (value !== null) setRange(value as (typeof RANGES)[number]["value"]);
              }}
            >
              <SelectTrigger aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {RANGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              aria-label="Group usage by"
              value={[grouping]}
              onValueChange={(next) => {
                const value = USAGE_GROUPINGS.find(([group]) => group === next[0]);
                if (value !== undefined) setGrouping(value[0]);
              }}
            >
              {USAGE_GROUPINGS.map(([value, label]) => (
                <Toggle key={value} value={value}>
                  {label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        }
      />
      {summary === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {query.isPending ? "Reading the usage…" : "No usage to show."}
        </p>
      ) : summary.totals.requests === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No request went through the AI gateway in this period.
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-sm" aria-label="Usage total">
            <span className="font-medium">{summary.totals.requests.toLocaleString("en-US")}</span>{" "}
            {summary.totals.requests === 1 ? "request" : "requests"} ·{" "}
            <span className="font-medium">{tokens(summary.totals)}</span>
            {summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens > 0
              ? ` · ${formatTokens(summary.totals.cacheReadTokens)} cache read · ${formatTokens(summary.totals.cacheWriteTokens)} cache write`
              : ""}
          </p>
          {usageNotes(summary.totals).length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {usageNotes(summary.totals).join(" · ")}
            </p>
          ) : null}
          {summary.truncated ? (
            <p className="text-xs text-muted-foreground" role="status">
              Showing the most recent rows only; pick a shorter period.
            </p>
          ) : null}
          <Table aria-label={`AI usage by ${groupingLabel.toLowerCase()}`}>
            <TableHeader>
              <TableRow>
                <TableHead>{groupingLabel}</TableHead>
                <TableHead className="text-end">Requests</TableHead>
                <TableHead className="text-end">Input</TableHead>
                <TableHead className="text-end">Output</TableHead>
                <TableHead className="text-end">Cache read</TableHead>
                <TableHead className="text-end">Cache write</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <TableRow key={group.key}>
                  <TableCell>{group.label}</TableCell>
                  <TableCell className="text-end">{group.totals.requests}</TableCell>
                  <TableCell className="text-end">
                    {formatTokens(group.totals.inputTokens)}
                  </TableCell>
                  <TableCell className="text-end">
                    {formatTokens(group.totals.outputTokens)}
                  </TableCell>
                  <TableCell className="text-end">
                    {formatTokens(group.totals.cacheReadTokens)}
                  </TableCell>
                  <TableCell className="text-end">
                    {formatTokens(group.totals.cacheWriteTokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex flex-col gap-1 px-4 pb-3 text-xs text-muted-foreground">
        <p className="font-medium">Not counted here</p>
        <ul aria-label="Not counted here" className="list-disc ps-4">
          {uncountedUsage(directAccounts).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </SettingsSection>
  );
}
