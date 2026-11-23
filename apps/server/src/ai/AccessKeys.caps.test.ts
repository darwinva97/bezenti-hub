// @effect-diagnostics globalFetchInEffect:off globalJsonInEffect:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Access-keys ticket 05: an access key's token caps at the gateway, in every API shape, on a real
 * port over the fake CLIProxyAPI with Acme's own accounts. The next UTC day is reached by moving
 * the key's written days back (the period arithmetic itself runs on TestClock in
 * AccessKeyCaps.test.ts).
 */
import { assert, it } from "@effect/vitest";
import { ACCESS_KEY_NO_LIMITS, type AccessKeyLimits } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
  PROMPT,
} from "./AiGatewayRoute.testkit.ts";
import { periodOf } from "./GrantCaps.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const CHAT = "/api/ai/openai/v1/chat/completions";
const GEMINI = "/api/ai/gemini/v1beta/models/gemini-3-pro:generateContent";
const WEEK = { days: 7 } as const;

/** Acme's own Claude, OpenAI and Gemini API keys, added by Ada. */
const acmeOwn = Effect.fn(function* (setup: Hub) {
  for (const provider of ["claude", "codex", "gemini"] as const) {
    yield* setup.accounts
      .create({
        name: `Acme ${provider}`,
        provider,
        apiKey: Redacted.make(`sk-acme-caps-${provider}-0123456789abcdef`),
        owner: { kind: "organization", spaceId: setup.acmeId },
      })
      .pipe(CommandActor.actAs(setup.people.admin));
  }
});

const keyWith = (setup: Hub, limits: Partial<AccessKeyLimits>, label = "Partner") =>
  setup.accessKeys
    .createForSession({
      spaceId: setup.acmeId,
      label,
      validity: WEEK,
      models: ["*"],
      limits: { ...ACCESS_KEY_NO_LIMITS, ...limits },
    })
    .pipe(CommandActor.actAs(setup.people.admin));

/** The key's written days, one UTC day earlier: as if the next day had come. */
const nextDay = (setup: Hub, keyId: string) =>
  setup.server.sql`
    UPDATE ai_usage_daily SET day = date(day, '-1 day') WHERE access_key_id = ${keyId}
  `;

const ask = (setup: Hub, key: string) => call(setup, MESSAGES, { key, body: messages() });

