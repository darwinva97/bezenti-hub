import {
  dayBefore,
  formatTokens,
  formatUsd,
  groupUsage,
  USAGE_GROUPINGS,
  type UsageGrouping,
  usageNotes,
} from "@t3tools/client-runtime/ai-usage-view";
import type { EnvironmentId, Grant } from "@t3tools/contracts";
import { useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useEnvironmentQuery } from "../../state/query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { quotaShareText } from "@t3tools/client-runtime/grants-view";

/** The groupings that make sense for one loan (its account is one). */
const GROUPINGS = USAGE_GROUPINGS.filter(([value]) => value !== "account");

/**
 * Grants ticket 04: one AI account loan's use in the last 30 days, through the gateway. Its lender
 * sees it by Space, User and day (never a Thread or a prompt); a borrower their own, an Admin their
 * Space's: the Hub narrows it. What it cannot count is said, never shown as zero. Ticket 05: an
 * API key's estimated cost; a subscription never in money, only its approximate quota share.
 */
export function LoanUsage({
  environmentId,
  grant,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: Grant;
}) {
  const [grouping, setGrouping] = useState<UsageGrouping>("user");
  const [today] = useState(() => new Date());
  const query = useEnvironmentQuery(
    aiGatewayEnvironment.usageSummary({
      environmentId,
      input: { grantId: grant.id, fromDay: dayBefore(today, 30) },
    }),
  );
  const summary = query.data;
  const groups = summary === null ? [] : groupUsage(summary, grouping);
  const label = GROUPINGS.find(([value]) => value === grouping)?.[1] ?? "User";
  // Only an API key has a price; a subscription is never shown in money.
  const priced = grant.aiAccount?.type === "api-key";
  const quotaShare = summary?.quotaShare ?? [];
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      aria-label={`Use of ${grant.resource.name ?? "the loan"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Last 30 days through the AI gateway</p>
        <ToggleGroup
          aria-label="Group the loan's use by"
          value={[grouping]}
          onValueChange={(next) => {
            const value = GROUPINGS.find(([group]) => group === next[0]);
            if (value !== undefined) setGrouping(value[0]);
          }}
        >
          {GROUPINGS.map(([value, words]) => (
            <Toggle key={value} value={value}>
              {words}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {query.error !== null ? (
        <p className="text-destructive" role="alert">
          {query.error}
        </p>
      ) : summary === null ? (
        <p className="text-muted-foreground">{query.isPending ? "Reading the use…" : ""}</p>
      ) : summary.totals.requests === 0 && quotaShare.length === 0 ? (
        <p className="text-muted-foreground">No request went through it in this period.</p>
      ) : (
        <>
          <p>
            {summary.totals.requests.toLocaleString("en-US")}{" "}
            {summary.totals.requests === 1 ? "request" : "requests"} ·{" "}
            {formatTokens(summary.totals.inputTokens)} in ·{" "}
            {formatTokens(summary.totals.outputTokens)} out ·{" "}
            {formatTokens(summary.totals.cacheWriteTokens)} cache write ·{" "}
            {formatTokens(summary.totals.cacheReadTokens)} cache read (not capped)
            {priced && summary.estimatedUsd !== undefined && summary.estimatedUsd !== null
              ? ` · ≈ ${formatUsd(summary.estimatedUsd)} estimated`
              : ""}
            {priced && (summary.unpricedTokens ?? 0) > 0
              ? ` · ${formatTokens(summary.unpricedTokens ?? 0)} tokens without a price`
              : ""}
          </p>
          {quotaShare.length > 0 ? (
            <ul aria-label="Share of the subscription's quota" className="flex flex-col gap-0.5">
              {quotaShare.map((share) => (
                <li key={share.windowId}>{quotaShareText(share)}</li>
              ))}
            </ul>
          ) : null}
          {usageNotes(summary.totals).length > 0 ? (
            <p className="text-muted-foreground">{usageNotes(summary.totals).join(" · ")}</p>
          ) : null}
          <Table aria-label={`Loan use by ${label.toLowerCase()}`}>
            <TableHeader>
              <TableRow>
                <TableHead>{label}</TableHead>
                <TableHead className="text-end">Requests</TableHead>
                <TableHead className="text-end">Input</TableHead>
                <TableHead className="text-end">Output</TableHead>
                <TableHead className="text-end">Cache write</TableHead>
                {priced ? <TableHead className="text-end">Est. USD</TableHead> : null}
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
                    {formatTokens(group.totals.cacheWriteTokens)}
                  </TableCell>
                  {priced ? (
                    <TableCell className="text-end">
                      {group.estimatedUsd === null ? "No price" : formatUsd(group.estimatedUsd)}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <p className="text-muted-foreground">
        Only requests through the Hub's AI gateway are counted for a loan: never prompts or Threads,
        and nothing used with the account outside this Hub.
        {priced
          ? ` Cost is estimated from list prices as of ${summary?.pricesReviewedOn ?? "this release"} in this Hub's release: not a bill and not a cap.`
          : " A subscription's quota share is approximate: use of the account outside this Hub counts in its percentage, not in its tokens."}
      </p>
    </div>
  );
}
