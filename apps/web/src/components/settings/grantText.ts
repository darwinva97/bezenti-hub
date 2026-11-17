import type { GrantCapUse, GrantLimits, GrantSpaceRef } from "@t3tools/contracts";

const GIB = 1024 ** 3;
export const gib = (bytes: number) => `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 1)} GiB`;

/**
 * A loan's Space as people tell them apart: every Personal space is called «Personal», so it is
 * named by its owner, «Ana (personal)».
 */
export const spaceLabel = (space: GrantSpaceRef) =>
  space.kind === "personal" ? `${space.ownerDisplayName ?? space.name} (personal)` : space.name;

/** The spec's warning for lending (and borrowing) a subscription. */
export const subscriptionTermsWarning = (provider: string) =>
  `The terms of ${provider} forbid sharing this account; it may be suspended.`;

const PER: Record<GrantCapPeriod, string> = { day: "a day", week: "a week", month: "a month" };
type GrantCapPeriod = GrantCapUse["period"];

/** A loan's limits in words: a machine's sizes, or an AI account's caps («No cap»). */
export const limitsText = (limits: GrantLimits) => {
  if (limits.kind === "environment") {
    return `${limits.cpus} CPUs · ${gib(limits.memoryBytes)} memory · ${limits.pids} processes · ${gib(limits.diskBytes)} disk`;
  }
  const caps = [
    ...(limits.tokens === null
      ? []
      : [`${limits.tokens.amount.toLocaleString()} tokens ${PER[limits.tokens.period]}`]),
    ...(limits.requests === null
      ? []
      : [`${limits.requests.amount.toLocaleString()} requests ${PER[limits.requests.period]}`]),
  ];
  return caps.length === 0 ? "No cap" : caps.join(" · ");
};

/** How much of a cap is used now, and when it resets (local time). */
export const capUseText = (what: "tokens" | "requests", use: GrantCapUse) =>
  `${use.used.toLocaleString()} of ${use.amount.toLocaleString()} ${what} used${
    use.used >= use.amount ? " (cap reached)" : ""
  }, resets ${new Date(use.resetsAt).toLocaleString()}`;
