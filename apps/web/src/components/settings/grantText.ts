import { formatSharePercent } from "@t3tools/client-runtime/ai-usage-view";
import type {
  AiUsageQuotaShare,
  GrantCapUse,
  GrantLimits,
  GrantSpaceRef,
  SandboxHostReport,
} from "@t3tools/contracts";

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

/**
 * Which limits a lent machine's cgroups do not enforce, in words; null when it enforces them all,
 * or when it cannot run a Sandbox now: then which limits it enforces is not known yet (a machine
 * with no Sandbox runtime reports none), and its reason is what to act on.
 */
export const hostLimitsNotice = (host: SandboxHostReport) => {
  if (!host.ready) return null;
  const missing = [
    host.limitSupport.cpus ? null : "CPU",
    host.limitSupport.memory ? null : "memory",
    host.limitSupport.pids ? null : "processes",
  ].filter((entry) => entry !== null);
  return missing.length === 0
    ? null
    : `On this machine these limits are not enforced: ${missing.join(", ")}.${host.limitSupport.note === null ? "" : ` ${host.limitSupport.note}`}`;
};

/** How much of a cap is used now, and when it resets (local time). */
export const capUseText = (what: "tokens" | "requests", use: GrantCapUse) =>
  `${use.used.toLocaleString()} of ${use.amount.toLocaleString()} ${what} used${
    use.used >= use.amount ? " (cap reached)" : ""
  }, resets ${new Date(use.resetsAt).toLocaleString()}`;

/**
 * Grants ticket 05: about how much of a lent subscription's quota window went through the loan
 * (or, for a borrowing Member, through them), always approximate; the lender also sees the whole
 * account's use of it.
 */
export const quotaShareText = (share: AiUsageQuotaShare) =>
  `${share.label} quota: ≈ ${formatSharePercent(share.sharePercent)} ${
    share.of === "loan" ? "through this loan" : "by you"
  } (approx.)${
    share.usedPercent === undefined ? "" : ` · account at ${Math.round(share.usedPercent)}%`
  } · resets ${new Date(share.resetsAt).toLocaleString()}`;
