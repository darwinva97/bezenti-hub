/**
 * AI usage (spec 4 ticket 05) over the real gateway layer and the fake CLIProxyAPI: each request
 * counted once (failover, cut-off streams), tokens read in every shape, nothing stored but counts,
 * and who may read what: the Owner everything, an Admin their Organization, a Member only theirs.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off - a client on the real port, aborting a stream.
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import {
  type AiUsageSummary,
  type AiUsageSummaryInput,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  acmeSetup,
  call,
  hub,
  hubWith,
  messages,
  platform,
  posix,
  PROMPT,
} from "./AiGatewayRoute.testkit.ts";
import type { Hub } from "./AiGatewayRoute.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);

/** Waits until the usage log has taken in `count` requests (stored or lost). */
const stored = (setup: Hub, count: number) => setup.settled(count);

const summaryAs = (
  setup: Hub,
  userId: UserId,
  input: AiUsageSummaryInput = {},
  spaceLimit?: SpaceId,
) =>
  setup.usage
    .summary(input)
    .pipe(
      spaceLimit === undefined
        ? CommandActor.actAs(userId)
        : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit }),
    );

const requestsOf = (summary: AiUsageSummary, userId?: UserId) =>
  summary.rows
    .filter((row) => userId === undefined || row.userId === userId)
    .reduce((sum, row) => sum + row.requests, 0);

const usersIn = (summary: AiUsageSummary) =>
  [...new Set(summary.rows.map((row) => row.userId))].toSorted();

live("counts every request once with its tokens, in every shape, streamed or not", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const ids = yield* acmeSetup(setup);
    const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
    const post = (path: string, body: unknown) => call(setup, path, { key, body });
    const claude = "claude-sonnet-5-5";
    const answers = [
      yield* post("/api/ai/anthropic/v1/messages", messages(claude)),
      yield* post("/api/ai/anthropic/v1/messages", messages(claude, { stream: true })),
      yield* post("/api/ai/openai/v1/chat/completions", { model: "deepseek-chat", messages: [] }),
      // The client did not ask for the usage chunk: the Hub does, and still counts it.
      yield* post("/api/ai/openai/v1/chat/completions", {
        model: "deepseek-chat",
        messages: [],
        stream: true,
      }),
      yield* post("/api/ai/openai/v1/responses", { model: "deepseek-chat", input: "hi" }),
      yield* post("/api/ai/openai/v1/responses", {
        model: "deepseek-chat",
        input: "hi",
        stream: true,
      }),
      yield* post("/api/ai/gemini/v1beta/models/gemini-3-pro:generateContent", { contents: [] }),
      yield* post("/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse", {
        contents: [],
      }),
      yield* post("/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent", {
        contents: [],
      }),
    ];
    assert.deepEqual(
      answers.map((answer) => answer.status),
      answers.map(() => 200),
    );
    // Counting tokens is not using a model: not a request of the log.
    const counted = yield* post("/api/ai/anthropic/v1/messages/count_tokens", messages(claude));
    assert.equal(counted.status, 200);
    yield* stored(setup, answers.length);

    const rows = yield* setup.server.sql<{
      readonly model: string;
      readonly accountId: string;
      readonly threadId: string;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadTokens: number | null;
      readonly status: number;
    }>`SELECT model, account_id AS "accountId", thread_id AS "threadId",
        input_tokens AS "inputTokens", output_tokens AS "outputTokens",
        cache_read_tokens AS "cacheReadTokens", status FROM ai_usage ORDER BY at, usage_id`;
    assert.equal(rows.length, answers.length);
    for (const row of rows) {
      assert.equal(row.inputTokens, 11);
      assert.equal(row.outputTokens, 7);
      assert.equal(row.status, 200);
      assert.equal(row.threadId, threadId);
    }
    assert.equal(rows.filter((row) => row.cacheReadTokens === 3).length, 1);
    assert.deepEqual(
      new Set(rows.map((row) => row.accountId)),
      new Set([ids.claudeA, ids.router, ids.graceGemini]),
    );

    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.scope, "all");
    assert.equal(owner.totals.requests, answers.length);
    assert.equal(owner.totals.inputTokens, 11 * answers.length);
    assert.equal(owner.totals.outputTokens, 7 * answers.length);
    assert.equal(owner.totals.unknownRequests, 0);
    assert.equal(owner.totals.failedRequests, 0);
    // One line per (day, User, Space, account, model), the rows added together.
    assert.equal(owner.rows.length, 3);
    assert.equal(requestsOf(owner, setup.people.member), answers.length);
    assert.deepEqual(owner.labels.accounts.map((account) => account.name).toSorted(), [
      "Acme Claude A",
      "Acme OpenRouter",
      "Grace Gemini",
    ]);

    // Counts only: not a prompt, an answer, a key or a header.
    const everything = JSON.stringify([
      yield* setup.server.sql`SELECT * FROM ai_usage`,
      yield* setup.server.sql`SELECT * FROM ai_usage_daily`,
    ]);
    for (const secret of [PROMPT, "Hello from", "t3gk_", key, "sk-test-", "Bearer"]) {
      assert.notInclude(everything, secret);
    }
  }),
);

