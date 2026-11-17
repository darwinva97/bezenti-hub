/**
 * The AI gateway layer (spec 4 ticket 04) on a real port over the fake CLIProxyAPI, with Ada
 * (Admin), Grace (Member) and Linus (Guest) of Acme and Gus of Globex: a key reaches only what
 * AllowedAiAccounts gives its User in its Space now, streamed, failing over within one provider.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port: streams, raw paths, the fake gateway's files.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeyRevocation from "./AiGatewayKeyRevocation.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";

import {
  acmeSetup,
  call,
  hub,
  hubWith,
  messages,
  platform,
  posix,
  PROMPT,
  PROVIDER_KEYS,
  rawCall,
  upstreamModels,
  type Hub,
} from "./AiGatewayRoute.testkit.ts";

it.live.skipIf(!posix || platform === undefined)(
  "a Thread key reaches its allowed accounts in every shape, streamed, and the Thread shows the account in use",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
      const changes = yield* (yield* setup.activity.subscribeAccountsInUse).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const records = yield* (yield* setup.activity.subscribeRequests).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      // Claude messages, streamed: the first event arrives while the upstream still holds the rest.
      setup.flag("fake-stream-hold");
      const streamed = yield* Effect.promise(async () => {
        const response = await fetch(
          `http://127.0.0.1:${setup.port}/api/ai/anthropic/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": key,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-forwarded-for": "6.6.6.6",
              "x-amp-provider": "globex",
              "x-cpa-account": "globex",
              cookie: setup.ownerCookie,
            },
            body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
          },
        );
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const first = decoder.decode((await reader.read()).value);
        setup.flag("fake-stream-release");
        let rest = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += decoder.decode(chunk.value);
        }
        return { response, first, rest };
      });
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.equal(streamed.response.status, 200);
      assert.match(streamed.response.headers.get("content-type") ?? "", /text\/event-stream/u);
      assert.include(streamed.first, "message_start");
      assert.notInclude(streamed.first, "content_block_delta", "the answer was held back whole");
      assert.include(streamed.rest, "Hello from claude-sonnet-5-5");
      assert.notInclude(
        streamed.first + streamed.rest,
        "acct-",
        "the account prefix reached the client",
      );
      // Only known headers cross, in both directions.
      for (const name of ["x-fake-account", "set-cookie", "x-cpa-version"]) {
        assert.isNull(streamed.response.headers.get(name), `${name} reached the client`);
      }
      const sent = setup.upstream().at(-1)!;
      assert.equal(sent.model, `acct-${ids.claudeA}/claude-sonnet-5-5`);
      assert.isTrue(sent.authOk);
      assert.deepEqual(
        sent.headerNames.filter((name) => name.startsWith("x-") || name === "cookie"),
        [],
      );
      assert.include(sent.headerNames, "anthropic-version");
      for (const smuggled of [
        "x-forwarded-for",
        "x-amp-provider",
        "x-cpa-account",
        "cookie",
        "x-api-key",
      ]) {
        assert.notInclude(sent.headerNames, smuggled);
      }
      const inUse = Option.getOrThrow(yield* setup.activity.inUse(threadId));
      assert.equal(inUse.accountId, ids.claudeA);
      const changed = [...(yield* Fiber.join(changes))];
      assert.deepEqual(changed[0], {
        threadId,
        accountId: ids.claudeA,
        model: "claude-sonnet-5-5",
        provider: "claude",
      });
      const [record] = [...(yield* Fiber.join(records))];
      assert.equal(record!.accountId, ids.claudeA);
      assert.equal(record!.threadId, threadId);
      assert.equal(record!.userId, setup.people.member);
      assert.equal(record!.spaceId, setup.acmeId);
      assert.deepEqual(record!.usage, {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });

      // count_tokens, OpenAI chat and responses, Gemini (stream and not), each pinned upstream.
      const counted = yield* call(setup, "/api/ai/anthropic/v1/messages/count_tokens", {
        key,
        body: messages(),
      });
      assert.equal(counted.status, 200);
      assert.deepEqual(counted.json, { input_tokens: 11 });
      const chat = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "deepseek-chat", messages: [{ role: "user", content: PROMPT }] },
      });
      assert.equal(chat.status, 200);
      assert.include(chat.text, "Hello from deepseek-chat");
      assert.notInclude(chat.text, "acct-");
      const chatStream = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: {
          model: "deepseek-chat",
          stream: true,
          messages: [{ role: "user", content: PROMPT }],
        },
      });
      assert.include(chatStream.text, "data: [DONE]");
      const responses = yield* call(setup, "/api/ai/openai/v1/responses", {
        key,
        body: { model: "deepseek-chat", input: PROMPT },
      });
      assert.equal(responses.status, 200);
      // «Grace Gemini», lent to Acme, works in Acme.
      const gemini = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
        { key, keyHeader: "x-goog-api-key", body: { contents: [{ parts: [{ text: PROMPT }] }] } },
      );
      assert.equal(gemini.status, 200);
      assert.include(gemini.text, "Hello from gemini-3-pro");
      assert.deepEqual(upstreamModels(setup).slice(-5), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.graceGemini}/gemini-3-pro`,
      ]);
      assert.equal(setup.upstream().at(-1)!.search, "?alt=sse");

      // Model lists: plain names of what is allowed here, in each shape; never Globex's.
      for (const [path, header] of [
        ["/api/ai/openai/v1/models", "authorization"],
        ["/api/ai/anthropic/v1/models", "x-api-key"],
        ["/api/ai/gemini/v1beta/models", "x-goog-api-key"],
      ] as const) {
        const listed = yield* call(setup, path, { key, keyHeader: header });
        assert.equal(listed.status, 200, path);
        assert.include(listed.text, "deepseek-chat");
        assert.include(listed.text, "gemini-3-pro");
        assert.notInclude(listed.text, "globex-secret-model");
        assert.notInclude(listed.text, "acct-");
      }

      // A User key (Grace's local CLI, for Acme) routes the same way, by priority.
      const cli = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop",
      });
      const byCli = yield* call(setup, "/api/ai/anthropic/v1/messages", {
        key: Redacted.value(cli.key),
        body: messages(),
      });
      assert.equal(byCli.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeA}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "refuses what no key allows: no key, a session cookie, a foreign or unprefixed account, admin paths",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
      const before = setup.upstream().length;
      const path = "/api/ai/anthropic/v1/messages";

      // No key: a valid session cookie, an Environment-style credential, junk, a key in the query.
      const refusedAuth = [
        yield* call(setup, path, { body: messages(), headers: { cookie: setup.cookies.grace! } }),
        yield* call(setup, path, { body: messages(), headers: { cookie: setup.ownerCookie } }),
        yield* call(setup, path, { key: "t3env_0123456789abcdef", body: messages() }),
        yield* call(setup, path, {
          key: `t3gk_${NodeCrypto.randomBytes(32).toString("base64url")}`,
          body: messages(),
        }),
        yield* call(setup, `${path}?key=${key}`, { body: messages() }),
        yield* call(setup, path, {
          body: messages(),
          headers: { authorization: `Basic ${Buffer.from(`x:${key}`).toString("base64")}` },
        }),
        // Two different keys: never chosen between.
        yield* call(setup, path, {
          key,
          body: messages(),
          headers: { "x-api-key": `t3gk_${NodeCrypto.randomBytes(32).toString("base64url")}` },
        }),
      ];
      assert.deepEqual(
        refusedAuth.map((answer) => answer.status),
        [401, 401, 401, 401, 401, 401, 401],
      );
      // In the client's own shape.
      assert.equal((refusedAuth[0]!.json as { type?: string }).type, "error");

      // Another account by prefix: Globex's, nonexistent, double, or a model no allowed one serves.
      const foreign = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.globexClaude}/claude-sonnet-5-5`),
      });
      assert.equal(foreign.status, 403);
      const double = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.claudeA}/acct-${ids.globexClaude}/claude-sonnet-5-5`),
      });
      assert.equal(double.status, 400);
      const bare = yield* call(setup, path, { key, body: messages("acct-/claude-sonnet-5-5") });
      assert.equal(bare.status, 400);
      const unserved = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "globex-secret-model", messages: [] },
      });
      assert.equal(unserved.status, 404);
      const nonsense = yield* call(setup, path, { key, rawBody: "[1,2]" });
      assert.equal(nonsense.status, 400);
      assert.equal(setup.upstream().length, before, "a refused request reached CLIProxyAPI");

      // A Thread key never moves its Thread to another allowed account by naming it (a prompt
      // could ask the agent to); a User key (a local CLI) may pin any allowed account.
      const threadPin = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.claudeB}/claude-sonnet-5-5`),
      });
      assert.equal(threadPin.status, 403);
      assert.equal(setup.upstream().length, before, "a Thread key's pin reached CLIProxyAPI");
      const cliKey = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Grace laptop",
      });
      const pinned = yield* call(setup, path, {
        key: Redacted.value(cliKey.key),
        body: messages(`acct-${ids.claudeB}/claude-sonnet-5-5`),
      });
      assert.equal(pinned.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeB}/claude-sonnet-5-5`);

      // CLIProxyAPI's management API and other paths are never reached through /api/ai.
      const tricks = [
        "/api/ai/v8/management/config",
        "/api/ai/openai/v8/management/config",
        "/api/ai/openai/v1/../../../v8/management/config",
        "/api/ai/openai/v1/chat/completions/../../../../v8/management/config",
        "/api/ai/openai/v0/management/config",
        "/api/ai/openai/v1/chat/completions%2F..%2F..%2Fv8%2Fmanagement",
        `/api/ai/gemini/v1beta/models/acct-${ids.globexClaude}%2Fgemini-3-pro:generateContent`,
        "/api/ai/gemini/v1beta/models/..%2F..%2Fv8%2Fmanagement%2Fconfig:generateContent",
        "/api/ai/anthropic/v1/messages/batches",
        "/api/ai/openai/v1/models/gpt-5.5",
        "/api/ai/openai/v1/embeddings",
      ];
      for (const trick of tricks) {
        const answer = yield* rawCall(setup, trick, key);
        assert.include([404, 405], answer.status, trick);
      }
      const listedAsPost = yield* call(setup, "/api/ai/openai/v1/models", { key, body: {} });
      assert.equal(listedAsPost.status, 405);
      assert.equal(setup.unknownUpstream(), "", "a trick reached CLIProxyAPI");
      assert.equal(setup.upstream().length, before + 1);

      // Each person reaches only their Space's accounts: Gus (Globex) with a Globex key.
      const gusKey = yield* setup.keys.createForUser({
        actorUserId: setup.people.globexMember,
        spaceId: setup.globexId,
        name: "Gus laptop",
      });
      const gusOwn = yield* call(setup, path, {
        key: Redacted.value(gusKey.key),
        body: messages(),
      });
      assert.equal(gusOwn.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.globexClaude}/claude-sonnet-5-5`);
      const gusAcme = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key: Redacted.value(gusKey.key),
        body: { model: `acct-${ids.router}/deepseek-chat`, messages: [] },
      });
      assert.equal(gusAcme.status, 403);
      // Nobody makes a key for a Space they do not work in; Linus (Guest) may for Acme.
      const gusForAcme = yield* Effect.flip(
        setup.keys.createForUser({
          actorUserId: setup.people.globexMember,
          spaceId: setup.acmeId,
          name: "Sneaky",
        }),
      );
      assert.equal(gusForAcme.reason, "forbidden");
      const linusKey = yield* setup.keys.createForUser({
        actorUserId: setup.people.guest,
        spaceId: setup.acmeId,
        name: "Linus",
      });
      const linus = yield* call(setup, path, {
        key: Redacted.value(linusKey.key),
        body: messages(),
      });
      assert.equal(linus.status, 200);
      // «Grace Gemini» is lent to Acme (an allowance to one User became a loan to a Space, Grants
      // ticket 02): Linus, who works there, uses it as well.
      const linusGemini = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:generateContent",
        { key: Redacted.value(linusKey.key), keyHeader: "x-goog-api-key", body: { contents: [] } },
      );
      assert.equal(linusGemini.status, 200);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key stops at the next request once its loan, membership, Space, Thread, account or User is gone",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const path = "/api/ai/openai/v1/chat/completions";
      const ask = (key: string) =>
        call(setup, path, { key, body: { model: "deepseek-chat", messages: [] } }).pipe(
          Effect.map((answer) => answer.status),
        );

      // The loan taken back mid-Thread: the next request fails; lent again, it works again.
      const first = yield* setup.thread(setup.people.member, setup.acmeId);
      assert.equal(yield* ask(first.key), 200);
      yield* setup.lendTo(ids.router, []);
      assert.equal(yield* ask(first.key), 404);
      yield* setup.lendTo(ids.router, [setup.acmeId]);
      assert.equal(yield* ask(first.key), 200);

      // Disabled, then deleted.
      yield* setup.accounts.update({ accountId: ids.router, disabled: true }).pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 404);
      yield* setup.accounts.update({ accountId: ids.router, disabled: false }).pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 200);

      // A Thread pinned to an account that is no longer allowed says so, and never falls back.
      const pinnedThread = yield* setup.thread(setup.people.member, setup.acmeId, ids.claudeB);
      const pinnedAsk = () =>
        call(setup, "/api/ai/anthropic/v1/messages", { key: pinnedThread.key, body: messages() });
      assert.equal((yield* pinnedAsk()).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeB}/claude-sonnet-5-5`);
      yield* setup.lendTo(ids.claudeB, [setup.globexId]);
      const notAllowed = yield* pinnedAsk();
      assert.equal(notAllowed.status, 403);
      assert.include(notAllowed.text, "Switch AI account");

      // The Thread's Project moved to Globex: its key is for Acme, so it stops.
      const moved = yield* setup.thread(setup.people.member, setup.acmeId);
      assert.equal(yield* ask(moved.key), 200);
      yield* setup.server.sql`
        UPDATE projection_projects SET space_id = ${setup.globexId} WHERE project_id = ${moved.projectId}
      `;
      assert.equal(yield* ask(moved.key), 403);

      // Archived, deleted.
      const archived = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-02T00:00:00.000Z'
        WHERE thread_id = ${archived.threadId}
      `;
      assert.equal(yield* ask(archived.key), 401);
      const deleted = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-02T00:00:00.000Z'
        WHERE thread_id = ${deleted.threadId}
      `;
      assert.equal(yield* ask(deleted.key), 401);

      // Another owner of the Thread now (a transfer): the old owner's key stops.
      const transferred = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET owner_user_id = ${setup.people.admin}
        WHERE thread_id = ${transferred.threadId}
      `;
      assert.equal(yield* ask(transferred.key), 403);

      // Expired; rotated by the next session's key; a User key revoked (only by its User or the
      // Owner, audited).
      const expiring = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE ai_gateway_keys SET expires_at = '2026-01-01T00:00:00.000Z'
        WHERE thread_id = ${expiring.threadId}
      `;
      assert.equal(yield* ask(expiring.key), 401);
      const rotated = yield* setup.thread(setup.people.member, setup.acmeId);
      const next = yield* setup.keys.issueForThread(rotated.threadId);
      assert.equal(yield* ask(rotated.key), 401);
      assert.equal(yield* ask(Redacted.value(next.key)), 200);
      const cli = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop",
      });
      assert.equal(yield* ask(Redacted.value(cli.key)), 200);
      const byOther = yield* Effect.flip(
        setup.keys.revoke({ actorUserId: setup.people.admin, keyId: cli.keyId }),
      );
      assert.equal(byOther.reason, "not-found");
      assert.equal(yield* ask(Redacted.value(cli.key)), 200);
      assert.deepEqual(
        (yield* setup.keys.listUserKeys(setup.people.member)).map((listed) => listed.name),
        ["Laptop"],
      );
      assert.lengthOf(yield* setup.keys.listUserKeys(setup.people.admin), 0);
      yield* setup.keys.revoke({ actorUserId: setup.people.member, keyId: cli.keyId });
      assert.equal(yield* ask(Redacted.value(cli.key)), 401);
      const audits = yield* setup.server.sql<{ readonly action: string; readonly detail: string }>`
        SELECT action, detail_json AS detail FROM audit_log WHERE action LIKE 'ai_gateway_key.%'
      `;
      assert.deepEqual(
        audits.map((row) => row.action),
        ["ai_gateway_key.create", "ai_gateway_key.revoke"],
      );

      // Grace removed from Acme: her live Thread key and CLI key stop.
      const beforeRemoval = yield* setup.thread(setup.people.member, setup.acmeId);
      const cli2 = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop 2",
      });
      assert.equal(yield* ask(beforeRemoval.key), 200);
      yield* setup.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${setup.acmeId} AND user_id = ${setup.people.member}
      `;
      yield* setup.directory.membershipsChanged([setup.people.member]);
      assert.equal(yield* ask(beforeRemoval.key), 403);
      assert.equal(yield* ask(Redacted.value(cli2.key)), 403);

      // Ada's Thread, then Ada removed from the Installation: her key is dead.
      const adas = yield* setup.thread(setup.people.admin, setup.acmeId);
      assert.equal(yield* ask(adas.key), 200);
      yield* setup.server.sql`
        UPDATE users SET removed_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ${setup.people.admin}
      `;
      assert.equal(yield* ask(adas.key), 401);

      // The router deleted: Linus's key (Acme) no longer reaches it.
      const linus = yield* setup.thread(setup.people.guest, setup.acmeId);
      assert.equal(yield* ask(linus.key), 200);
      yield* setup.accounts.remove({ accountId: ids.router }).pipe(setup.asOwner);
      const sentBefore = setup.upstream().length;
      assert.equal(yield* ask(linus.key), 404);
      assert.equal(setup.upstream().length, sentBefore, "a request after the delete was sent");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "fails over on quota only to an allowed account of the same provider, and says so when none is left",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      // Another provider serving the same model name, allowed to Acme: never a failover target.
      const proxy = yield* setup.account(
        "Acme Claude via proxy",
        "openai-compatible",
        { spaceIds: [setup.acmeId] },
        { baseUrl: "https://proxy.example/v1", models: ["claude-sonnet-5-5"] },
      );
      const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
      const ask = () => call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });
      assert.equal((yield* ask()).status, 200);
      assert.equal(Option.getOrThrow(yield* setup.activity.inUse(threadId)).accountId, ids.claudeA);

      // A out of quota: B (same provider, allowed) answers, and the Thread shows B.
      const changes = yield* (yield* setup.activity.subscribeAccountsInUse).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      setup.flag(`fake-quota-${ids.claudeA}`);
      const failedOver = yield* ask();
      assert.equal(failedOver.status, 200);
      assert.deepEqual(upstreamModels(setup).slice(-2), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.claudeB}/claude-sonnet-5-5`,
      ]);
      assert.equal(Option.getOrThrow(yield* setup.activity.inUse(threadId)).accountId, ids.claudeB);
      assert.equal([...(yield* Fiber.join(changes))][0]!.accountId, ids.claudeB);

      // B out too: Globex's Claude has quota but is not allowed here; the proxy is another provider.
      setup.flag(`fake-quota-${ids.claudeB}`);
      const count = setup.upstream().length;
      const none = yield* ask();
      assert.equal(none.status, 429);
      assert.include(
        none.text,
        "No allowed AI account for claude has quota left; switch AI account",
      );
      assert.deepEqual(upstreamModels(setup).slice(count), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.claudeB}/claude-sonnet-5-5`,
      ]);
      assert.notInclude(upstreamModels(setup), `acct-${proxy}/claude-sonnet-5-5`);
      assert.notInclude(upstreamModels(setup), `acct-${ids.globexClaude}/claude-sonnet-5-5`);
      assert.notInclude(none.text, "owner@example.com");
      assert.notInclude(none.text, "sk-ant");
      // The same in the OpenAI shape for an openai-compatible account with no peer.
      setup.flag(`fake-quota-${ids.router}`);
      const routerNone = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "deepseek-chat", messages: [] },
      });
      assert.equal(routerNone.status, 429);
      assert.equal((routerNone.json as { error: { type: string } }).error.type, "rate_limit_error");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "keeps keys, prompts and upstream words out of answers, logs and spans; limits size and load",
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
      const ids = yield* acmeSetup(setup);
      const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
      const path = "/api/ai/anthropic/v1/messages";

      // An upstream refusal quoting an email, a key and an address reaches the client filtered.
      setup.flag(`fake-error-${ids.claudeA}`);
      const refused = yield* call(setup, path, { key, body: messages() });
      assert.equal(refused.status, 400);
      for (const leak of [
        "owner@example.com",
        "sk-ant-leaky",
        "AIzaSy",
        "https://provider.test",
        "acct-",
      ]) {
        assert.notInclude(refused.text, leak);
      }
      assert.include(refused.text, "Bad request for [redacted]");
      setup.flag(`fake-error-${ids.claudeA}`, false);
      // So does an error event in the middle of a stream.
      setup.flag("fake-stream-error");
      const broken = yield* call(setup, path, {
        key,
        body: messages("claude-sonnet-5-5", { stream: true }),
      });
      setup.flag("fake-stream-error", false);
      assert.include(broken.text, "upstream failure for [redacted]");
      for (const leak of ["owner@example.com", "sk-ant-leaky", "acct-"]) {
        assert.notInclude(broken.text, leak);
      }

      // A body over the limit is refused before CLIProxyAPI sees it.
      const count = setup.upstream().length;
      const huge = yield* call(setup, path, {
        key,
        rawBody: JSON.stringify(messages("claude-sonnet-5-5", { pad: "x".repeat(300 * 1024) })),
      });
      assert.equal(huge.status, 413);
      const compressed = yield* call(setup, path, {
        key,
        body: messages(),
        headers: { "content-encoding": "gzip" },
      });
      assert.equal(compressed.status, 415);
      assert.equal(setup.upstream().length, count);

      // One key holds at most 16 requests at once; the 17th is told to wait.
      setup.flag("fake-stream-hold");
      const held = yield* Effect.forEach(
        Array.from({ length: 16 }),
        () =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${setup.port}${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
            }),
          ),
        { concurrency: "unbounded" },
      );
      const extra = yield* call(setup, path, { key, body: messages() });
      assert.equal(extra.status, 429);
      setup.flag("fake-stream-release");
      yield* Effect.forEach(
        held,
        (response) => Effect.promise(() => response.text().catch(() => "")),
        {
          concurrency: "unbounded",
        },
      );
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.equal((yield* call(setup, path, { key, body: messages() })).status, 200);

      // Nothing recorded carries a key (the gateway key, the Hub's client key, a provider key),
      // a prompt, or a header; the request itself is recorded by route, account and status.
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ].join("\n");
      assert.include(recorded, "AI gateway request");
      assert.include(recorded, "AI gateway request refused");
      assert.include(recorded, ids.claudeA);
      assert.include(recorded, "/api/ai/anthropic/v1/messages");
      for (const leak of [
        key,
        PROMPT,
        "t3gk_",
        ...PROVIDER_KEYS,
        "sk-test-",
        "owner@example.com",
      ]) {
        assert.notInclude(recorded, leak);
      }
      // The database keeps only the key's hash.
      const rows = yield* setup.server.sql.unsafe(`SELECT * FROM ai_gateway_keys`);
      assert.notInclude(JSON.stringify(rows), key);
      assert.include(
        JSON.stringify(rows),
        NodeCrypto.createHash("sha256").update(key).digest("hex"),
      );
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

/** Every request record from now on, one `take` per finished request. */
const recordsOf = (setup: Hub) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AiGatewayActivity.GatewayRequestRecord>();
    const stream = yield* setup.activity.subscribeRequests;
    yield* stream.pipe(
      Stream.runForEach((record) => Queue.offer(queue, record)),
      Effect.forkScoped,
    );
    return queue;
  });

