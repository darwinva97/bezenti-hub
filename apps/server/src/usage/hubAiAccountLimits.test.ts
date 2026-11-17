import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { HubSubscriptionLimits } from "../ai/AiAccounts.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import {
  HUB_AI_ACCOUNTS_SOURCE_ID,
  hubAiAccountsSnapshot,
  withHubAiAccountLimits,
} from "./hubAiAccountLimits.ts";

const AT = "2026-11-16T10:00:00.000Z";
const WINDOWS = {
  checkedAt: AT,
  windows: [{ id: "5h", kind: "session", label: "5 hours", usedPercent: 40 }],
  credentialFingerprint: "fp-secret",
  resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
} as const;
const OWNER_VIEW: HubSubscriptionLimits = {
  gatewayRunning: true,
  accounts: [{ name: "Team Claude", provider: "claude", usageLimits: WINDOWS }],
};
const CONFIGURED: UsageLimitSourceSnapshot = {
  id: UsageLimitSourceId.make("mine"),
  kind: "cliproxy",
  label: "My CLIProxyAPI",
  checkedAt: AT,
  accounts: [],
};

describe("the Hub's AI accounts in the Usage dialog's Limits (ticket 16)", () => {
  it("shows the Owner each subscription by name, with windows only", () => {
    const snapshot = hubAiAccountsSnapshot(OWNER_VIEW, AT);
    assert.equal(snapshot?.id, HUB_AI_ACCOUNTS_SOURCE_ID);
    assert.deepEqual(snapshot?.accounts, [
      {
        id: "Team Claude",
        driver: ProviderDriverKind.make("claudeAgent"),
        usageLimits: { checkedAt: AT, windows: WINDOWS.windows },
      },
    ]);
    // Nothing to redeem, nothing derived from the credential.
    assert.notInclude(JSON.stringify(snapshot), "credit-1");
    assert.notInclude(JSON.stringify(snapshot), "fp-secret");
  });

  it("says why there is nothing, and gives anyone else no source at all", () => {
    assert.equal(
      hubAiAccountsSnapshot({ gatewayRunning: false, accounts: [] }, AT)?.error,
      "The Hub's AI gateway is not running.",
    );
    assert.isDefined(hubAiAccountsSnapshot({ gatewayRunning: true, accounts: [] }, AT)?.error);
    assert.isNull(hubAiAccountsSnapshot(null, AT));
  });

  it.effect("a non-Owner's stream never carries the Hub's snapshot; the Owner's does", () =>
    Effect.gen(function* () {
      const askedAs: Array<UserId | undefined> = [];
      // Like AiAccounts.ownerSubscriptionLimits: the Owner's view only for the Owner.
      const read = Effect.map(CommandActor.current, (userId) => {
        askedAs.push(userId);
        return userId === UserId.make("owner") ? OWNER_VIEW : null;
      });
      const first = (userId: string) =>
        withHubAiAccountLimits(Stream.make([CONFIGURED]), read, UserId.make(userId)).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map((all) => [...all][0] ?? []),
        );
      const member = yield* first("grace");
      assert.deepEqual(
        member.map((source) => source.id),
        [CONFIGURED.id],
      );
      const owner = yield* first("owner");
      assert.deepEqual(
        owner.map((source) => source.id),
        [CONFIGURED.id, HUB_AI_ACCOUNTS_SOURCE_ID],
      );
      // Decided as the session's own User, on the server.
      assert.deepEqual(askedAs, [UserId.make("grace"), UserId.make("owner")]);
    }),
  );
});
