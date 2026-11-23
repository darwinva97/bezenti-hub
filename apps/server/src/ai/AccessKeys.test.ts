// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalJsonInEffect:off - a client on the real port over the fake CLIProxyAPI, and the SHA-256 the Hub keeps.
/**
 * Access keys (access-keys ticket 01): a Space's own AI gateway keys, made, listed and revoked by
 * whoever manages the Space (WS `accessKeys.*`), used at `/api/ai/*` on a real port over the fake
 * CLIProxyAPI, with Ada (Admin), Grace (Member) and Linus (Guest) of Acme and Gus of Globex. No
 * test prints a key: assertions on keys say what failed, never the value.
 */
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import { type AiAccountId, SpaceId, type UserId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import {
  acmeSetup,
  call,
  type Hub,
  hub,
  messages,
  platform,
  posix,
  PROMPT,
  upstreamModels,
} from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const CHAT = "/api/ai/openai/v1/chat/completions";
const GEMINI = "/api/ai/gemini/v1beta/models/gemini-3-pro:generateContent";
const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);
const WEEK = { days: 7 } as const;
const ALL = ["*"];

/** Acme's own AI accounts, added by Ada: Claude, OpenAI (Codex) and Gemini API keys. */
const acmeOwn = Effect.fn(function* (setup: Hub) {
  const owner = { kind: "organization", spaceId: setup.acmeId } as const;
  const add = (name: string, provider: "claude" | "codex" | "gemini") =>
    setup.accounts
      .create({
        name,
        provider,
        apiKey: Redacted.make(`sk-acme-own-${provider}-0123456789abcdef`),
        owner,
      })
      .pipe(
        CommandActor.actAs(setup.people.admin),
        Effect.map((made) => made.id),
      );
  return {
    claude: yield* add("Acme own Claude", "claude"),
    codex: yield* add("Acme own OpenAI", "codex"),
    gemini: yield* add("Acme own Gemini", "gemini"),
  };
});

/** Ada makes a key for Acme; the key's value, for the test's own requests. */
const adaKey = Effect.fn(function* (setup: Hub, label = "Partner") {
  const made = yield* setup.accessKeys
    .createForSession({
      spaceId: setup.acmeId,
      label,
      validity: WEEK,
      models: ALL,
      unlimited: true,
    })
    .pipe(CommandActor.actAs(setup.people.admin));
  return { ...made, value: Redacted.value(made.key) };
});

/** A request that streams its first event, then waits for `release` before the rest. */
const heldStream = (setup: Hub, key: string) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${setup.port}${MESSAGES}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    return {
      status: response.status,
      first,
      rest: async () => {
        let rest = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += decoder.decode(chunk.value);
        }
        return rest;
      },
    };
  });