/** A raw request whose answer is read by hand: `pauseMs` after the first chunk, then the rest. */
const slowReader = (setup: Hub, path: string, key: string, body: unknown, pauseMs: number) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly text: string; readonly ended: string }>(
        (resolve) => {
          let text = "";
          const request = NodeHttp.request(
            {
              host: "127.0.0.1",
              port: setup.port,
              method: "POST",
              path,
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            },
            (response) => {
              let paused = false;
              response.on("data", (chunk) => {
                text += String(chunk);
                if (!paused) {
                  paused = true;
                  response.pause();
                  setTimeout(() => response.resume(), pauseMs);
                }
              });
              response.on("end", () =>
                resolve({ status: response.statusCode ?? 0, text, ended: "end" }),
              );
              response.on("aborted", () =>
                resolve({ status: response.statusCode ?? 0, text, ended: "aborted" }),
              );
              response.on("error", () =>
                resolve({ status: response.statusCode ?? 0, text, ended: "error" }),
              );
            },
          );
          request.on("error", () => resolve({ status: 0, text, ended: "error" }));
          request.end(JSON.stringify(body));
        },
      ),
  );

/** A request whose body starts and never finishes, as a slowloris sends it. */
const slowBody = (setup: Hub, path: string, key: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly text: string }>((resolve) => {
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: setup.port,
            method: "POST",
            path,
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "content-length": "100000",
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () => {
              request.destroy();
              resolve({ status: response.statusCode ?? 0, text });
            });
          },
        );
        request.on("error", () => resolve({ status: 0, text: "" }));
        request.write('{"model":"claude-sonnet-5-5","messages":[');
      }),
  );