/** A streamed answer held after its first event until `release`. */
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
  "a daily cap reached answers 429 in every shape with its reset, retry-after and no retry, and lets the next UTC day through",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* keyWith(setup, { day: 20 });
      assert.deepEqual(made.created.limits, { ...ACCESS_KEY_NO_LIMITS, day: 20 });
      const key = Redacted.value(made.key);
      // 18 tokens each (11 in, 7 out): the second is admitted below the cap and counts whole.
      assert.equal((yield* ask(setup, key)).status, 200);
      yield* setup.settled(1);
      assert.equal((yield* ask(setup, key)).status, 200);
      yield* setup.settled(2);

      const now = yield* Clock.currentTimeMillis;
      const resetsAt = periodOf("day", now).resetsAt;
      const message = `This access key reached its daily token limit (20); it resets ${resetsAt.slice(0, 10)} 00:00 UTC.`;
      const before = setup.upstream().length;
      for (const [path, header, body] of [
        [MESSAGES, "x-api-key", messages()],
        [
          CHAT,
          "authorization",
          { model: "gpt-5.5", messages: [{ role: "user", content: PROMPT }] },
        ],
        [GEMINI, "x-goog-api-key", { contents: [{ parts: [{ text: PROMPT }] }] }],
      ] as const) {
        const refused = yield* call(setup, path, { key, keyHeader: header, body });
        assert.equal(refused.status, 429, path);
        assert.include(refused.text, message, path);
        assert.equal(refused.headers.get("x-should-retry"), "false", path);
        const retryAfter = Number(refused.headers.get("retry-after"));
        assert.isTrue(retryAfter >= 1 && retryAfter <= 86_400, `${path}: ${retryAfter}`);
      }
      const chat = yield* call(setup, CHAT, { key, body: { model: "gpt-5.5", messages: [] } });
      assert.equal((chat.json!.error as Record<string, unknown>).code, "insufficient_quota");
      assert.equal(setup.upstream().length, before, "a request past the cap went upstream");

      // The next UTC day: through again.
      yield* nextDay(setup, made.created.keyId);
      assert.equal((yield* ask(setup, key)).status, 200);
      // The list says what is used of each cap.
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.equal(listed.keys[0]!.limits.day, 20);
      assert.isAtLeast(listed.keys[0]!.usage!.total, 36);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "the total cap answers 403 and does not come back the next day; with the total and the daily cap reached, the total speaks",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const total = yield* keyWith(setup, { total: 20, day: 1000 }, "Total");
      const key = Redacted.value(total.key);
      for (let index = 1; index <= 2; index += 1) {
        assert.equal((yield* ask(setup, key)).status, 200);
        yield* setup.settled(index);
      }
      const message =
        "This access key used its total token limit (20). Ask whoever gave it to you to raise it.";
      const refused = yield* ask(setup, key);
      assert.equal(refused.status, 403);
      assert.include(refused.text, message);
      assert.isNull(refused.headers.get("retry-after"));
      yield* nextDay(setup, total.created.keyId);
      assert.equal((yield* ask(setup, key)).status, 403);

      const both = yield* keyWith(setup, { total: 20, day: 20 }, "Both");
      const bothKey = Redacted.value(both.key);
      assert.equal((yield* ask(setup, bothKey)).status, 200);
      yield* setup.settled(4);
      assert.equal((yield* ask(setup, bothKey)).status, 200);
      yield* setup.settled(5);
      const first = yield* ask(setup, bothKey);
      assert.equal(first.status, 403);
      assert.include(first.text, "total token limit (20)");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "requests in flight when a cap is reached finish and count whole: the excess is only theirs",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeOwn(setup);
      const made = yield* keyWith(setup, { day: 20 });
      const key = Redacted.value(made.key);
      // Two at once below the cap: both are admitted, then both finish past it.
      setup.flag("fake-stream-hold");
      const held = yield* Effect.all([heldStream(setup, key), heldStream(setup, key)], {
        concurrency: "unbounded",
      });
      for (const one of held) assert.equal(one.status, 200);
      setup.flag("fake-stream-release");
      const rests = yield* Effect.all(
        held.map((one) => Effect.promise(one.rest)),
        { concurrency: "unbounded" },
      );
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      for (const rest of rests) assert.include(rest, "message_stop");
      yield* setup.settled(2);
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.equal(listed.keys[0]!.usage!.day, 36);
      assert.equal((yield* ask(setup, key)).status, 429);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key needs at least one cap or «No token limit» chosen explicitly, never both; the audit says the caps",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const asAda = CommandActor.actAs(setup.people.admin);
      const create = (extra: { readonly limits?: AccessKeyLimits; readonly unlimited?: boolean }) =>
        setup.accessKeys
          .createForSession({
            spaceId: setup.acmeId,
            label: "Caps",
            validity: WEEK,
            models: ["*"],
            ...extra,
          })
          .pipe(asAda);
      for (const extra of [
        {},
        { limits: ACCESS_KEY_NO_LIMITS },
        { limits: { ...ACCESS_KEY_NO_LIMITS, day: 10 }, unlimited: true },
        { limits: { ...ACCESS_KEY_NO_LIMITS, day: 0 } },
        { limits: { ...ACCESS_KEY_NO_LIMITS, day: 1.5 } },
        { limits: { ...ACCESS_KEY_NO_LIMITS, total: 2_000_000_000_000 } },
      ]) {
        const refused = yield* create(extra).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid", JSON.stringify(extra));
      }
      const capped = yield* create({
        limits: { ...ACCESS_KEY_NO_LIMITS, total: 1000, month: 500 },
      });
      assert.deepEqual(capped.created.limits, { total: 1000, day: null, week: null, month: 500 });
      const unlimited = yield* create({ unlimited: true });
      assert.deepEqual(unlimited.created.limits, ACCESS_KEY_NO_LIMITS);
      const details = yield* setup.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'access_key.create'
        ORDER BY rowid
      `;
      assert.deepEqual(
        details.map((row) => (JSON.parse(row.detail) as { limits: unknown }).limits),
        ["total=1000,day=-,week=-,month=500", "none"],
      );
    }).pipe(Effect.scoped),
);