it.live.skipIf(!posix || platform === undefined)(
  "an Acme key answers in the Anthropic, OpenAI and Gemini shapes through Acme's own accounts only, and its use counts on the key with no User",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const lent = yield* acmeSetup(setup);
      const own = yield* acmeOwn(setup);
      const made = yield* adaKey(setup);
      const key = made.value;
      assert.isTrue(/^t3ak_[A-Za-z0-9_-]{43}$/u.test(key), "the key has the access key's form");
      assert.equal(made.created.spaceId, setup.acmeId);
      assert.equal(made.created.spaceName, "Acme");
      assert.equal(made.created.hint, key.slice(-4));
      assert.deepEqual(made.created.models, ["*"]);
      assert.isNull(made.created.accounts);

      const anthropic = yield* call(setup, MESSAGES, {
        key,
        keyHeader: "x-api-key",
        body: messages(),
      });
      assert.equal(anthropic.status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${own.claude}/claude-sonnet-5-5`);
      const openai = yield* call(setup, CHAT, {
        key,
        body: { model: "gpt-5.5", messages: [{ role: "user", content: PROMPT }] },
      });
      assert.equal(openai.status, 200, openai.text);
      assert.equal(upstreamModels(setup).at(-1), `acct-${own.codex}/gpt-5.5`);
      const gemini = yield* call(setup, GEMINI, {
        key,
        keyHeader: "x-goog-api-key",
        body: { contents: [{ parts: [{ text: PROMPT }] }] },
      });
      assert.equal(gemini.status, 200, gemini.text);
      assert.equal(upstreamModels(setup).at(-1), `acct-${own.gemini}/gemini-3-pro`);

      // Never an account lent to Acme, nor Globex's: pinned or by a model only they serve.
      const before = setup.upstream().length;
      for (const pinned of [lent.claudeA, lent.globexClaude]) {
        const answer = yield* call(setup, MESSAGES, {
          key,
          body: messages(`acct-${pinned}/claude-sonnet-5-5`),
        });
        assert.equal(answer.status, 403);
      }
      const onlyLent = yield* call(setup, CHAT, {
        key,
        body: { model: "deepseek-chat", messages: [] },
      });
      assert.equal(onlyLent.status, 404);
      assert.equal(setup.upstream().length, before, "a lent or Globex account was reached");
      const models = yield* call(setup, "/api/ai/openai/v1/models", { key });
      assert.equal(models.status, 200);
      assert.include(models.text, "claude-sonnet-5-5");
      for (const hidden of ["deepseek-chat", "globex-secret-model"]) {
        assert.notInclude(models.text, hidden);
      }

      // Usage: no User, the key and Acme; the refusals after the key as failed requests.
      yield* setup.settled(6);
      const usage = yield* setup.server.sql<{
        readonly userId: string;
        readonly accessKeyId: string | null;
        readonly spaceId: string;
        readonly accountId: string | null;
        readonly status: number;
      }>`
        SELECT user_id AS "userId", access_key_id AS "accessKeyId", space_id AS "spaceId",
          account_id AS "accountId", status FROM ai_usage WHERE key_id = ${made.created.keyId}
      `;
      assert.lengthOf(usage, 6);
      for (const row of usage) {
        assert.equal(row.userId, "");
        assert.equal(row.accessKeyId, made.created.keyId);
        assert.equal(row.spaceId, setup.acmeId);
      }
      assert.sameMembers(
        usage.filter((row) => row.status === 200).map((row) => row.accountId),
        [own.claude, own.codex, own.gemini],
      );
      // Usage still answers for the Space (access-keys ticket 04 shows the key's rows).
      for (const viewer of [setup.asOwner, CommandActor.actAs(setup.people.admin)]) {
        const summary = yield* setup.usage.summary({ spaceId: setup.acmeId }).pipe(viewer);
        assert.isFalse(summary.rows.some((row) => (row.userId as string) === ""));
      }
      // Its last use shows in the list.
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.isNotNull(listed.keys[0]!.lastUsedAt);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a revoked key answers 401 from the next request while the one in flight finishes; a key of the wrong form is refused unread",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* adaKey(setup);
      setup.flag("fake-stream-hold");
      const held = yield* heldStream(setup, made.value);
      assert.equal(held.status, 200);
      assert.include(held.first, "message_start");

      const revoked = yield* setup.accessKeys
        .revokeForSession({ keyId: made.created.keyId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.isNotNull(revoked.revokedAt);
      const next = yield* call(setup, MESSAGES, { key: made.value, body: messages() });
      assert.equal(next.status, 401);
      assert.include(next.text, "not valid");

      setup.flag("fake-stream-release");
      const rest = yield* Effect.promise(held.rest);
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.include(rest, "Hello from claude-sonnet-5-5");
      assert.include(rest, "message_stop");

      // Revoking again changes nothing; it is audited once.
      yield* setup.accessKeys
        .revokeForSession({ keyId: made.created.keyId })
        .pipe(CommandActor.actAs(setup.people.admin));
      const audits = yield* setup.server.sql<{ readonly action: string; readonly detail: string }>`
        SELECT action, detail_json AS detail FROM audit_log WHERE action LIKE 'access_key.%'
        ORDER BY rowid
      `;
      assert.deepEqual(
        audits.map((row) => row.action),
        ["access_key.create", "access_key.revoke"],
      );
      assert.include(audits[1]!.detail, '"reason":"revoked"');

      // A key of the wrong form (another prefix, short, odd characters): 401.
      for (const odd of [
        "t3ak_short",
        `t3ax_${made.value.slice(5)}`,
        `${made.value.slice(0, -1)}!`,
      ]) {
        assert.equal((yield* call(setup, MESSAGES, { key: odd, body: messages() })).status, 401);
      }
      // Revoked keys are hidden from the list unless asked for.
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.lengthOf(listed.keys, 0);
      const ended = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId, includeEnded: true })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.deepEqual(
        ended.keys.map((key) => key.keyId),
        [made.created.keyId],
      );
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "an expired key answers 403 with its date in UTC while a request admitted before finishes; its expiry follows the Hub's clock",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* adaKey(setup);
      const expiresAt = Date.parse(made.created.expiresAt);
      // Seven days from now.
      assert.approximately(expiresAt - (yield* Clock.currentTimeMillis), 7 * 86_400_000, 60_000);

      // The Hub's clock decides: a minute before, admitted; at its expiry, refused with the date.
      const atTime = (millis: number) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(millis);
          return yield* setup.keys.authorize(Redacted.make(made.value)).pipe(Effect.result);
        }).pipe(Effect.provide(TestClock.layer()));
      const before = yield* atTime(expiresAt - 60_000);
      assert.equal(before._tag, "Success");
      const after = yield* atTime(expiresAt);
      assert.equal(after._tag, "Failure");
      if (after._tag === "Failure") {
        assert.equal(after.failure.status, 403);
        const date = `${made.created.expiresAt.slice(0, 16).replace("T", " ")} UTC`;
        assert.equal(
          after.failure.message,
          `This access key expired on ${date}. Ask whoever gave it to you to renew it.`,
        );
      }

      // Over HTTP: a request in flight, then the key expires (its row moved back in time).
      setup.flag("fake-stream-hold");
      const held = yield* heldStream(setup, made.value);
      assert.equal(held.status, 200);
      const past = "2026-01-02T03:04:05.000Z";
      yield* setup.server.sql`
        UPDATE ai_access_keys SET expires_at = ${past} WHERE key_id = ${made.created.keyId}
      `;
      for (const [path, header, body] of [
        [MESSAGES, "x-api-key", messages()],
        [CHAT, "authorization", { model: "gpt-5.5", messages: [] }],
        [GEMINI, "x-goog-api-key", { contents: [] }],
      ] as const) {
        const refused = yield* call(setup, path, { key: made.value, keyHeader: header, body });
        assert.equal(refused.status, 403, path);
        assert.include(refused.text, "This access key expired on 2026-01-02 03:04 UTC.");
      }
      setup.flag("fake-stream-release");
      const rest = yield* Effect.promise(held.rest);
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.include(rest, "message_stop");
      // An expired key is not revoked: it still shows (ticket 06 renews it).
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId, includeEnded: true })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.isNull(listed.keys[0]!.revokedAt);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key is refused while its Organization is archived and works again once it is restored; a disabled User's Personal space key is refused",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* adaKey(setup);
      const ask = () => call(setup, MESSAGES, { key: made.value, body: messages() });
      assert.equal((yield* ask()).status, 200);
      const archived = yield* setup.server.request(`/api/spaces/${setup.acmeId}/archive`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.equal(archived.status, 200, JSON.stringify(archived.body));
      const refused = yield* ask();
      assert.equal(refused.status, 403);
      assert.include(refused.text, "This access key's Space is archived.");
      // Archived: nobody makes a key, the Owner included; the Owner still lists and could revoke.
      const blocked = yield* setup.accessKeys
        .createForSession({
          spaceId: setup.acmeId,
          label: "Late",
          validity: WEEK,
          models: ALL,
          unlimited: true,
        })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(blocked.reason, "forbidden");
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(setup.asOwner);
      assert.deepEqual(listed.space, { canManage: false, subscription: false });
      assert.lengthOf(listed.keys, 1);
      const restored = yield* setup.server.request(`/api/spaces/${setup.acmeId}/restore`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal((yield* ask()).status, 200);

      // Grace's key for her Personal space reaches her own account; disabled, she gives nothing.
      const grace = setup.people.member;
      const asGrace = CommandActor.actAs(grace);
      const gracesClaude: AiAccountId = (yield* setup.accounts
        .create({
          name: "Grace Claude",
          provider: "claude",
          apiKey: Redacted.make("sk-grace-own-claude-0123456789abcdef"),
        })
        .pipe(asGrace)).id;
      const personal = yield* setup.accessKeys
        .createForSession({
          spaceId: personalOf(grace),
          label: "A friend",
          validity: WEEK,
          models: ALL,
          unlimited: true,
        })
        .pipe(asGrace);
      const friend = Redacted.value(personal.key);
      assert.equal((yield* call(setup, MESSAGES, { key: friend, body: messages() })).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${gracesClaude}/claude-sonnet-5-5`);
      const disabled = yield* setup.server.request(`/api/installation/users/${grace}/status`, {
        body: { status: "disabled" },
        cookie: setup.ownerCookie,
      });
      assert.equal(disabled.status, 200);
      const closed = yield* call(setup, MESSAGES, { key: friend, body: messages() });
      assert.equal(closed.status, 403);
      assert.include(closed.text, "This access key's Space is closed now.");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a Space's managers make, list and revoke its keys; Members, Guests, outsiders, agents and one-Space sessions do nothing; the Owner sees and revokes all, and makes none in another User's Personal space",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const { admin, member, guest, globexMember } = setup.people;
      // Olga, a second Admin of Acme (with a passkey, so she acts as one).
      yield* addMember(setup.server, { id: "olga", displayName: "olga" });
      yield* joinOrganization(setup.server, setup.acmeId, "olga", "admin");
      yield* setup.server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key,
          sign_count, transports, rp_id, created_at)
        VALUES ('olga-key', 'olga', 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
      const olga = "olga" as UserId;
      yield* setup.directory.membershipsChanged([olga]);

      const made = yield* adaKey(setup);
      const keyId = made.created.keyId;
      // Nobody but Acme's managers (and the Owner) makes, lists or revokes Acme's keys.
      for (const outsider of [member, guest, globexMember]) {
        const as = CommandActor.actAs(outsider);
        const create = yield* setup.accessKeys
          .createForSession({
            spaceId: setup.acmeId,
            label: "Mine",
            validity: WEEK,
            models: ALL,
            unlimited: true,
          })
          .pipe(as, Effect.flip);
        assert.equal(create.reason, "forbidden", outsider);
        const list = yield* setup.accessKeys
          .listForSession({ spaceId: setup.acmeId })
          .pipe(as, Effect.flip);
        assert.equal(list.reason, "forbidden", outsider);
        const revoke = yield* setup.accessKeys.revokeForSession({ keyId }).pipe(as, Effect.flip);
        assert.equal(revoke.reason, "not-found", outsider);
        // Their own lists hold none of Acme's.
        const own = yield* setup.accessKeys.listForSession({}).pipe(as);
        assert.isFalse(own.keys.some((key) => key.keyId === keyId));
      }
      // An agent (MCP, as Ada), a session limited to Acme and a Thread's owner do nothing.
      for (const actor of [
        { _tag: "User", userId: admin, via: "agent" },
        { _tag: "User", userId: admin, spaceLimit: setup.acmeId },
        { _tag: "ThreadOwner" },
      ] as const) {
        const as = CommandActor.actAsResolved(actor);
        for (const attempt of [
          setup.accessKeys
            .createForSession({
              spaceId: setup.acmeId,
              label: "Agent",
              validity: WEEK,
              models: ALL,
              unlimited: true,
            })
            .pipe(Effect.asVoid),
          setup.accessKeys.listForSession({ spaceId: setup.acmeId }).pipe(Effect.asVoid),
          setup.accessKeys.revokeForSession({ keyId }).pipe(Effect.asVoid),
        ]) {
          const refused = yield* attempt.pipe(as, Effect.flip);
          assert.equal(refused.reason, "forbidden");
        }
      }
      // Olga sees Ada's key and makes her own.
      const olgas = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(olga));
      assert.deepEqual(
        olgas.keys.map((key) => [key.label, key.createdBy, key.createdByName]),
        [["Partner", admin, "ada"]],
      );
      assert.isTrue(olgas.space?.canManage);
      const second = yield* setup.accessKeys
        .createForSession({
          spaceId: setup.acmeId,
          label: "Tester",
          validity: { days: 1 },
          models: ALL,
          unlimited: true,
        })
        .pipe(CommandActor.actAs(olga));
      // Olga revokes Ada's; the next request is refused.
      yield* setup.accessKeys.revokeForSession({ keyId }).pipe(CommandActor.actAs(olga));
      assert.equal(
        (yield* call(setup, MESSAGES, { key: made.value, body: messages() })).status,
        401,
      );

      // Grace makes one in her own Personal space; the Owner revokes it but makes none there.
      const graces = yield* setup.accessKeys
        .createForSession({
          spaceId: personalOf(member),
          label: "Friend",
          validity: WEEK,
          models: ALL,
          unlimited: true,
        })
        .pipe(CommandActor.actAs(member));
      const ownerThere = yield* setup.accessKeys
        .createForSession({
          spaceId: personalOf(member),
          label: "Owner's",
          validity: WEEK,
          models: ALL,
          unlimited: true,
        })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(ownerThere.reason, "forbidden");
      const gusThere = yield* setup.accessKeys
        .listForSession({ spaceId: personalOf(member) })
        .pipe(CommandActor.actAs(globexMember), Effect.flip);
      assert.equal(gusThere.reason, "forbidden");
      // The Owner's list without a Space holds every Space's keys.
      const everyone = yield* setup.accessKeys.listForSession({}).pipe(setup.asOwner);
      assert.isTrue(everyone.everyone);
      assert.sameMembers(
        everyone.keys.map((key) => key.label),
        ["Tester", "Friend"],
      );
      yield* setup.accessKeys.revokeForSession({ keyId: graces.created.keyId }).pipe(setup.asOwner);
      assert.equal(
        (yield* call(setup, MESSAGES, { key: Redacted.value(graces.key), body: messages() }))
          .status,
        401,
      );
      // The Owner makes one in Acme; Grace's own list holds only her Personal space's.
      yield* setup.accessKeys
        .createForSession({
          spaceId: setup.acmeId,
          label: "Owner's",
          validity: WEEK,
          models: ALL,
          unlimited: true,
        })
        .pipe(setup.asOwner);
      const gracesList = yield* setup.accessKeys
        .listForSession({ includeEnded: true })
        .pipe(CommandActor.actAs(member));
      assert.deepEqual(
        gracesList.keys.map((key) => key.label),
        ["Friend"],
      );

      const audits = yield* setup.server.sql<{
        readonly action: string;
        readonly actor: string | null;
        readonly space: string | null;
      }>`
        SELECT action, actor_user_id AS actor, space_id AS space FROM audit_log
        WHERE action LIKE 'access_key.%' ORDER BY rowid
      `;
      assert.deepEqual(
        audits.map((row) => [row.action, row.actor, row.space]),
        [
          ["access_key.create", admin, setup.acmeId],
          ["access_key.create", olga, setup.acmeId],
          ["access_key.revoke", olga, setup.acmeId],
          ["access_key.create", member, personalOf(member)],
          ["access_key.revoke", setup.ownerId, personalOf(member)],
          ["access_key.create", setup.ownerId, setup.acmeId],
        ],
      );
      assert.isNotNull(second.created.keyId);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key needs a label and a validity of 1 to 366 days; a Space holds at most 50 live keys",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const asAda = CommandActor.actAs(setup.people.admin);
      const create = (label: string, validity: { days: number } | { until: string }) =>
        setup.accessKeys
          .createForSession({
            spaceId: setup.acmeId,
            label,
            validity,
            models: ALL,
            unlimited: true,
          })
          .pipe(asAda);
      const now = yield* Clock.currentTimeMillis;
      const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
      for (const [label, validity] of [
        ["   ", WEEK],
        ["x".repeat(81), WEEK],
        ["Zero", { days: 0 }],
        ["Too long", { days: 367 }],
        ["Past", { until: iso(now - 60_000) }],
        ["Far", { until: iso(now + 367 * 86_400_000) }],
        ["Not a date", { until: "someday" }],
      ] as const) {
        const refused = yield* create(label, validity).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid", label);
      }
      const until = iso(now + 30 * 86_400_000);
      const dated = yield* create("Dated", { until });
      assert.equal(dated.created.expiresAt, until);

      // 50 live keys; the 51st is refused until one is revoked or long expired.
      const made = [dated];
      for (let index = 1; index < 50; index += 1) {
        made.push(yield* create(`Key ${index}`, WEEK));
      }
      const full = yield* create("One more", WEEK).pipe(Effect.flip);
      assert.equal(full.reason, "limit");
      assert.equal(full.message, "This Space has 50 access keys. Revoke one to make another.");
      yield* setup.accessKeys.revokeForSession({ keyId: made[0]!.created.keyId }).pipe(asAda);
      yield* create("Room again", WEEK);
      assert.equal((yield* create("Full again", WEEK).pipe(Effect.flip)).reason, "limit");
      // Expired more than 30 days ago: no longer live.
      const longAgo = iso(now - 31 * 86_400_000);
      yield* setup.server.sql`
        UPDATE ai_access_keys SET expires_at = ${longAgo} WHERE key_id = ${made[1]!.created.keyId}
      `;
      yield* create("After an old one", WEEK);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key is kept only as its hash and never reaches the usage, the audit log, logs or spans; only `create` answers with it",
  () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map((part) => {
            try {
              return JSON.stringify(part) ?? String(part);
            } catch {
              return String(part);
            }
          })
          .join(" "),
      );
    });
    return Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* adaKey(setup);
      const key = made.value;
      const secret = key.slice(5);
      // The one answer that carries it is `create`'s, Redacted.
      assert.isTrue(Redacted.isRedacted(made.key));
      assert.isFalse(JSON.stringify(made.created).includes(secret), "the listed key holds it");
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 200);
      yield* setup.settled(1);
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      const revoked = yield* setup.accessKeys
        .revokeForSession({ keyId: made.created.keyId })
        .pipe(CommandActor.actAs(setup.people.admin));

      const stored = {
        keys: yield* setup.server.sql.unsafe(`SELECT * FROM ai_access_keys`),
        usage: yield* setup.server.sql.unsafe(`SELECT * FROM ai_usage`),
        daily: yield* setup.server.sql.unsafe(`SELECT * FROM ai_usage_daily`),
        audit: yield* setup.server.sql.unsafe(`SELECT * FROM audit_log`),
      };
      for (const [where, rows] of Object.entries(stored)) {
        assert.isFalse(JSON.stringify(rows).includes(secret), `the key is in ${where}`);
      }
      assert.include(
        JSON.stringify(stored.keys),
        NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex"),
      );
      // The audit names the key by id and label, never its hash or hint.
      const audit = yield* setup.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'access_key.create'
      `;
      assert.deepEqual(Object.keys(JSON.parse(audit[0]!.detail)).toSorted(), [
        "accounts",
        "expiresAt",
        "limits",
        "models",
        "space",
        "subscription",
      ]);
      for (const answer of [listed, revoked]) {
        assert.isFalse(JSON.stringify(answer).includes(secret), "an answer holds the key");
      }
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ].join("\n");
      assert.include(recorded, "AI gateway request");
      const leaks = recorded
        .split("\n")
        .filter((line) => line.includes(secret))
        .map((line) => line.replaceAll(secret, "<KEY>").slice(0, 600));
      assert.deepEqual(leaks, [], "the key was logged or traced");
      assert.notInclude(recorded, PROMPT);
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);
