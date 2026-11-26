/**
 * Grants as every client words and sorts them (Grants ticket 12): web, desktop and mobile read
 * the same loan the same way. docs/internals/grants.md, «Clients».
 */
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
  SpaceDirectoryView,
  SpaceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatSharePercent } from "./aiUsageView.ts";

const GIB = 1024 ** 3;

/** An ISO instant as the reader's local date and time (or date only). */
const localTime = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso)).toLocaleString();
const localDay = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso)).toLocaleDateString();
const gib = (bytes: number) => `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 1)} GiB`;

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
  if (
    limits.kind === "vault-group" ||
    limits.kind === "space-mcp" ||
    limits.kind === "space-skill"
  ) {
    return "Read-only for the Space";
  }
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
const capUseText = (what: "tokens" | "requests", use: GrantCapUse) =>
  `${use.used.toLocaleString()} of ${use.amount.toLocaleString()} ${what} used${
    use.used >= use.amount ? " (cap reached)" : ""
  }, resets ${localTime(use.resetsAt)}`;

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
  } · resets ${localTime(share.resetsAt)}`;

// Grants ticket 06: lending links.

/** The link to hand out: on the Hub's public address, else on the address this page is on. */
export const offerLinkOf = (created: Pick<GrantCreatedOffer, "path" | "url">, origin: string) =>
  created.url ?? `${origin}${created.path}`;

/** A lending link's state, to its lender; the date in local time. */
export const offerStatusText = (offer: NonNullable<Grant["offer"]>) => {
  switch (offer.status) {
    case "open":
      return `Open link, works once until ${localTime(offer.expiresAt)}`;
    case "expired":
      return "Link expired unused";
    case "cancelled":
      return "Link cancelled";
    case "used":
      return "Applied through a link";
  }
};

/** Why a loan ended, as both its sides read it (Grants ticket 11). */
const END_LABELS: Record<NonNullable<Grant["endReason"]>, string> = {
  revoked: "taken back",
  returned: "given back",
  "resource-gone": "it was deleted",
  "target-gone": "the Space was deleted",
  "lender-gone": "its lender was removed",
  "owner-changed": "it is no longer its lender's",
};

/** An ended loan's state, reason and day, «Ended 11/20/2026 (it was deleted)». */
const endedText = (grant: Pick<Grant, "endReason" | "endedAt">) =>
  `Ended${grant.endedAt === null ? "" : ` ${localDay(grant.endedAt)}`}${
    grant.endReason === null ? "" : ` (${END_LABELS[grant.endReason]})`
  }`;

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

/** What a borrower is told before accepting, and what the lent machine shows: the spec's words. */
export const lenderSeesEverything = (lender: string) =>
  `${lender} controls this machine and can see everything that runs on it: files, processes, the Secrets turns receive and each Thread's AI gateway key.`;

/** What whoever applies a link is told before they do: what the lender sees, and a subscription's terms. */
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

/** A loan's Space by name, or `fallback` for a link nobody applied. */
export const targetLabel = (grant: Grant, fallback: string) =>
  grant.target === null ? fallback : spaceLabel(grant.target);

/** What a loan lends, in words. */
export const nounOf = (grant: Pick<Grant, "resource">) =>
  grant.resource.kind === "ai-account"
    ? "AI account"
    : grant.resource.kind === "vault-group"
      ? "Vault group"
      : grant.resource.kind === "space-mcp"
        ? "MCP server"
        : grant.resource.kind === "space-skill"
          ? "Skill"
          : "machine";

/** What the borrower is told of a lent MCP server or Skill: its lender's, read-only here. */
export const spaceToolLenderSays = (lender: string) =>
  `${lender} can change or remove it at any time, and its configuration stays with them. An MCP server's Vault entries reach your Threads only through the Vault groups ${lender} lent you.`;

/**
 * Grants ticket 07: what the borrower is told of a lent Vault group: it is its lender's, read-only
 * here, and what it never brings.
 */
export const groupLenderSays = (lender: string) =>
  `${lender} can change what it holds at any time. It reaches your Threads once chosen as a default or by a Project. Names that change how tools run never come from it, and nothing of it reaches a machine lent to this Space.`;

/** What the borrower is told of what the lender sees, by kind. */
export const lenderSees = (grant: Grant) =>
  grant.resource.kind === "ai-account"
    ? `${grant.lender.name ?? "Its lender"} sees how much each person here uses it, never prompts or Threads.${grant.aiAccount?.type === "subscription" ? ` ${subscriptionTermsWarning(grant.aiAccount.provider)}` : ""}`
    : grant.resource.kind === "vault-group"
      ? groupLenderSays(grant.lender.name ?? "Its lender")
      : grant.resource.kind === "space-mcp" || grant.resource.kind === "space-skill"
        ? spaceToolLenderSays(grant.lender.name ?? "Its lender")
        : lenderSeesEverything(grant.lender.name ?? "Its lender");

const STATE_LABELS: Record<Grant["state"], string> = {
  offered: "Offered",
  pending: "Waiting for the Space",
  active: "Lent",
  rejected: "Rejected",
  cancelled: "Cancelled",
  ended: "Ended",
};

/** A loan's state in words; an ended one with its day and why (Grants ticket 11). */
export const stateText = (grant: Pick<Grant, "state" | "endReason" | "endedAt">) =>
  grant.state === "ended" ? endedText(grant) : STATE_LABELS[grant.state];

