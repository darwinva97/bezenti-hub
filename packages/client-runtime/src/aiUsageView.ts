// @effect-diagnostics globalDate:off -- the Usage range is calendar days (UTC) computed from the clock the screen reads.
import {
  addAiUsageTotals,
  AI_USAGE_NO_TOTALS,
  type AiUsageScope,
  type AiUsageSummary,
  type AiUsageTotals,
} from "@t3tools/contracts";

/** What the Usage tab can total by. */
export type UsageGrouping = "day" | "user" | "space" | "account";

export const USAGE_GROUPINGS: ReadonlyArray<readonly [UsageGrouping, string]> = [
  ["day", "Day"],
  ["user", "User"],
  ["space", "Space"],
  ["account", "AI account"],
];

export interface UsageGroup {
  readonly key: string;
  readonly label: string;
  readonly totals: AiUsageTotals;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  gemini: "Gemini",
  vertex: "Vertex AI",
  kimi: "Kimi",
  xai: "xAI",
  devin: "Devin",
  meta: "Meta",
  "openai-compatible": "OpenAI-compatible",
};

function accountLabel(
  accountId: string | null,
  accounts: ReadonlyMap<string, { readonly name: string | null; readonly provider: string }>,
): string {
  if (accountId === null) return "No account reached";
  const account = accounts.get(accountId);
  if (account === undefined) return "Deleted account";
  return account.name ?? `${PROVIDER_NAMES[account.provider] ?? account.provider} account`;
}

/** 1 234 → «1.2k», 3 400 000 → «3.4M»; small counts as they are. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${trim(count / 1_000)}k`;
  if (count < 1_000_000_000) return `${trim(count / 1_000_000)}M`;
  return `${trim(count / 1_000_000_000)}B`;
}
/** The summary's rows added up by one dimension; days newest first, the rest by most requests. */
export function groupUsage(summary: AiUsageSummary, by: UsageGrouping): ReadonlyArray<UsageGroup> {
  const users = new Map(summary.labels.users.map((user) => [user.id, user.name]));
  const spaces = new Map(summary.labels.spaces.map((space) => [space.id, space.name]));
  const accounts = new Map(summary.labels.accounts.map((account) => [account.id, account]));
  const groups = new Map<string, UsageGroup>();
  for (const row of summary.rows) {
    const [key, label] =
      by === "day"
        ? [row.day, row.day]
        : by === "user"
          ? [row.userId, users.get(row.userId) ?? "Removed User"]
          : by === "space"
            ? [
                row.spaceId,
                spaces.has(row.spaceId)
                  ? (spaces.get(row.spaceId) ?? "A Space you no longer see")
                  : "Removed Space",
              ]
            : [row.accountId ?? "none", accountLabel(row.accountId, accounts)];
    const previous = groups.get(key);
    groups.set(key, {
      key,
      label,
      totals: addAiUsageTotals(previous?.totals ?? AI_USAGE_NO_TOTALS, row),
    });
  }
  const list = [...groups.values()];
  return by === "day"
    ? [...list].sort((a, b) => b.key.localeCompare(a.key))
    : [...list].sort(
        (a, b) => b.totals.requests - a.totals.requests || a.label.localeCompare(b.label),
      );
}

const trim = (value: number) =>
  (value >= 100 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/u, "");

/** The note under a total: requests whose tokens the upstream never reported, and failures. */
export function usageNotes(totals: AiUsageTotals): ReadonlyArray<string> {
  const notes: Array<string> = [];
  if (totals.unknownRequests > 0) {
    notes.push(
      `${totals.unknownRequests} ${totals.unknownRequests === 1 ? "request" : "requests"} without token counts`,
    );
  }
  if (totals.failedRequests > 0) {
    notes.push(`${totals.failedRequests} failed`);
  }
  return notes;
}

/**
 * What the usage log cannot count, said instead of a silent zero (ticket 16): it only sees requests
 * through the Hub's AI gateway. `directAccounts` names the AI accounts with a direct credential.
 */
export function uncountedUsage(directAccounts: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    directAccounts.length === 0
      ? "AI accounts with a direct credential: their agents call the provider directly, not through the gateway."
      : `AI accounts with a direct credential (${directAccounts.join(", ")}): their agents call the provider directly, not through the gateway.`,
    "CLIs signed in with their own login, on a machine or on your computer, instead of a Hub key.",
    "Use of the same provider accounts outside this Hub.",
  ];
}

/** Under a Thread's gateway usage: what it leaves out. */
export const THREAD_USAGE_SCOPE_NOTE =
  "Only requests through the Hub's AI gateway are counted, not a direct credential or a CLI's own login.";

/**
 * A Thread with no gateway request: said, not hidden, since its agent may still have used AI. Only
 * the Owner sees every request; anyone else is told it is what they may see.
 */
export function threadNoGatewayUsage(scope: AiUsageScope): string {
  const what =
    scope === "all"
      ? "No request of this Thread went through the Hub's AI gateway."
      : "No request you may see in this Thread went through the Hub's AI gateway.";
  return `${what} A direct credential or a CLI's own login is not counted here.`;
}

/** `YYYY-MM-DD`, `days - 1` days before `today` (UTC). */
export function dayBefore(today: Date, days: number): string {
  return new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}
