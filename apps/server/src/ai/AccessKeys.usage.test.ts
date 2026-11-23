// @effect-diagnostics globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI that cuts an answer.
/**
 * Access-keys ticket 04: each access key's usage apart, an estimate for an answer with no usage,
 * and who sees it (whoever sees the Space's keys); on a real port over the fake CLIProxyAPI.
 */
import { assert, it } from "@effect/vitest";
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import { call, type Hub, hub, messages, platform, posix } from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const WEEK = { days: 7 } as const;

/** An AI account of its owner's: Acme's (by Ada) or a User's own. */
const ownClaude = (setup: Hub, as: UserId, organization: boolean) =>
  setup.accounts
    .create({
      name: organization ? "Acme Claude" : `${as} Claude`,
      provider: "claude",
      apiKey: Redacted.make(`sk-usage-${as}-claude-0123456789abcdef`),
      ...(organization ? { owner: { kind: "organization", spaceId: setup.acmeId } as const } : {}),
    })
    .pipe(CommandActor.actAs(as));

const keyIn = (setup: Hub, as: UserId, spaceId: Hub["acmeId"], label: string) =>
  setup.accessKeys
    .createForSession({ spaceId, label, validity: WEEK, models: ["*"], unlimited: true })
    .pipe(CommandActor.actAs(as));

/** A streamed answer read up to its first event, then dropped by the client. */
const cutAnswer = (setup: Hub, key: string) =>
  Effect.promise(async () => {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${setup.port}${MESSAGES}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    return { status: response.status, first };
  });

it.live.skipIf(!posix || platform === undefined)(
  "an access key's answer cut before its last event counts an estimate, never 0; a whole one counts its usage",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* ownClaude(setup, setup.people.admin, true);
      const made = yield* keyIn(setup, setup.people.admin, setup.acmeId, "Partner");
      const key = Redacted.value(made.key);
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 200);
      yield* setup.settled(1);

      setup.flag("fake-stream-hold");
      const cut = yield* cutAnswer(setup, key);
      setup.flag("fake-stream-release");
      assert.equal(cut.status, 200);
      assert.include(cut.first, "message_start");
      yield* setup.settled(2);
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      // Written and settled: nothing is held as unwritten, so the list counts each request once.
      assert.deepEqual(
        yield* setup.activity.unwritten(AiGatewayActivity.accessKeySubject(made.created.keyId)),
        [],
      );

      const [daily] = yield* setup.server.sql<{
        readonly requests: number;
        readonly unknown: number;
        readonly estimated: number;
        readonly input: number;
        readonly output: number;
      }>`
        SELECT SUM(requests) AS requests, SUM(unknown_requests) AS unknown,
          SUM(estimated_tokens) AS estimated, SUM(input_tokens) AS input,
          SUM(output_tokens) AS output
        FROM ai_usage_daily WHERE access_key_id = ${made.created.keyId}
      `;
      assert.equal(daily!.requests, 2);
      assert.equal(daily!.unknown, 1);
      // The whole answer's 11 + 7; the cut one at least what its first event said (11 + 1).
      assert.equal(daily!.input, 11);
      assert.equal(daily!.output, 7);
      assert.isAtLeast(daily!.estimated, 12);

      // The list says it: today and in total, with the estimate, never as zero.
      const listed = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      const usage = listed.keys[0]!.usage!;
      assert.equal(usage.total, 18 + daily!.estimated);
      assert.equal(usage.day, usage.total);
      assert.equal(usage.month, usage.total);
      assert.equal(usage.requests, 2);
      assert.equal(usage.unknownRequests, 1);
      assert.equal(usage.estimatedTokens, daily!.estimated);
      // The usage view counts it apart, as «≈».
      const summary = yield* setup.usage
        .summary({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.equal(summary.totals.estimatedTokens, daily!.estimated);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "an access key's usage shows to whoever sees the Space's keys, under its label: Acme's Admin and the Owner, a Personal space's User; never a Member; a filter only narrows",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { admin, member, globexMember } = setup.people;
      yield* ownClaude(setup, admin, true);
      yield* ownClaude(setup, member, false);
      const acme = yield* keyIn(setup, admin, setup.acmeId, "Partner");
      const graces = yield* keyIn(setup, member, `personal:${member}` as Hub["acmeId"], "A friend");
      for (const made of [acme, graces]) {
        const answer = yield* call(setup, MESSAGES, {
          key: Redacted.value(made.key),
          body: messages(),
        });
        assert.equal(answer.status, 200);
      }
      yield* setup.settled(2);
      const keyRows = (as: UserId, input: { readonly accessKeyId?: string } = {}) =>
        setup.usage.summary(input).pipe(
          CommandActor.actAs(as),
          Effect.map((summary) => ({
            keys: summary.rows.flatMap((row) =>
              row.accessKeyId === undefined || row.accessKeyId === null ? [] : [row.accessKeyId],
            ),
            labels: summary.labels.accessKeys ?? [],
            nullUsers: summary.rows.filter((row) => row.userId === null).length,
          })),
        );

      // Ada (Acme's Admin) sees Acme's key under its label, with no User.
      const adas = yield* keyRows(admin);
      assert.deepEqual(adas.keys, [acme.created.keyId]);
      assert.deepEqual(adas.labels, [{ id: acme.created.keyId, label: "Partner" }]);
      assert.equal(adas.nullUsers, 1);
      // Grace, a Member of Acme, does not see Acme's key; she sees her own Personal space's.
      const graceView = yield* keyRows(member);
      assert.deepEqual(graceView.keys, [graces.created.keyId]);
      // The Owner sees both.
      const owners = yield* keyRows(setup.ownerId);
      assert.sameMembers(owners.keys, [acme.created.keyId, graces.created.keyId]);
      // Gus sees neither, and filtering by one does not show it.
      assert.deepEqual((yield* keyRows(globexMember)).keys, []);
      assert.deepEqual(
        (yield* keyRows(globexMember, { accessKeyId: acme.created.keyId })).keys,
        [],
      );
      // A filter narrows the Owner's to one key.
      assert.deepEqual(
        (yield* keyRows(setup.ownerId, { accessKeyId: graces.created.keyId })).keys,
        [graces.created.keyId],
      );
    }).pipe(Effect.scoped),
);
