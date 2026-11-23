// @effect-diagnostics globalJsonInEffect:off - reads the audit's JSON detail.
/**
 * Access-keys ticket 03: the AI accounts an access key reaches, all the Space's own (now and
 * later) or a list, evaluated on every request; on a real port over the fake CLIProxyAPI.
 */
import { assert, it } from "@effect/vitest";
import type { AiAccountId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  acmeSetup,
  call,
  type Hub,
  hub,
  messages,
  platform,
  posix,
  upstreamModels,
} from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const WEEK = { days: 7 } as const;
const NO_ACCOUNT = "No AI account this access key may use is available now.";

/** An AI account of Acme's own, added by Ada. */
const acmeAccount = (
  setup: Hub,
  name: string,
  extra: { readonly type?: "direct"; readonly provider?: "claude" | "cursor" } = {},
) =>
  setup.accounts
    .create({
      name,
      provider: extra.provider ?? "claude",
      ...(extra.type === undefined ? {} : { type: extra.type }),
      apiKey: Redacted.make(`sk-${name.replaceAll(" ", "-").toLowerCase()}-0123456789abcdef`),
      owner: { kind: "organization", spaceId: setup.acmeId },
    })
    .pipe(
      CommandActor.actAs(setup.people.admin),
      Effect.map((made) => made.id),
    );

const keyFor = (setup: Hub, accounts: ReadonlyArray<AiAccountId> | null, label = "Partner") =>
  setup.accessKeys
    .createForSession({
      spaceId: setup.acmeId,
      label,
      validity: WEEK,
      models: ["*"],
      ...(accounts === null ? {} : { accounts }),
    })
    .pipe(CommandActor.actAs(setup.people.admin));

const ask = (setup: Hub, key: Redacted.Redacted<string>, model = "claude-sonnet-5-5") =>
  call(setup, MESSAGES, { key: Redacted.value(key), body: messages(model) });

it.live.skipIf(!posix || platform === undefined)(
  "a key with only account A never reaches B, not even when A is out of quota; a key for all fails over",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const a = yield* acmeAccount(setup, "Acme Claude A");
      const b = yield* acmeAccount(setup, "Acme Claude B");
      const onlyA = yield* keyFor(setup, [a]);
      const all = yield* keyFor(setup, null, "Everything");
      assert.deepEqual(onlyA.created.accounts, [a]);
      assert.deepEqual(onlyA.created.reaches, [{ id: a, name: "Acme Claude A", inSpace: true }]);
      assert.isNull(all.created.accounts);
      assert.isNull(all.created.reaches);

      assert.equal((yield* ask(setup, onlyA.key)).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${a}/claude-sonnet-5-5`);
      const pinnedB = yield* ask(setup, onlyA.key, `acct-${b}/claude-sonnet-5-5`);
      assert.equal(pinnedB.status, 403);
      assert.include(pinnedB.text, "This access key may not use that AI account.");

      // A out of quota: the key with only A gets the 429, B is never tried.
      setup.flag(`fake-quota-${a}`);
      const before = setup.upstream().length;
      const limited = yield* ask(setup, onlyA.key);
      assert.equal(limited.status, 429);
      assert.deepEqual(upstreamModels(setup).slice(before), [`acct-${a}/claude-sonnet-5-5`]);
      // The key for all fails over to B, as a User key would.
      const failedOver = yield* ask(setup, all.key);
      assert.equal(failedOver.status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${b}/claude-sonnet-5-5`);
      setup.flag(`fake-quota-${a}`, false);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key for all reaches an account the Space adds later; one whose only account is disabled is refused from the next request and lists it as no longer in the Space",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      // Accounts lent to Acme are not its own: a key reaches none of them.
      yield* acmeSetup(setup);
      const all = yield* keyFor(setup, null);
      const none = yield* ask(setup, all.key);
      assert.equal(none.status, 403);
      assert.include(none.text, NO_ACCOUNT);

      const a = yield* acmeAccount(setup, "Acme Claude A");
      assert.equal((yield* ask(setup, all.key)).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${a}/claude-sonnet-5-5`);

      const onlyA = yield* keyFor(setup, [a], "Only A");
      assert.equal((yield* ask(setup, onlyA.key)).status, 200);
      yield* setup.accounts
        .update({ accountId: a, disabled: true })
        .pipe(CommandActor.actAs(setup.people.admin));
      const refused = yield* ask(setup, onlyA.key);
      assert.equal(refused.status, 403);
      assert.include(refused.text, NO_ACCOUNT);
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      const shown = listed.keys.find((key) => key.keyId === onlyA.created.keyId);
      assert.deepEqual(shown?.reaches, [{ id: a, name: "Acme Claude A", inSpace: false }]);
      // Enabled again, it counts again: nothing was written on the key.
      yield* setup.accounts
        .update({ accountId: a, disabled: false })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.equal((yield* ask(setup, onlyA.key)).status, 200);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "only the Space's own gateway accounts may be chosen; a direct one, a lent one or another Space's never",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const lent = yield* acmeSetup(setup);
      const a = yield* acmeAccount(setup, "Acme Claude A");
      const direct = yield* acmeAccount(setup, "Acme Cursor", {
        type: "direct",
        provider: "cursor",
      });
      for (const accounts of [
        [direct],
        [lent.claudeA],
        [lent.globexClaude],
        ["acct-unknown" as AiAccountId],
        [],
      ]) {
        const refused = yield* keyFor(setup, accounts).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid", JSON.stringify(accounts));
      }
      // A direct account is never offered nor reached, even by a key for all.
      const options = yield* setup.accessKeys
        .modelOptionsForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.deepEqual(
        options.accounts.map((account) => account.id),
        [a],
      );
      const all = yield* keyFor(setup, null);
      const pinned = yield* ask(setup, all.key, `acct-${direct}/claude-sonnet-5-5`);
      assert.equal(pinned.status, 403);
      // Duplicates fold; the audit counts the accounts.
      const twice = yield* keyFor(setup, [a, a], "Twice");
      assert.deepEqual(twice.created.accounts, [a]);
      const details = yield* setup.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'access_key.create'
        ORDER BY rowid
      `;
      assert.deepEqual(
        details.map((row) => (JSON.parse(row.detail) as { accounts: unknown }).accounts),
        ["all", 1],
      );
    }).pipe(Effect.scoped),
);