/** What an active loan adds to its description: cap use and, for a machine, its Sandbox and disk. */
export const loanStatusParts = (grant: Grant) => {
  const parts: string[] = [];
  const caps = grant.aiAccount?.caps;
  if (caps !== undefined && grant.state === "active") {
    if (caps.tokens !== null) parts.push(capUseText("tokens", caps.tokens));
    if (caps.requests !== null) parts.push(capUseText("requests", caps.requests));
  }
  const machine = grant.machine;
  if (machine !== undefined && grant.state === "active") {
    if (machine.sandboxState !== null) {
      parts.push(
        `Sandbox ${machine.sandboxState}${machine.sandboxMessage === null ? "" : `: ${machine.sandboxMessage}`}`,
      );
    }
    if (machine.diskUsedBytes !== null) parts.push(`${gib(machine.diskUsedBytes)} disk used`);
    if (machine.host !== null && !machine.host.ready) {
      parts.push(`The machine cannot run it now: ${machine.host.reason ?? "unknown"}`);
    }
  }
  return parts;
};

/** One loan's state, limits, Sandbox and disk, as either side sees it. */
export const loanDescription = (grant: Grant, side: "given" | "received") => {
  const where =
    side === "given"
      ? `to ${targetLabel(grant, "a Space")}`
      : `by ${grant.lender.name ?? "another User"}`;
  return [`${stateText(grant)} ${where}`, limitsText(grant.limits), ...loanStatusParts(grant)].join(
    " · ",
  );
};

/** The loans of one lent resource, with who it is lent to. */
export interface LentGroup {
  readonly key: string;
  readonly name: string;
  readonly kind: Grant["resource"]["kind"];
  readonly provider: string;
  readonly loans: ReadonlyArray<Grant>;
}

const lentName = (grant: Grant) => grant.resource.name ?? `Your ${nounOf(grant)}`;

/**
 * The loans a User made, one group per lent resource (keyed by its id, never by its name), sorted
 * by kind, provider and name; a group's loans by recipient.
 */
export function groupLentLoans(grants: ReadonlyArray<Grant>): ReadonlyArray<LentGroup> {
  const byResource = new Map<string, Grant[]>();
  for (const grant of grants) {
    const key = `${grant.resource.kind}:${grant.resource.id}`;
    byResource.set(key, [...(byResource.get(key) ?? []), grant]);
  }
  const groups = [...byResource.entries()].flatMap(([key, loans]) => {
    const first = loans[0];
    return first === undefined
      ? []
      : [
          {
            key,
            name: lentName(first),
            kind: first.resource.kind,
            provider: first.aiAccount?.provider ?? "",
            loans: [...loans].sort((a, b) => recipientLabel(a).localeCompare(recipientLabel(b))),
          },
        ];
  });
  return groups.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.provider.localeCompare(b.provider) ||
      a.name.localeCompare(b.name),
  );
}

/** A group's header count: the Spaces it went to, and its lending links still open. */
export const lentCountText = (group: LentGroup) => {
  const spaces = group.loans.filter((grant) => grant.target !== null).length;
  const open = group.loans.filter((grant) => grant.offer?.status === "open").length;
  return `lent to ${spaces}${open === 0 ? "" : ` · ${open} open link${open === 1 ? "" : "s"}`}`;
};

/**
 * What a User's Spaces received, as the lists show it: loans waiting for them to decide, loans in
 * use, and loans that ended (Grants ticket 11).
 */
export const receivedSections = (grants: ReadonlyArray<Grant>) => ({
  waiting: grants.filter((grant) => grant.state === "pending" && grant.can.decide),
  borrowed: grants.filter((grant) => grant.state === "active"),
  ended: grants.filter((grant) => grant.state === "ended"),
});

/** What ending a loan does, said before «Take back» (lender) or «Give back» (destination). */
export const endingWarning = (grant: Grant) => {
  const space = targetLabel(grant, "the Space");
  if (grant.resource.kind === "ai-account") {
    return `The Threads of ${space} that use it are refused from their next request and need another AI account; requests already running finish.`;
  }
  if (grant.resource.kind === "space-mcp" || grant.resource.kind === "space-skill") {
    return `The Threads of ${space} stop receiving it from their next turn.`;
  }
  if (grant.resource.kind === "vault-group") {
    return grant.can.revoke
      ? `The Threads of ${space} stop receiving it from their next turn, terminal or script; processes already running keep what they got.`
      : `Your Threads stop receiving it from their next turn, terminal or script. ${grant.lender.name ?? "Its lender"} will be asked to rotate its Secrets.`;
  }
  return `The Threads of ${space} on it stop: running turns get up to two minutes to save a checkpoint, and changes made by hand since the last turn may be lost. Its Sandbox and files are then deleted from the machine.`;
};

/**
 * Grants ticket 12: loans waiting for the viewer's decision, per Space and in all, as the Space
 * directory reports them (only to whoever decides there).
 */
export const pendingGrantsOf = (view: SpaceDirectoryView | null | undefined) => {
  const bySpace = new Map<SpaceId, number>();
  for (const space of view?.spaces ?? []) {
    if ((space.pendingGrants ?? 0) > 0) bySpace.set(space.id, space.pendingGrants ?? 0);
  }
  return { bySpace, total: [...bySpace.values()].reduce((sum, n) => sum + n, 0) };
};

/**
 * The token of a lending link as people paste it: `…/grants/offer#token=<token>` on any address
 * (the Hub's, the app's scheme), or the bare token. Null when it is neither.
 */
export const grantOfferTokenOf = (link: string): string | null => {
  const trimmed = link.trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  const match = /\/grants\/offer\/?#(?:.*&)?token=([A-Za-z0-9_-]+)/.exec(trimmed);
  return match?.[1] ?? null;
};
