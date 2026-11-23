// @effect-diagnostics globalJsonInEffect:off - reads the audit's JSON detail.
/**
 * Access-keys ticket 02: the models an access key may use, checked before any account is chosen,
 * listed by `/v1/models` in every shape, and offered to the form; on a real port over the fake
 * CLIProxyAPI with Acme's own accounts.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  call,
  type Hub,
  hub,
  messages,
  platform,
  posix,
  upstreamModels,
} from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const CHAT = "/api/ai/openai/v1/chat/completions";
const geminiPath = (model: string) => `/api/ai/gemini/v1beta/models/${model}:generateContent`;
const WEEK = { days: 7 } as const;

/** Acme's own Claude (Sonnet) and an OpenAI-compatible account that serves Opus, added by Ada. */
const acmeModels = Effect.fn(function* (setup: Hub) {
  const owner = { kind: "organization", spaceId: setup.acmeId } as const;
  const asAda = CommandActor.actAs(setup.people.admin);
  const claude = (yield* setup.accounts
    .create({
      name: "Acme Claude",
      provider: "claude",
      apiKey: Redacted.make("sk-acme-models-claude-0123456789abcdef"),
      owner,
    })
    .pipe(asAda)).id;
  const router = (yield* setup.accounts
    .create({
      name: "Acme Router",
      provider: "openai-compatible",
      apiKey: Redacted.make("sk-acme-models-router-0123456789abcdef"),
      baseUrl: "https://openrouter.example/api/v1",
      models: ["claude-opus-5-5", "deepseek-chat"],
      owner,
    })
    .pipe(asAda)).id;
  return { claude, router };
});

const keyWith = (setup: Hub, models: ReadonlyArray<string>) =>
  setup.accessKeys
    .createForSession({ spaceId: setup.acmeId, label: "Partner", validity: WEEK, models })
    .pipe(CommandActor.actAs(setup.people.admin));

