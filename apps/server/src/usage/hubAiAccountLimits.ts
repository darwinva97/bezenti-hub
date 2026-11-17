/**
 * The Usage dialog's Limits for the Hub's own AI accounts (ticket 16): a Hub turn's CLI runs on a
 * gateway key, so no provider login reports its subscription's windows; the gateway holds them.
 * Shown to the Owner only, as one more limit source, by account name, never with reset credits.
 */
import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UserId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { HubSubscriptionLimits } from "../ai/AiAccounts.ts";
import * as CommandActor from "../auth/CommandActor.ts";

/** How often the Owner's snapshot is read again (the windows are cached 5 minutes anyway). */
const HUB_LIMITS_EVERY = "5 minutes";

/** The source's id; no configured CLIProxyAPI source can redeem through it. */
export const HUB_AI_ACCOUNTS_SOURCE_ID = UsageLimitSourceId.make("hub-ai-accounts");

const DRIVER_OF = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
} as const;

/** The Owner's snapshot; null (no source at all) for anyone else. */
export const hubAiAccountsSnapshot = (
  limits: HubSubscriptionLimits | null,
  checkedAt: string,
): UsageLimitSourceSnapshot | null => {
  if (limits === null) return null;
  const base = {
    id: HUB_AI_ACCOUNTS_SOURCE_ID,
    kind: "cliproxy",
    label: "Hub AI accounts",
    checkedAt,
  } as const;
  if (!limits.gatewayRunning) {
    return { ...base, accounts: [], error: "The Hub's AI gateway is not running." };
  }
  if (limits.accounts.length === 0) {
    return {
      ...base,
      accounts: [],
      error: "Its Claude and Codex subscriptions report no limits yet.",
    };
  }
  return {
    ...base,
    accounts: limits.accounts.map((account) => {
      // Windows only: no reset credits (nothing to redeem here), no fingerprint.
      const {
        resetCredits: _credits,
        credentialFingerprint: _fingerprint,
        ...usageLimits
      } = account.usageLimits;
      const id = account.name.trim() || `${account.provider} subscription`;
      return { id, driver: DRIVER_OF[account.provider], usageLimits };
    }),
  };
};

/**
 * A session's limit sources: the configured ones, plus the Hub's AI accounts when the session's
 * User is the Owner (decided here, on the server, as that User; anyone else never gets it). Read
 * again every few minutes, and each time the configured sources change.
 */
export const withHubAiAccountLimits = (
  sources: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>,
  read: Effect.Effect<HubSubscriptionLimits | null>,
  userId: UserId | undefined,
): Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>> => {
  const snapshot = read.pipe(
    CommandActor.actAs(userId),
    Effect.flatMap((limits) =>
      Effect.map(DateTime.now, (now) => hubAiAccountsSnapshot(limits, DateTime.formatIso(now))),
    ),
  );
  const hub = Stream.fromEffect(snapshot).pipe(
    Stream.concat(
      Stream.fromSchedule(Schedule.spaced(HUB_LIMITS_EVERY)).pipe(Stream.mapEffect(() => snapshot)),
    ),
  );
  return Stream.zipLatestWith(sources, hub, (configured, own) =>
    own === null ? configured : [...configured, own],
  ).pipe(
    // A re-read that found the same windows sends nothing (only `checkedAt` would differ).
    Stream.changesWith(
      (previous, next) =>
        JSON.stringify(withoutCheckedAt(previous)) === JSON.stringify(withoutCheckedAt(next)),
    ),
  );
};

const withoutCheckedAt = (sources: ReadonlyArray<UsageLimitSourceSnapshot>) =>
  sources.map((source) =>
    source.id === HUB_AI_ACCOUNTS_SOURCE_ID ? { ...source, checkedAt: "" } : source,
  );
