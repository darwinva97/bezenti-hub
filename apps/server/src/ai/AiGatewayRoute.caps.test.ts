// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Grants ticket 03 at the AI gateway: a lent AI account's caps, per Grant, checked before each
 * request goes to it, in every shape. A Grant out of its cap fails over like an account out of
 * quota, or answers 429 naming the loan, its cap and its reset (never anyone's use). The Space's
 * own accounts are never capped; local CLI keys count against the same Grant.
 */
import { assert, it } from "@effect/vitest";
import { type AiAccountId, type GrantCap, SpaceId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as Grants from "../grants/Grants.ts";
import { lendAiAccount } from "../grants/Grants.testkit.ts";
import { call, hub, messages, platform, posix, type Hub } from "./AiGatewayRoute.testkit.ts";

const ANTHROPIC = "/api/ai/anthropic/v1/messages";
/** What the fake CLIProxyAPI answers each request with: 11 in, 7 out. */
const TOKENS_PER_ANSWER = 18;

const accountOf = Effect.fn(function* (
  setup: Hub,
  actor: UserId,
  name: string,
  owner?: { readonly kind: "organization"; readonly spaceId: SpaceId },
) {
  const made = yield* setup.accounts
    .create({
      name,
      provider: "claude" as never,
      apiKey: Redacted.make(`sk-capped-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      ...(owner === undefined ? {} : { owner }),
    })
    .pipe(CommandActor.actAs(actor));
  return made.id;
});

const tokensADay = (amount: number) =>
  ({
    kind: "ai-account",
    tokens: { amount, period: "day" } satisfies GrantCap,
    requests: null,
  }) as const;

/** Grace lends her account to Acme with these caps; Ada (Acme's Admin) accepts. */
const lentToAcme = Effect.fn(function* (
  setup: Hub,
  accountId: AiAccountId,
  limits: ReturnType<typeof tokensADay>,
) {
  const grants = Context.get(setup.server.services, Grants.Grants);
  const given = yield* grants
    .give(
      { resource: { kind: "ai-account", aiAccountId: accountId }, spaceId: setup.acmeId, limits },
      { strongFactor: false },
    )
    .pipe(CommandActor.actAs(setup.people.member));
  yield* grants
    .accept({ grantId: given.id }, { strongFactor: false })
    .pipe(CommandActor.actAs(setup.people.admin));
  return given.id;
});

it.live.skipIf(!posix || platform === undefined)(
  "a new request after a Grant's cap is refused in every shape, naming the loan and its reset; the in-flight ones finished",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const grace = setup.people.member;
      const graces = yield* accountOf(setup, grace, "Grace Claude");
      yield* lentToAcme(setup, graces, tokensADay(TOKENS_PER_ANSWER + 2));
      // Also lent to Globex, with room: another loan of the same account, its own cap.
      yield* lendAiAccount(setup.server.sql, {
        accountId: graces,
        lender: { kind: "user", id: grace },
        spaceId: setup.globexId,
        limits: tokensADay(10_000),
      });
      const ada = yield* setup.thread(setup.people.admin, setup.acmeId, graces);
      const ask = () => call(setup, ANTHROPIC, { key: ada.key, body: messages() });

      // Two at once below the cap: both are in flight when it is reached, so both finish.
      const both = yield* Effect.all([ask(), ask()], { concurrency: 2 });
      assert.deepEqual(
        both.map((answer) => answer.status),
        [200, 200],
      );
      const before = setup.upstream().length;
      // Now over it: refused before anything reaches upstream, in each client's shape.
      const anthropic = yield* ask();
      assert.equal(anthropic.status, 429);
      // The reset is the next UTC midnight (GrantCaps.test checks the date itself).
      const expected =
        /The AI account Grace Claude lent to Acme reached its daily token cap; it resets \d{4}-\d{2}-\d{2} 00:00 UTC\. Switch AI account\./u;
      assert.match(anthropic.text, expected);
      assert.deepInclude(anthropic.json ?? {}, { type: "error" });
      const openai = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key: ada.key,
        body: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(openai.status, 429);
      assert.match(openai.text, expected);
      assert.isDefined((openai.json as { error?: unknown } | null)?.error);
      const gemini = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/claude-sonnet-5-5:generateContent",
        { key: ada.key, keyHeader: "x-goog-api-key", body: { contents: [] } },
      );
      assert.equal(gemini.status, 429);
      assert.match(gemini.text, expected);
      assert.equal(setup.upstream().length, before);
      // It names no other Space and nobody's use.
      for (const answer of [anthropic, openai, gemini]) {
        assert.notInclude(answer.text, "Globex");
        assert.notInclude(answer.text, String(2 * TOKENS_PER_ANSWER));
      }

      // The same account lent to Globex has its own cap: Gus still uses it.
      const gus = yield* setup.thread(setup.people.globexMember, setup.globexId, graces);
      assert.equal((yield* call(setup, ANTHROPIC, { key: gus.key, body: messages() })).status, 200);
      // Grace's own use, in her Personal space, is never capped.
      const home = yield* setup.thread(grace, SpaceId.make(`personal:${grace}`), graces);
      for (let index = 0; index < 3; index += 1) {
        assert.equal(
          (yield* call(setup, ANTHROPIC, { key: home.key, body: messages() })).status,
          200,
        );
      }
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a Grant out of its cap fails over to another allowed account of its provider",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const graces = yield* accountOf(setup, setup.people.member, "Grace Claude");
      yield* lentToAcme(setup, graces, tokensADay(1));
      const acmes = yield* accountOf(setup, setup.people.admin, "Acme Claude", {
        kind: "organization",
        spaceId: setup.acmeId,
      });
      // Ada's Thread chose Grace's lent account: first to Grace's, then (out of cap) Acme's.
      const ada = yield* setup.thread(setup.people.admin, setup.acmeId, graces);
      const ask = () => call(setup, ANTHROPIC, { key: ada.key, body: messages() });
      assert.equal((yield* ask()).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${graces}/claude-sonnet-5-5`);
      const failedOver = yield* ask();
      assert.equal(failedOver.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${acmes}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a local CLI key counts against the same Grant; lowering the cap below what was used stops the next request",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const grace = setup.people.member;
      const graces = yield* accountOf(setup, grace, "Grace Claude");
      const grantId = yield* lentToAcme(setup, graces, tokensADay(10_000));
      const cli = yield* setup.keys.createForUser({
        actorUserId: setup.people.admin,
        spaceId: setup.acmeId,
        name: "Ada laptop",
      });
      const pinned = messages(`acct-${graces}/claude-sonnet-5-5`);
      const viaCli = () => call(setup, ANTHROPIC, { key: Redacted.value(cli.key), body: pinned });
      assert.equal((yield* viaCli()).status, 200);
      assert.equal((yield* viaCli()).status, 200);

      // The lender lowers the cap under the 36 tokens used: the next request, by any key, stops.
      const grants = Context.get(setup.server.services, Grants.Grants);
      yield* grants.setLimits({ grantId, limits: tokensADay(30) }).pipe(CommandActor.actAs(grace));
      const refused = yield* viaCli();
      assert.equal(refused.status, 429);
      assert.include(refused.text, "reached its daily token cap");
      const thread = yield* setup.thread(setup.people.admin, setup.acmeId, graces);
      assert.equal(
        (yield* call(setup, ANTHROPIC, { key: thread.key, body: messages() })).status,
        429,
      );
      // Raised again: allowed again.
      yield* grants
        .setLimits({ grantId, limits: tokensADay(1_000) })
        .pipe(CommandActor.actAs(grace));
      assert.equal((yield* viaCli()).status, 200);
    }).pipe(Effect.scoped),
);
