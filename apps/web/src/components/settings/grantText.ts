import { formatSharePercent } from "@t3tools/client-runtime/ai-usage-view";
import type {
  AiUsageQuotaShare,
  Grant,
  GrantCapUse,
  GrantCreatedOffer,
  GrantLimits,
  GrantOfferPreview,
  GrantOfferSpace,
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

/**
 * Grants ticket 07: what lending a Vault group lets the Space do, said before it is lent (ADR 0004:
 * a Secret reaches a process as an environment variable, which its agent can read).
 */
export const vaultLendWarning = (space: string) =>
  `The agents of ${space}, Guests' Threads included, can read this group's Secrets: they receive them as environment variables. Names that change how tools run are never sent.`;

/** A loan's limits in words: a machine's sizes, an AI account's caps («No cap»), or none. */
export const limitsText = (limits: GrantLimits) => {
  if (limits.kind === "vault-group") return "Read-only for the Space";
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

// Grants ticket 06: lending links.

/** The link to hand out: on the Hub's public address, else on the address this page is on. */
export const offerLinkOf = (created: Pick<GrantCreatedOffer, "path" | "url">, origin: string) =>
  created.url ?? `${origin}${created.path}`;

/** A lending link's state, to its lender; the date in local time. */
export const offerStatusText = (offer: NonNullable<Grant["offer"]>) => {
  switch (offer.status) {
    case "open":
      return `Open link, works once until ${new Date(offer.expiresAt).toLocaleString()}`;
    case "expired":
      return "Link expired unused";
    case "cancelled":
      return "Link cancelled";
    case "used":
      return "Applied through a link";
  }
};

/** Who a lent loan went to: its Space, or the link nobody applied yet. */
export const recipientLabel = (grant: Grant) =>
  grant.target !== null
    ? spaceLabel(grant.target)
    : grant.offer === undefined
      ? "a Space"
      : "Lending link";

/** A Space to apply a link to, as the select names it. */
export const offerSpaceLabel = (space: GrantOfferSpace) =>
  space.alreadyGranted ? `${spaceLabel(space)} (already lent there)` : spaceLabel(space);

/** What whoever applies a link is told before they do: what the lender sees, and a subscription's terms. */
/** What a borrower is told before accepting, and what the lent machine shows: the spec's words. */
export const lenderSeesEverything = (lender: string) =>
  `${lender} controls this machine and can see everything that runs on it: files, processes, the Secrets turns receive and each Thread's AI gateway key.`;

export const offerWarnings = (preview: Extract<GrantOfferPreview, { status: "valid" }>) => {
  const lender = preview.lender.name ?? "Its lender";
  // Grants ticket 15: a machine's link.
  if (preview.resource.kind === "environment") {
    return [`${lenderSeesEverything(lender)} Only accept machines of people you trust that much.`];
  }
  return [
    `${lender} sees how much each person in the Space uses it, never prompts or Threads, and can take it back at any time.`,
    ...(preview.resource.aiAccount?.type === "subscription"
      ? [subscriptionTermsWarning(preview.resource.aiAccount.provider)]
      : []),
  ];
};
