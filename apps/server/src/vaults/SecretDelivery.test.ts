/**
 * SecretDelivery (spec 5 ticket 04): what one process of a Thread receives, read as it starts.
 * Whose secrets a turn gets comes from the Hub (its Thread owner), never from the caller.
 */
import {
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  MAIN_VAULT_ID,
  ThreadId,
  UserId,
  type SecretEnv,
  type VaultEntryId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { bootstrapOwner, makeAuthenticator, serveAuthHttp } from "../auth/UserAuth.testkit.ts";
import * as SecretDelivery from "./SecretDelivery.ts";
import * as SecretMasker from "./SecretMasker.ts";
import * as Vaults from "./Vaults.ts";

const HUB = {
  environmentId: HUB_MACHINE_ENVIRONMENT_ID,
  contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
};

const ownersThread = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = UserId.make((created.body.user as { id: string }).id);
  const vaults = Context.get(server.services, Vaults.Vaults);
  const delivery = Context.get(server.services, SecretDelivery.SecretDelivery);
  const entries = new Map<string, VaultEntryId>();
  const put = (
    name: string,
    value: string,
    confirmDangerous?: boolean,
    entryClass?: "secret" | "variable",
  ) =>
    vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        name,
        value: Redacted.make(value),
        ...(entries.has(name) ? { entryId: entries.get(name)! } : {}),
        ...(confirmDangerous === undefined ? {} : { confirmDangerous }),
        ...(entryClass === undefined ? {} : { class: entryClass }),
      })
      .pipe(
        CommandActor.actAs(owner),
        Effect.tap((result) => Effect.sync(() => void entries.set(name, result.entry.id))),
      );
  const thread = Effect.fn(function* (id: string, rootThreadId?: string) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, space_id, owner_user_id
      ) VALUES (
        ${id}, 'project:none', ${id}, 'codex', 'full-access', 'default', ${now}, ${now},
        ${JSON.stringify(rootThreadId === undefined ? {} : { lineage: { rootThreadId } })},
        ${`personal:${owner}`}, ${rootThreadId === undefined ? owner : null}
      )
    `;
    return ThreadId.make(id);
  });
  // A process starting: the plan, then its values.
  const forTurn = (input: Parameters<typeof delivery.planTurn>[0]) =>
    delivery.planTurn(input).pipe(Effect.flatMap(delivery.resolve));
  const forProcess = (input: Parameters<typeof delivery.plan>[0]) =>
    delivery.plan(input).pipe(Effect.flatMap(delivery.resolve));
  return { server, owner, put, thread, delivery, forTurn, forProcess };
});

const valueOf = (secretEnv: SecretEnv | undefined, name: string) =>
  secretEnv?.variables?.find((variable) => variable.name === name)?.value;

it.effect("a turn gets its Thread owner's secrets, a child Thread its root's", () =>
  Effect.gen(function* () {
    const { owner, put, thread, delivery, forTurn, forProcess } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    const root = yield* thread("thread:root");
    const child = yield* thread("thread:child", root);
    const turn = yield* forTurn({ threadId: root, target: HUB });
    assert.equal(valueOf(turn, "OWNER_TOKEN"), "owner-token-value");
    const childTurn = yield* forTurn({ threadId: child, target: HUB });
    assert.equal(valueOf(childTurn, "OWNER_TOKEN"), "owner-token-value");
    assert.equal(turn?.fingerprint, childTurn?.fingerprint);
    // A process nobody starts gets nothing.
    assert.deepEqual(yield* forProcess({ threadId: root, actingUserId: undefined, target: HUB }), {
      fingerprint: "none",
      variables: [],
    });
    assert.isTrue(yield* delivery.mayReceiveSecrets(root));
    assert.deepEqual(yield* delivery.turnOwner(child), yield* delivery.turnOwner(root));
    assert.deepEqual(yield* delivery.turnOwner(root), Option.some(owner));
  }).pipe(Effect.scoped),
);

it.effect("a rotation changes what the next process gets, and its fingerprint", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "first-value");
    const threadId = yield* thread("thread:rotate");
    const before = yield* forTurn({ threadId, target: HUB });
    yield* put("OWNER_TOKEN", "rotated-value");
    const after = yield* forTurn({ threadId, target: HUB });
    assert.equal(valueOf(after, "OWNER_TOKEN"), "rotated-value");
    assert.notEqual(before?.fingerprint, after?.fingerprint);
    assert.notInclude(after?.fingerprint ?? "", "rotated-value");
  }).pipe(Effect.scoped),
);

it.effect("a machine before executor contract 10 gets a refusal, not a process without them", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    const threadId = yield* thread("thread:old");
    const old = { environmentId: HUB_MACHINE_ENVIRONMENT_ID, contractVersion: 9 };
    // Without secrets, an old machine works as before.
    assert.deepEqual(yield* forTurn({ threadId, target: old }), {
      fingerprint: "none",
      variables: [],
    });
    yield* put("OWNER_TOKEN", "owner-token-value");
    const refused = yield* Effect.exit(forTurn({ threadId, target: old }));
    assert.isTrue(Exit.isFailure(refused));
    assert.include(JSON.stringify(refused), "outdated-machine");
  }).pipe(Effect.scoped),
);

it.effect("a machine that does not serve the Thread's Space gets nothing", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    const threadId = yield* thread("thread:elsewhere");
    const unknown = {
      environmentId: EnvironmentId.make("environment:unknown"),
      contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
    };
    assert.deepEqual(yield* forTurn({ threadId, target: unknown }), {
      fingerprint: "none",
      variables: [],
    });
  }).pipe(Effect.scoped),
);

it.effect("a Variable is delivered plain: never remembered for masking, never masked", () =>
  Effect.gen(function* () {
    const { server, put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    yield* put("AWS_REGION", "eu-central-1", undefined, "variable");
    const threadId = yield* thread("thread:variables");
    const before = yield* forTurn({ threadId, target: HUB });
    assert.deepEqual(
      before?.variables?.map((variable) => ({ ...variable })),
      [
        { name: "AWS_REGION", value: "eu-central-1", plain: true },
        { name: "OWNER_TOKEN", value: "owner-token-value" },
      ],
    );
    // Only the Secret is recorded as delivered for the Thread's masking.
    const remembered = yield* server.sql<{ readonly name: string }>`
      SELECT name FROM thread_secret_values WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(
      remembered.map((row) => row.name),
      ["OWNER_TOKEN"],
    );
    const masker = yield* Context.get(server.services, SecretMasker.SecretMasker).forThread(
      threadId,
    );
    assert.equal(
      masker.mask("region eu-central-1, token owner-token-value"),
      "region eu-central-1, token [OWNER_TOKEN]",
    );
    // Turned into a Secret, it goes as one: a new set, so a new fingerprint.
    yield* put("AWS_REGION", "eu-central-1-secret", undefined, "secret");
    const after = yield* forTurn({ threadId, target: HUB });
    assert.notEqual(before?.fingerprint, after?.fingerprint);
    assert.isUndefined(after?.variables?.find((variable) => variable.name === "AWS_REGION")?.plain);
  }).pipe(Effect.scoped),
);

it.effect("a name that changes how tools run goes only as the Owner set it", () =>
  Effect.gen(function* () {
    const { server, put, thread, forTurn } = yield* ownersThread;
    yield* put("LD_PRELOAD_LIBS", "/owner/lib.so", true);
    const threadId = yield* thread("thread:dangerous");
    assert.equal(
      valueOf(yield* forTurn({ threadId, target: HUB }), "LD_PRELOAD_LIBS"),
      "/owner/lib.so",
    );
    // Written by anyone else (a write the Owner did not make), it is never delivered.
    yield* server.sql`UPDATE vault_entries SET updated_by = 'someone-else' WHERE name = 'LD_PRELOAD_LIBS'`;
    assert.isUndefined(valueOf(yield* forTurn({ threadId, target: HUB }), "LD_PRELOAD_LIBS"));
  }).pipe(Effect.scoped),
);