live("a request that failed over is one request, on the account that answered", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const ids = yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    const ask = () => call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });

    setup.flag(`fake-quota-${ids.claudeA}`);
    assert.equal((yield* ask()).status, 200);
    yield* stored(setup, 1);
    const failedOver = yield* setup.server.sql<{
      readonly accountId: string;
      readonly failovers: number;
    }>`SELECT account_id AS "accountId", failovers FROM ai_usage`;
    assert.deepEqual(failedOver, [{ accountId: ids.claudeB, failovers: 1 }]);

    // Every account out of quota: still one request, counted as failed.
    setup.flag(`fake-quota-${ids.claudeB}`);
    assert.equal((yield* ask()).status, 429);
    yield* stored(setup, 2);
    const rows = yield* setup.server.sql<{
      readonly status: number;
    }>`SELECT status FROM ai_usage ORDER BY at`;
    assert.deepEqual(
      rows.map((row) => row.status),
      [200, 429],
    );
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.requests, 2);
    assert.equal(owner.totals.failedRequests, 1);
    assert.equal(owner.totals.inputTokens, 11);
  }),
);

live("a stream the client leaves counts once, with unknown tokens", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    setup.flag("fake-stream-hold");
    yield* Effect.promise(async () => {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${setup.port}/api/ai/anthropic/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      controller.abort();
    });
    yield* stored(setup, 1);
    // The upstream finishing later adds nothing: the next request is the second row, not a third.
    setup.flag("fake-stream-hold", false);
    setup.flag("fake-stream-release");
    assert.equal(
      (yield* call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() })).status,
      200,
    );
    yield* stored(setup, 2);
    const rows = yield* setup.server.sql<{
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }>`SELECT input_tokens AS "inputTokens", output_tokens AS "outputTokens" FROM ai_usage
      ORDER BY at, usage_id`;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.inputTokens, row.outputTokens]),
      [
        [null, null],
        [11, 7],
      ],
    );
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.requests, 2);
    assert.equal(owner.totals.unknownRequests, 1);
    assert.equal(owner.totals.inputTokens, 11);
  }),
);

