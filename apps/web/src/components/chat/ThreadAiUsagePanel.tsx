import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useHubEnvironmentId } from "../../state/hubEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import {
  dayBefore,
  formatTokens,
  THREAD_USAGE_SCOPE_NOTE,
  threadNoGatewayUsage,
  usageNotes,
} from "@t3tools/client-runtime/ai-usage-view";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Per-request rows are kept 90 days (spec 4 ticket 05). */
const THREAD_USAGE_DAYS = 90;

/**
 * What this Thread's requests through the Hub's AI gateway cost in tokens. The Hub answers with
 * only what the session may see (the Thread's own User, an Admin of its Space, the Owner); a Thread
 * with no request through the gateway says so, and what is never counted (ticket 16).
 */
export function ThreadAiUsagePanel(props: { readonly threadId: ThreadId }) {
  const [today] = useState(() => new Date());
  // The usage tables live on the Hub, which is the primary environment: a Thread running on a
  // joined machine is still counted there.
  const hubId = useHubEnvironmentId();
  const query = useEnvironmentQuery(
    hubId === null
      ? null
      : aiGatewayEnvironment.usageSummary({
          environmentId: hubId,
          input: { threadId: props.threadId, fromDay: dayBefore(today, THREAD_USAGE_DAYS) },
        }),
  );
  const summary = query.data;
  if (summary === null) return null;
  const totals = summary.totals;
  // Said, not hidden: the agent may have used AI the gateway never saw (ticket 16).
  if (totals.requests === 0) {
    return (
      <ThreadDetailsSection
        headingId="thread-details-ai-usage-heading"
        title="AI gateway usage"
        showHeading={false}
      >
        <p className="px-2.5 text-xs text-muted-foreground">
          {threadNoGatewayUsage(summary.scope)}
        </p>
      </ThreadDetailsSection>
    );
  }
  const notes = usageNotes(totals);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Requests", totals.requests.toLocaleString("en-US")],
    ["Input tokens", formatTokens(totals.inputTokens)],
    ["Output tokens", formatTokens(totals.outputTokens)],
    ...(totals.cacheReadTokens + totals.cacheWriteTokens > 0
      ? ([
          ["Cache read", formatTokens(totals.cacheReadTokens)],
          ["Cache write", formatTokens(totals.cacheWriteTokens)],
        ] as const)
      : []),
  ];
  return (
    <ThreadDetailsSection
      headingId="thread-details-ai-usage-heading"
      title="AI gateway usage"
      showHeading={false}
    >
      <div className="grid grid-cols-[1fr_auto] gap-x-3 text-xs">
        {rows.map(([label, value]) => (
          <div
            key={label}
            aria-label={`${label}: ${value}`}
            className="col-span-2 grid h-6 grid-cols-subgrid items-center px-2.5"
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="text-end font-medium tabular-nums text-foreground/80">{value}</span>
          </div>
        ))}
        {notes.length > 0 ? (
          <span className="col-span-2 px-2.5 pt-1 text-muted-foreground">{notes.join(" · ")}</span>
        ) : null}
        <span className="col-span-2 px-2.5 pt-1 text-muted-foreground">
          {THREAD_USAGE_SCOPE_NOTE}
        </span>
      </div>
    </ThreadDetailsSection>
  );
}