it.live.skipIf(!posix || platform === undefined)(
  "`claude-sonnet-*` lets Sonnet through and refuses Opus in every shape, pinned too, before any account; `/v1/models` lists no Opus",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeModels(setup);
      const made = yield* keyWith(setup, ["claude-sonnet-*"]);
      assert.deepEqual(made.created.models, ["claude-sonnet-*"]);
      const key = Redacted.value(made.key);

      const sonnet = yield* call(setup, MESSAGES, { key, body: messages() });
      assert.equal(sonnet.status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${ids.claude}/claude-sonnet-5-5`);

      // Opus is served (by the router), yet the key may not use it: nothing goes upstream.
      const before = setup.upstream().length;
      const opusMessages = yield* call(setup, MESSAGES, {
        key,
        body: messages("claude-opus-5-5"),
      });
      assert.equal(opusMessages.status, 403);
      assert.deepEqual(opusMessages.json, {
        type: "error",
        error: {
          type: "permission_error",
          message: "This access key may not use claude-opus-5-5. It may use: claude-sonnet-5-5.",
        },
      });
      const opusChat = yield* call(setup, CHAT, {
        key,
        body: { model: "claude-opus-5-5", messages: [] },
      });
      assert.equal(opusChat.status, 403);
      const chatError = opusChat.json!.error as Record<string, unknown>;
      assert.equal(chatError.code, "model_not_allowed");
      assert.equal(chatError.type, "permission_error");
      const opusGemini = yield* call(setup, geminiPath("claude-opus-5-5"), {
        key,
        keyHeader: "x-goog-api-key",
        body: { contents: [] },
      });
      assert.equal(opusGemini.status, 403);
      assert.equal((opusGemini.json!.error as Record<string, unknown>).status, "PERMISSION_DENIED");
      const pinned = yield* call(setup, CHAT, {
        key,
        body: { model: `acct-${ids.router}/claude-opus-5-5`, messages: [] },
      });
      assert.equal(pinned.status, 403);
      assert.equal((pinned.json!.error as Record<string, unknown>).code, "model_not_allowed");
      // Dated versions follow the pattern; a `[1m]` suffix is not compared.
      const dated = yield* call(setup, MESSAGES, {
        key,
        body: messages("claude-opus-5-5[1m]"),
      });
      assert.equal(dated.status, 403);
      assert.equal(setup.upstream().length, before, "a refused model reached an account");

      // Allowed but served by no account: today's 404.
      const unserved = yield* call(setup, MESSAGES, { key, body: messages("claude-sonnet-9") });
      assert.equal(unserved.status, 404);

      // Model lists: what the key may use and its accounts serve, never Opus.
      for (const [path, header] of [
        ["/api/ai/openai/v1/models", "authorization"],
        ["/api/ai/anthropic/v1/models", "x-api-key"],
        ["/api/ai/gemini/v1beta/models", "x-goog-api-key"],
      ] as const) {
        const listed = yield* call(setup, path, { key, keyHeader: header });
        assert.equal(listed.status, 200, path);
        assert.include(listed.text, "claude-sonnet-5-5", path);
        assert.notInclude(listed.text, "claude-opus-5-5", path);
        assert.notInclude(listed.text, "deepseek-chat", path);
        assert.notInclude(listed.text, "claude-sonnet-*", path);
      }
      // «All models» lists Opus: the router serves it.
      const all = yield* keyWith(setup, ["*"]);
      const everything = yield* call(setup, "/api/ai/openai/v1/models", {
        key: Redacted.value(all.key),
      });
      assert.include(everything.text, "claude-opus-5-5");
      assert.include(everything.text, "deepseek-chat");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key's models are 1 to 50 entries with a single final `*`; «All models» is `*`; the form's options are the Space managers'",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeModels(setup);
      for (const models of [[], ["claude-*-5"], ["claude**"], ["a b"], ["x".repeat(257)]]) {
        const refused = yield* keyWith(setup, models).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid", JSON.stringify(models));
      }
      const tooMany = yield* keyWith(
        setup,
        Array.from({ length: 51 }, (_, index) => `model-${index}`),
      ).pipe(Effect.flip);
      assert.equal(tooMany.reason, "invalid");
      assert.deepEqual((yield* keyWith(setup, ["claude-sonnet-*", "*"])).created.models, ["*"]);
      assert.deepEqual(
        (yield* keyWith(setup, ["GPT-5.5", "gpt-5.5", " claude-sonnet-* "])).created.models,
        ["GPT-5.5", "claude-sonnet-*"],
      );
      const details = yield* setup.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'access_key.create'
        ORDER BY rowid
      `;
      assert.deepEqual(
        details.map((row) => (JSON.parse(row.detail) as { models: unknown }).models),
        ["all", 2],
      );

      // The form's options: Acme's own gateway accounts and their models, for Ada; not Grace.
      const options = yield* setup.accessKeys
        .modelOptionsForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.deepEqual(
        options.accounts.map((account) => [
          account.id,
          account.type,
          [...account.models].toSorted(),
        ]),
        [
          [ids.claude, "api-key", ["claude-sonnet-5-5"]],
          [ids.router, "api-key", ["claude-opus-5-5", "deepseek-chat"]],
        ],
      );
      for (const outsider of [setup.people.member, setup.people.globexMember]) {
        const refused = yield* setup.accessKeys
          .modelOptionsForSession({ spaceId: setup.acmeId })
          .pipe(CommandActor.actAs(outsider), Effect.flip);
        assert.equal(refused.reason, "forbidden");
      }
      const agent = yield* setup.accessKeys
        .modelOptionsForSession({ spaceId: setup.acmeId })
        .pipe(
          CommandActor.actAsResolved({ _tag: "User", userId: setup.people.admin, via: "agent" }),
          Effect.flip,
        );
      assert.equal(agent.reason, "forbidden");
    }).pipe(Effect.scoped),
);