it.live.skipIf(!posix || platform === undefined)(
  "one User cannot block the gateway: User key cap, per-User slots, slow bodies and slow readers are cut",
  () =>
    Effect.gen(function* () {
      const setup = yield* hubWith({
        perKey: 2,
        perUser: 3,
        total: 4,
        readersPerUser: 1,
        bodyDeadlineMs: 1500,
        bodyIdleMs: 700,
        clientStallMs: 700,
        upstreamIdleMs: 1500,
        bufferedBytesTotal: 600 * 1024,
      });
      yield* acmeSetup(setup);
      const path = "/api/ai/anthropic/v1/messages";
      // At most five live User keys each.
      const graceKeys: Array<string> = [];
      for (let index = 0; index < 5; index += 1) {
        const made = yield* setup.keys.createForUser({
          actorUserId: setup.people.member,
          spaceId: setup.acmeId,
          name: `Laptop ${index}`,
        });
        graceKeys.push(Redacted.value(made.key));
      }
      const sixth = yield* Effect.flip(
        setup.keys.createForUser({
          actorUserId: setup.people.member,
          spaceId: setup.acmeId,
          name: "Laptop 6",
        }),
      );
      assert.equal(sixth.reason, "limit");
      const linus = Redacted.value(
        (yield* setup.keys.createForUser({
          actorUserId: setup.people.guest,
          spaceId: setup.acmeId,
          name: "Linus",
        })).key,
      );

      // Grace holds three answers across her keys (her share); a fourth of hers waits, Linus does not.
      setup.flag("fake-stream-hold");
      const held = yield* Effect.forEach(
        [graceKeys[0]!, graceKeys[0]!, graceKeys[1]!],
        (key) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${setup.port}${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
            }),
          ),
        // One body at a time: Grace may have only one being read (readersPerUser).
        { concurrency: 1 },
      );
      assert.deepEqual(
        held.map((response) => response.status),
        [200, 200, 200],
      );
      const graceFourth = yield* call(setup, path, { key: graceKeys[2]!, body: messages() });
      assert.equal(graceFourth.status, 429);
      const linusOne = yield* call(setup, path, { key: linus, body: messages() });
      assert.equal(linusOne.status, 200, "one User's requests blocked another User");
      setup.flag("fake-stream-release");
      yield* Effect.forEach(
        held,
        (response) => Effect.promise(() => response.text().catch(() => "")),
        {
          concurrency: "unbounded",
        },
      );
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);

      // A body that never finishes is cut (408) and leaves no slot behind.
      const before = setup.upstream().length;
      const slow = yield* slowBody(setup, path, graceKeys[3]!);
      assert.equal(slow.status, 408);
      assert.equal(setup.upstream().length, before);
      assert.equal(
        (yield* call(setup, path, { key: graceKeys[3]!, body: messages() })).status,
        200,
      );

      // A client that stops reading a long answer is cut, and its slot comes back.
      setup.flag("fake-stream-big");
      const stalled = yield* slowReader(
        setup,
        "/api/ai/openai/v1/chat/completions",
        graceKeys[4]!,
        { model: "deepseek-chat", stream: true, messages: [] },
        2500,
      );
      setup.flag("fake-stream-big", false);
      assert.equal(stalled.status, 200);
      assert.notInclude(
        stalled.text,
        "[DONE]",
        "a client that stopped reading got the whole answer",
      );
      // An upstream that goes quiet is cut too.
      setup.flag("fake-stream-hold");
      const quiet = yield* call(setup, path, {
        key: graceKeys[4]!,
        body: messages("claude-sonnet-5-5", { stream: true }),
      });
      setup.flag("fake-stream-hold", false);
      assert.notInclude(quiet.text, "message_stop");
      for (const key of graceKeys) {
        assert.equal((yield* call(setup, path, { key, body: messages() })).status, 200);
      }

      // The Hub holds at most so many request bytes at once: a body that would pass it is 503.
      const bulky = yield* call(setup, path, {
        key: graceKeys[0]!,
        rawBody: JSON.stringify(messages("claude-sonnet-5-5", { pad: "x".repeat(250 * 1024) })),
      });
      assert.equal(bulky.status, 503);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "counts tokens in every shape and never changes what the client asked for",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const records = yield* recordsOf(setup);
      const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
      const chat = "/api/ai/openai/v1/chat/completions";

      // An OpenAI stream without include_usage: the Hub asks for the tokens and hides that chunk.
      const plain = yield* call(setup, chat, {
        key,
        body: {
          model: "deepseek-chat",
          stream: true,
          messages: [{ role: "user", content: PROMPT }],
        },
      });
      assert.include(plain.text, "data: [DONE]");
      assert.notInclude(plain.text, '"usage"');
      assert.equal((yield* Queue.take(records)).usage?.outputTokens, 7);
      const asked = yield* call(setup, chat, {
        key,
        body: {
          model: "deepseek-chat",
          stream: true,
          stream_options: { include_usage: true },
          messages: [],
        },
      });
      assert.include(asked.text, '"usage"');
      assert.equal((yield* Queue.take(records)).usage?.inputTokens, 11);

      // Gemini's stream without alt=sse (a JSON array), whole and with an error element filtered.
      const array = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent",
        { key, keyHeader: "x-goog-api-key", body: { contents: [] } },
      );
      assert.equal(array.status, 200);
      assert.lengthOf(JSON.parse(array.text) as ReadonlyArray<unknown>, 2);
      assert.equal((yield* Queue.take(records)).usage?.outputTokens, 7);
      setup.flag("fake-stream-error");
      const arrayError = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent",
        { key, keyHeader: "x-goog-api-key", body: { contents: [] } },
      );
      setup.flag("fake-stream-error", false);
      yield* Queue.take(records);
      assert.lengthOf(JSON.parse(arrayError.text) as ReadonlyArray<unknown>, 3);
      for (const leak of ["owner@example.com", "sk-ant-leaky", "acct-"]) {
        assert.notInclude(arrayError.text, leak);
      }
      assert.include(arrayError.text, "upstream failure for [redacted]");

      // A plain answer over 1 MiB still counts its tokens.
      setup.flag("fake-big-json");
      const big = yield* call(setup, chat, { key, body: { model: "deepseek-chat", messages: [] } });
      setup.flag("fake-big-json", false);
      assert.equal(big.status, 200);
      assert.equal((yield* Queue.take(records)).usage?.outputTokens, 7);

      // An upstream 3xx is the gateway's failure, said without its words.
      setup.flag(`fake-redirect-${ids.router}`);
      const redirected = yield* call(setup, chat, {
        key,
        body: { model: "deepseek-chat", messages: [] },
      });
      setup.flag(`fake-redirect-${ids.router}`, false);
      yield* Queue.take(records);
      assert.equal(redirected.status, 502);
      assert.notInclude(redirected.text, "owner@example.com");

      // Counting tokens does not move the Thread's account in use.
      const counting = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* call(setup, "/api/ai/anthropic/v1/messages/count_tokens", {
        key: counting.key,
        body: messages(),
      });
      yield* Queue.take(records);
      assert.isTrue(Option.isNone(yield* setup.activity.inUse(counting.threadId)));
      assert.isTrue(Option.isSome(yield* setup.activity.inUse(threadId)));

      // A Thread whose own account is no longer allowed lists nothing else either.
      const pinned = yield* setup.thread(setup.people.member, setup.acmeId, ids.claudeB);
      yield* setup.lendTo(ids.claudeB, [setup.globexId]);
      const listed = yield* call(setup, "/api/ai/anthropic/v1/models", {
        key: pinned.key,
        keyHeader: "x-api-key",
      });
      assert.equal(listed.status, 403);
      assert.include(listed.text, "Switch AI account");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key is revoked when its session closes or detaches, its Thread is archived, deleted or moved, or its User leaves",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeSetup(setup);
      const ask = (key: string) =>
        call(setup, "/api/ai/openai/v1/chat/completions", {
          key,
          body: { model: "deepseek-chat", messages: [] },
        }).pipe(Effect.map((answer) => answer.status));
      const revoke = (change: Parameters<typeof AiGatewayKeyRevocation.revokeFor>[0]) =>
        AiGatewayKeyRevocation.revokeFor(change).pipe(
          Effect.provideService(AiGatewayKeys.AiGatewayKeys, setup.keys),
          Effect.provideService(AiGatewayActivity.AiGatewayActivity, setup.activity),
        );
      const reasonOf = (threadId: ThreadId) =>
        setup.server.sql<{ readonly reason: string | null }>`
          SELECT revoked_reason AS reason FROM ai_gateway_keys WHERE thread_id = ${threadId}
          ORDER BY rowid DESC LIMIT 1
        `.pipe(Effect.map((rows) => rows[0]?.reason ?? null));
      const event = (type: string, threadId: ThreadId, payload: unknown) =>
        ({ _tag: "event", event: { type, threadId, payload } }) as never;

      // The session the key was issued for stops: the key stops with it.
      const session = yield* setup.thread(setup.people.member, setup.acmeId);
      const sessionKey = Redacted.value(
        (yield* setup.keys.issueForThread(session.threadId, { providerSessionId: "ps-1" })).key,
      );
      assert.equal(yield* ask(sessionKey), 200);
      yield* revoke(
        event("provider-session.updated", session.threadId, { id: "ps-2", status: "stopped" }),
      );
      assert.equal(yield* ask(sessionKey), 200, "another session's end revoked the key");
      yield* revoke(
        event("provider-session.updated", session.threadId, { id: "ps-1", status: "running" }),
      );
      assert.equal(yield* ask(sessionKey), 200);
      yield* revoke(
        event("provider-session.updated", session.threadId, { id: "ps-1", status: "stopped" }),
      );
      assert.equal(yield* ask(sessionKey), 401);
      assert.equal(yield* reasonOf(session.threadId), "session-closed");
      // Detached from one Thread: that Thread's key only.
      const shared = yield* setup.thread(setup.people.member, setup.acmeId);
      const other = yield* setup.thread(setup.people.member, setup.acmeId);
      const sharedKey = Redacted.value(
        (yield* setup.keys.issueForThread(shared.threadId, { providerSessionId: "ps-shared" })).key,
      );
      const otherKey = Redacted.value(
        (yield* setup.keys.issueForThread(other.threadId, { providerSessionId: "ps-shared" })).key,
      );
      yield* revoke(
        event("provider-session.detached", shared.threadId, { providerSessionId: "ps-shared" }),
      );
      assert.equal(yield* ask(sharedKey), 401);
      assert.equal(yield* ask(otherKey), 200);

      // Archived, deleted (its account in use forgotten too).
      const archived = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* revoke(event("thread.archived", archived.threadId, {}));
      assert.equal(yield* reasonOf(archived.threadId), "thread-archived");
      assert.equal(yield* ask(archived.key), 401);
      const deleted = yield* setup.thread(setup.people.member, setup.acmeId);
      assert.equal(yield* ask(deleted.key), 200);
      assert.isTrue(Option.isSome(yield* setup.activity.inUse(deleted.threadId)));
      yield* revoke(event("thread.deleted", deleted.threadId, {}));
      assert.equal(yield* reasonOf(deleted.threadId), "thread-deleted");
      assert.isTrue(Option.isNone(yield* setup.activity.inUse(deleted.threadId)));

      // Moved to Globex: refused, and its row says so from then on.
      const moved = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE projection_projects SET space_id = ${setup.globexId} WHERE project_id = ${moved.projectId}
      `;
      assert.equal(yield* ask(moved.key), 403);
      assert.equal(yield* reasonOf(moved.threadId), "thread-moved");
      assert.equal(yield* ask(moved.key), 401);

      // The User disabled or removed: every key of theirs, Thread and User keys alike.
      const linusThread = yield* setup.thread(setup.people.guest, setup.acmeId);
      const linusCli = yield* setup.keys.createForUser({
        actorUserId: setup.people.guest,
        spaceId: setup.acmeId,
        name: "Linus",
      });
      yield* revoke({ _tag: "user", userId: setup.people.guest, active: false });
      const linusRows = yield* setup.server.sql<{ readonly reason: string | null }>`
        SELECT revoked_reason AS reason FROM ai_gateway_keys WHERE user_id = ${setup.people.guest}
      `;
      assert.deepEqual(
        linusRows.map((row) => row.reason),
        ["user-inactive", "user-inactive"],
      );
      assert.equal(yield* ask(linusThread.key), 401);
      assert.equal(yield* ask(Redacted.value(linusCli.key)), 401);
    }).pipe(Effect.scoped),
);