live("a stream the client leaves after its last event keeps its tokens (ticket 16)", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    // The answer is complete, but the upstream has not closed it yet when the client leaves:
    // an SDK that stops reading at its last event, before the end of the body.
    setup.flag("fake-stream-tail-hold");
    const leaveAfter = (path: string, body: unknown, last: string) =>
      Effect.promise(async () => {
        const controller = new AbortController();
        const response = await fetch(`http://127.0.0.1:${setup.port}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let seen = "";
        while (!seen.includes(last)) {
          const read = await reader.read();
          if (read.done) break;
          seen += decoder.decode(read.value, { stream: true });
        }
        controller.abort();
        return seen.includes(last);
      });
    assert.isTrue(
      yield* leaveAfter(
        "/api/ai/anthropic/v1/messages",
        messages("claude-sonnet-5-5", { stream: true }),
        "message_stop",
      ),
    );
    assert.isTrue(
      yield* leaveAfter(
        "/api/ai/openai/v1/responses",
        { model: "deepseek-chat", input: "hi", stream: true },
        "response.completed",
      ),
    );
    assert.isTrue(
      yield* leaveAfter(
        "/api/ai/openai/v1/chat/completions",
        { model: "deepseek-chat", messages: [], stream: true },
        "[DONE]",
      ),
    );
    yield* stored(setup, 3);
    setup.flag("fake-stream-tail-hold", false);
    const rows = yield* setup.server.sql<{
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }>`SELECT input_tokens AS "inputTokens", output_tokens AS "outputTokens" FROM ai_usage
      ORDER BY at, usage_id`;
    assert.deepEqual(
      rows.map((row) => [row.inputTokens, row.outputTokens]),
      [
        [11, 7],
        [11, 7],
        [11, 7],
      ],
    );
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.unknownRequests, 0);
    assert.equal(owner.totals.inputTokens, 33);
    assert.equal(owner.totals.outputTokens, 21);
  }),
);

live("an answer without usage counts as a request with unknown tokens", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const ids = yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    yield* setup.activity.record({
      at: "2026-11-12T10:00:00.000Z",
      keyId: "key-x",
      keyKind: "thread",
      userId: setup.people.member,
      spaceId: setup.acmeId,
      threadId: null,
      shape: "openai",
      route: "/chat/completions",
      accountId: ids.router,
      provider: "openai-compatible",
      model: "deepseek-chat",
      status: 200,
      durationMs: 12,
      failovers: 0,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    yield* stored(setup, 1);
    const rows = yield* setup.server.sql<{ readonly day: string }>`SELECT day FROM ai_usage`;
    assert.deepEqual(rows, [{ day: "2026-11-12" }]);
    const owner = yield* summaryAs(setup, setup.ownerId, {
      fromDay: "2026-11-01",
      toDay: "2026-11-30",
    });
    assert.equal(owner.totals.requests, 1);
    assert.equal(owner.totals.unknownRequests, 1);
    assert.equal(key.startsWith("t3gk_"), true);
  }),
);

live("a failed write is logged and never cuts a request; later requests are still counted", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    const ask = () => call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });
    yield* setup.server.sql`ALTER TABLE ai_usage RENAME TO ai_usage_away`;
    const during = yield* ask();
    assert.equal(during.status, 200);
    assert.include(during.text, "Hello from");
    yield* stored(setup, 1);
    yield* setup.server.sql`ALTER TABLE ai_usage_away RENAME TO ai_usage`;
    assert.equal((yield* ask()).status, 200);
    yield* stored(setup, 2);
    assert.deepEqual(setup.written, [false, true]);
    const owner = yield* summaryAs(setup, setup.ownerId);
    // The one the table could not take is lost, and the summary agrees with the rows.
    assert.equal(owner.totals.requests, 1);
    const rows = yield* setup.server.sql<{
      readonly n: number;
    }>`SELECT COUNT(*) AS n FROM ai_usage`;
    assert.equal(rows[0]?.n, 1);
  }),
);

/** Grace (Member) and Ada (Admin) of Acme, Gus (Member) of Globex, each with one request. */
const threeUsers = Effect.fn(function* (setup: Hub) {
  const ids = yield* acmeSetup(setup);
  const grace = yield* setup.thread(setup.people.member, setup.acmeId);
  const ada = yield* setup.thread(setup.people.admin, setup.acmeId);
  const gus = yield* setup.thread(setup.people.globexMember, setup.globexId);
  const ask = (key: string) =>
    call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });
  for (const { key } of [grace, ada, gus]) assert.equal((yield* ask(key)).status, 200);
  yield* stored(setup, 3);
  return { ids, grace, ada, gus };
});

live("a Member sees only their own usage, never another Member's or another Space's", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { grace, ada, gus } = yield* threeUsers(setup);
    const { member, admin, globexMember } = setup.people;

    const graceView = yield* summaryAs(setup, member);
    assert.equal(graceView.scope, "own");
    assert.deepEqual(usersIn(graceView), [member]);
    assert.equal(graceView.totals.requests, 1);
    // Asking for others narrows to nothing: a filter never widens what is seen.
    for (const input of [
      { userId: admin },
      { userId: globexMember },
      { spaceId: setup.globexId },
      { threadId: ada.threadId },
      { threadId: gus.threadId },
    ] satisfies ReadonlyArray<AiUsageSummaryInput>) {
      assert.equal((yield* summaryAs(setup, member, input)).rows.length, 0, JSON.stringify(input));
    }
    assert.equal(
      (yield* summaryAs(setup, member, { threadId: grace.threadId })).totals.requests,
      1,
    );
    // Their names are not shown either.
    assert.deepEqual(
      graceView.labels.users.map((user) => user.id),
      [member],
    );

    const gusView = yield* summaryAs(setup, globexMember);
    assert.deepEqual(usersIn(gusView), [globexMember]);
    assert.equal(
      (yield* summaryAs(setup, globexMember, { threadId: grace.threadId })).rows.length,
      0,
    );
    // Anyone with no usage sees an empty answer, not an error.
    const guest = yield* summaryAs(setup, setup.people.guest);
    assert.equal(guest.rows.length, 0);
  }),
);

live("the Usage dialog's Hub turns follow the same rules as the summary (ticket 16)", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { grace, ada, gus } = yield* threeUsers(setup);
    const { member, admin, globexMember } = setup.people;
    const window = { fromAt: "2000-01-01T00:00:00.000Z", toAt: "2100-01-01T00:00:00.000Z" };
    const threadsSeenBy = (userId: UserId, spaceLimit?: SpaceId) =>
      setup.usage.threadRequests(window).pipe(
        spaceLimit === undefined
          ? CommandActor.actAs(userId)
          : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit }),
        Effect.map((requests) => requests.map((request) => request.threadId).toSorted()),
      );
    const all = [grace.threadId, ada.threadId, gus.threadId].toSorted();
    assert.deepEqual(yield* threadsSeenBy(setup.ownerId), all);
    assert.deepEqual(yield* threadsSeenBy(member), [grace.threadId]);
    assert.deepEqual(yield* threadsSeenBy(globexMember), [gus.threadId]);
    assert.deepEqual(yield* threadsSeenBy(admin), [grace.threadId, ada.threadId].toSorted());
    assert.deepEqual(yield* threadsSeenBy(setup.ownerId, setup.globexId), [gus.threadId]);
    // Tokens and the dialect come along; the window bounds them.
    const [first] = yield* setup.usage.threadRequests(window).pipe(CommandActor.actAs(member));
    assert.deepEqual([first?.shape, first?.inputTokens, first?.outputTokens], ["anthropic", 11, 7]);
    assert.deepEqual(
      yield* setup.usage
        .threadRequests({ fromAt: "2000-01-01T00:00:00.000Z", toAt: "2000-01-02T00:00:00.000Z" })
        .pipe(CommandActor.actAs(setup.ownerId)),
      [],
    );
    // Without a signed-in User: refused, as the summary is.
    const anonymous = yield* setup.usage.threadRequests(window).pipe(Effect.flip);
    assert.equal(anonymous.reason, "forbidden");
  }),
);

live("an Admin sees their Organization's usage, never another Organization's", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { grace, ada, gus } = yield* threeUsers(setup);
    const { member, admin, globexMember } = setup.people;

    const adaView = yield* summaryAs(setup, admin);
    assert.equal(adaView.scope, "spaces");
    assert.deepEqual(usersIn(adaView), [admin, member].toSorted());
    assert.equal(adaView.totals.requests, 2);
    assert.deepEqual(
      adaView.labels.spaces.map((space) => space.id),
      [setup.acmeId],
    );
    for (const input of [
      { userId: globexMember },
      { spaceId: setup.globexId },
      { threadId: gus.threadId },
    ] satisfies ReadonlyArray<AiUsageSummaryInput>) {
      assert.equal((yield* summaryAs(setup, admin, input)).rows.length, 0, JSON.stringify(input));
    }
    // A Member's Thread in their Space is theirs to read; an Admin elsewhere is not.
    assert.equal((yield* summaryAs(setup, admin, { threadId: grace.threadId })).totals.requests, 1);
    assert.equal((yield* summaryAs(setup, admin, { threadId: ada.threadId })).totals.requests, 1);
    // Admin of Acme and a Member of nothing in Globex: Gus's own view is still only Gus.
    assert.deepEqual(usersIn(yield* summaryAs(setup, globexMember)), [globexMember]);

    // Ended as an Admin, no longer sees another's usage; their own stays theirs.
    yield* setup.server.sql`UPDATE space_memberships SET role = 'member' WHERE user_id = ${admin}`;
    yield* setup.directory.membershipsChanged([admin]);
    const demoted = yield* summaryAs(setup, admin);
    assert.equal(demoted.scope, "own");
    assert.deepEqual(usersIn(demoted), [admin]);
  }),
);

live("the Owner sees everything, unless the session is limited to one Space", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* threeUsers(setup);
    const { member, admin, globexMember } = setup.people;
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.scope, "all");
    assert.deepEqual(usersIn(owner), [admin, globexMember, member].toSorted());
    assert.deepEqual(
      (yield* summaryAs(setup, setup.ownerId, { spaceId: setup.globexId })).totals.requests,
      1,
    );
    // An agent acting as the Owner but bound to Acme's Sandbox reaches nothing of Globex.
    const limited = yield* summaryAs(setup, setup.ownerId, {}, setup.acmeId);
    assert.notEqual(limited.scope, "all");
    assert.equal(limited.rows.filter((row) => row.spaceId === setup.globexId).length, 0);
    assert.equal(
      (yield* summaryAs(setup, setup.ownerId, { spaceId: setup.globexId }, setup.acmeId)).rows
        .length,
      0,
    );
  }),
);

live("an account's name is shown only to the Owner and to those who may use it", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { ids } = yield* threeUsers(setup);
    const nameOf = (view: AiUsageSummary) =>
      view.labels.accounts.find((account) => account.id === ids.claudeA)?.name;
    assert.equal(nameOf(yield* summaryAs(setup, setup.people.member)), "Acme Claude A");
    // Allowed to no one now: the Member still sees their usage, no longer the account's name.
    yield* setup.accounts
      .allow({ accountId: ids.claudeA, spaceIds: [], userIds: [] })
      .pipe(setup.asOwner);
    const after = yield* summaryAs(setup, setup.people.member);
    assert.equal(after.totals.requests, 1);
    assert.equal(nameOf(after), null);
    assert.equal(nameOf(yield* summaryAs(setup, setup.ownerId)), "Acme Claude A");
  }),
);

live("per-request rows are swept after 90 days; the daily summaries stay", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    assert.equal(
      (yield* call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() })).status,
      200,
    );
    yield* stored(setup, 1);
    const old = "2020-01-01T00:00:00.000Z";
    yield* setup.server.sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
        provider, model, shape, status, duration_ms, failovers, input_tokens, output_tokens)
      VALUES ('old-1', ${old}, '2020-01-01', ${setup.people.member}, ${setup.acmeId}, NULL, 'k',
        NULL, NULL, NULL, 'claude', 200, 1, 0, 5, 5)
    `;
    yield* setup.server.sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, requests, input_tokens,
        output_tokens) VALUES ('2020-01-01', ${setup.people.member}, ${setup.acmeId}, '', '', 1, 5, 5)
    `;
    assert.equal(yield* setup.usage.sweep, 1);
    const left = yield* setup.server.sql<{
      readonly id: string;
    }>`SELECT usage_id AS id FROM ai_usage`;
    assert.equal(left.length, 1);
    assert.notEqual(left[0]!.id, "old-1");
    const daily = yield* summaryAs(setup, setup.ownerId, {
      fromDay: "2020-01-01",
      toDay: "2020-01-31",
    });
    assert.equal(daily.totals.requests, 1);
    assert.equal(daily.totals.inputTokens, 5);
    assert.equal(daily.rows[0]!.accountId, null);
    assert.equal(daily.retentionDays, 90);
    assert.equal(yield* setup.usage.sweep, 0);
  }),
);

live("refuses a window that is not one", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    for (const input of [
      { fromDay: "2026-11-10", toDay: "2026-11-01" },
      { fromDay: "2024-01-01", toDay: "2026-11-01" },
      { fromDay: "2026-13-45", toDay: "2026-14-01" },
    ] satisfies ReadonlyArray<AiUsageSummaryInput>) {
      const refused = yield* summaryAs(setup, setup.ownerId, input).pipe(Effect.flip);
      assert.equal(refused.reason, "invalid");
    }
    // Nobody signed in reads nothing.
    const nobody = yield* setup.usage.summary({}).pipe(CommandActor.actAs(undefined), Effect.flip);
    assert.equal(nobody.reason, "forbidden");
  }),
);

live("the retention and sweep schedule come from the layer", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: { retentionDays: 7, sweepEveryMs: 3_600_000 } });
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.retentionDays, 7);
  }),
);

/** Resolves when the fake upstream has been asked (it logs the request on arrival): an event. */
const upstreamAsked = (setup: Hub) =>
  new Promise<void>((resolve) => {
    const watcher = NodeFS.watch(setup.memory, (_event, name) => {
      if (name === "fake-ai-requests.jsonl") {
        watcher.close();
        resolve();
      }
    });
  });

/** A request the upstream holds unanswered, once the upstream has it; `leave` abandons it. */
const holdOne = (setup: Hub, key: string) =>
  Effect.promise(async () => {
    const asked = upstreamAsked(setup);
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${setup.port}/api/ai/anthropic/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(messages()),
      signal: controller.signal,
    }).catch(() => undefined);
    await asked;
    return {
      leave: async () => {
        controller.abort();
        await pending;
      },
    };
  });

live("a request cancelled before any answer is still one counted request", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    setup.flag("fake-hang");
    const held = yield* holdOne(setup, key);
    yield* Effect.promise(() => held.leave());
    yield* stored(setup, 1);
    setup.flag("fake-hang", false);
    const rows = yield* setup.server.sql<{
      readonly status: number;
      readonly inputTokens: number | null;
    }>`SELECT status, input_tokens AS "inputTokens" FROM ai_usage`;
    assert.deepEqual(rows, [{ status: 499, inputTokens: null }]);
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.failedRequests, 1);
  }),
);

live("refusals after authentication are counted as failed requests with no account", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    const path = "/api/ai/anthropic/v1/messages";
    assert.equal((yield* call(setup, path, { key, rawBody: "not json" })).status, 400);
    assert.equal((yield* call(setup, path, { key, body: messages("no-such-model") })).status, 404);
    yield* stored(setup, 2);
    const rows = yield* setup.server.sql<{
      readonly status: number;
      readonly accountId: string | null;
    }>`SELECT status, account_id AS "accountId" FROM ai_usage ORDER BY status`;
    assert.deepEqual(
      rows.map((row) => [row.status, row.accountId]),
      [
        [400, null],
        [404, null],
      ],
    );
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.failedRequests, 2);
    assert.equal(owner.rows[0]!.accountId, null);
  }),
);

live("impossible days are refused, not thrown", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    for (const input of [
      { toDay: "2026-13-45" },
      { fromDay: "2026-02-31", toDay: "2026-03-05" },
      { fromDay: "2026-11-01", toDay: "2026-02-30" },
    ] satisfies ReadonlyArray<AiUsageSummaryInput>) {
      const refused = yield* summaryAs(setup, setup.ownerId, input).pipe(Effect.flip);
      assert.equal(refused.reason, "invalid", JSON.stringify(input));
    }
  }),
);

live("an Admin's scope comes from their rights, not from traffic in the window", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const empty = yield* summaryAs(setup, setup.people.admin);
    assert.equal(empty.scope, "spaces");
    assert.equal((yield* summaryAs(setup, setup.people.member)).scope, "own");
    assert.equal((yield* summaryAs(setup, setup.ownerId)).scope, "all");
  }),
);

live("a Space the viewer left shows no name, not even a new one", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* threeUsers(setup);
    yield* setup.server.sql`DELETE FROM space_memberships WHERE user_id = ${setup.people.member}`;
    yield* setup.directory.membershipsChanged([setup.people.member]);
    const view = yield* summaryAs(setup, setup.people.member);
    assert.equal(view.totals.requests, 1);
    assert.notInclude(JSON.stringify(view.labels.spaces), "Acme");
    assert.deepEqual(
      view.labels.spaces.map((space) => space.name),
      [null],
    );
  }),
);

live("totals count every request even when the rows are cut", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith(
      {},
      { usage: { retentionDays: 90, sweepEveryMs: 86_400_000, maxRows: 1 } },
    );
    yield* threeUsers(setup);
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.rows.length, 1);
    assert.equal(owner.truncated, true);
    assert.equal(owner.totals.requests, 3);
    assert.equal(owner.totals.inputTokens, 33);
  }),
);

live("the sweep deletes old rows in batches", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    yield* setup.server.sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, key_id, shape, status,
        duration_ms, failovers)
      SELECT 'old-' || i, '2020-01-01T00:00:00.000Z', '2020-01-01', 'u', 's', 'k', 'claude', 200,
        1, 0 FROM n`;
    assert.equal(yield* setup.usage.sweep, 12000);
    assert.equal(yield* setup.usage.sweep, 0);
  }),
);

live("limit refusals only add to the daily summary, never a row each", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({ perKey: 1 });
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    setup.flag("fake-hang");
    const held = yield* holdOne(setup, key);
    const refused = yield* call(setup, "/api/ai/anthropic/v1/messages", {
      key,
      body: messages(),
    });
    assert.equal(refused.status, 429);
    yield* Effect.promise(() => held.leave());
    // The refusal's flush and the abandoned request's row.
    yield* stored(setup, 2);
    setup.flag("fake-hang", false);
    const rows = yield* setup.server.sql<{ readonly status: number }>`SELECT status FROM ai_usage`;
    assert.deepEqual(rows, [{ status: 499 }]);
    const owner = yield* summaryAs(setup, setup.ownerId);
    assert.equal(owner.totals.requests, 2);
    assert.equal(owner.totals.failedRequests, 2);
  }),
);
