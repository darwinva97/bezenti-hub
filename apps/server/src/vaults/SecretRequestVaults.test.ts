/**
 * Spec 5 «Vaults», ticket 06: the agent lists the names its turns receive, and an answer to
 * `request_secret` may also be saved in a Vault. The Owner; Ada (Admin), Grace (Member) and Linus
 * (Guest) of Acme; Gus (Admin) of Globex; Hedy, Admin of both. Real Vaults, policy and audit; the
 * card's Thread records are a stub (only the Thread's starter answers: `thread.continue`).
 */
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MAIN_VAULT_ID,
  type OrchestrationV2ServerCommand,
  ProjectId,
  type SecretRequestAnswerInput,
  SpaceId,
  ThreadId,
  TurnItemId,
  UserId,
  type VaultId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import {
  filesHolding,
  processArgsHolding,
} from "../environments/HubWithEnvironments.secretMasking.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SecretDelivery from "./SecretDelivery.ts";
import * as Vaults from "./Vaults.ts";

const VALUE = "sk_live_stripe_value_4242";
const turnItemId = TurnItemId.make("turn-item:secret-request:stripe");

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  const person = Effect.fn(function* (
    id: string,
    memberships: ReadonlyArray<readonly [SpaceId, "admin" | "member" | "guest"]>,
  ) {
    yield* addMember(server, { id, displayName: id });
    for (const [spaceId, role] of memberships) {
      yield* joinOrganization(server, spaceId, id, role);
    }
    // An Admin acts as one only with a strong factor.
    if (memberships.some(([, role]) => role === "admin")) {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return UserId.make(id);
  });
  const ada = yield* person("ada", [[acmeId, "admin"]]);
  const grace = yield* person("grace", [[acmeId, "member"]]);
  const linus = yield* person("linus", [[acmeId, "guest"]]);
  const gus = yield* person("gus", [[globexId, "admin"]]);
  const hedy = yield* person("hedy", [
    [acmeId, "admin"],
    [globexId, "admin"],
  ]);
  const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
  yield* directory.membershipsChanged([ada, grace, linus, gus, hedy]);
  const vaults = Context.get(server.services, Vaults.Vaults);
  const delivery = Context.get(server.services, SecretDelivery.SecretDelivery);
  const as = (userId: UserId) => CommandActor.actAs(userId);
  const thread = Effect.fn(function* (id: string, ownerUserId: UserId, spaceId: SpaceId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, space_id, owner_user_id
      ) VALUES (
        ${id}, 'project:none', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, '{}',
        ${spaceId}, ${ownerUserId}
      )
    `;
    return ThreadId.make(id);
  });
  const vault = Effect.fn(function* (name: string, spaceId: SpaceId | null) {
    return (yield* vaults.create({ name, spaceId }).pipe(as(ownerId))).id;
  });
  const acmeVault = yield* vault("Acme secrets", acmeId);
  const globexVault = yield* vault("Globex secrets", globexId);
  // The Owner's, allowed to both Organizations: no Admin edits it (it reaches more than theirs).
  const shared = yield* vault("Shared", null);
  for (const spaceId of [acmeId, globexId]) {
    yield* vaults
      .allow({ vaultId: shared, subject: { kind: "space", spaceId }, allowed: true })
      .pipe(as(ownerId));
  }
  // Allowed to Grace herself: she receives it, but only the Owner edits it.
  const gracesOwn = yield* vault("Grace's", null);
  yield* vaults
    .allow({ vaultId: gracesOwn, subject: { kind: "user", userId: grace }, allowed: true })
    .pipe(as(ownerId));
  yield* vaults.setSpaceDefaults({ spaceId: acmeId, vaultIds: [acmeVault] }).pipe(as(ownerId));

  /** The Hub's SecretRequests over its store and Vaults, with one pending card per Thread. */
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const status = new Map<string, string>();
  /** How many of the next records fail, as a busy orchestration would. */
  const failing = { records: 0 };
  const requests = yield* Layer.build(
    SecretRequests.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          authorizeThread: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed({
              thread: { projectId: ProjectId.make("project:none") },
              runs: [{ id: "run-1", status: "running" }],
              turnItems: [
                {
                  id: turnItemId,
                  threadId,
                  runId: "run-1",
                  nodeId: "node-root",
                  type: "secret_request",
                  label: "Stripe key",
                  reason: "For the payments tests.",
                  secretName: "STRIPE_KEY",
                  secretStatus: status.get(threadId) ?? "pending",
                },
              ],
            } as never),
          dispatch: (command: OrchestrationV2ServerCommand) =>
            failing.records > 0
              ? Effect.suspend(() => {
                  failing.records -= 1;
                  return Effect.fail(new Error("orchestration busy") as never);
                })
              : Effect.sync(() => {
                  dispatched.push(command);
                  if (command.type === "secret_request.record") {
                    status.set(command.threadId, command.secretStatus);
                  }
                  return {} as never;
                }),
        }),
      ),
      Layer.provide(Layer.succeedContext(server.services)),
      Layer.provide(Layer.mergeAll(PlatformNodeCrypto.layer, NodeServices.layer)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, SecretRequests.SecretRequests)));

  const save = (
    threadId: ThreadId,
    saveToVault?: { readonly vaultId: VaultId; readonly name: string },
    secret: string = VALUE,
  ): SecretRequestAnswerInput => ({
    threadId,
    turnItemId,
    answer: {
      type: "save",
      secret,
      ...(saveToVault === undefined ? {} : { saveToVault }),
    },
  });
  const entryNames = (vaultId: VaultId) =>
    vaults.listEntries({ vaultId }).pipe(
      as(ownerId),
      Effect.map((listed) => listed.entries.map((entry) => entry.name)),
    );
  const targetNames = (userId: UserId, threadId: ThreadId) =>
    requests.vaultTargets({ threadId }).pipe(
      as(userId),
      Effect.map((targets) => targets.vaults.map((target) => target.name)),
    );
  return {
    server,
    ownerId,
    acmeId,
    globexId,
    ada,
    grace,
    linus,
    gus,
    hedy,
    vaults,
    delivery,
    as,
    thread,
    acmeVault,
    globexVault,
    shared,
    gracesOwn,
    requests,
    dispatched,
    failing,
    save,
    entryNames,
    targetNames,
  };
});

const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

it.effect("the card offers only the Vaults the answerer may edit that reach the Thread", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const acmeByOwner = yield* t.thread("thread-acme-owner", t.ownerId, t.acmeId);
    const acmeByAda = yield* t.thread("thread-acme-ada", t.ada, t.acmeId);
    const acmeByGrace = yield* t.thread("thread-acme-grace", t.grace, t.acmeId);
    const acmeByLinus = yield* t.thread("thread-acme-linus", t.linus, t.acmeId);
    const acmeByHedy = yield* t.thread("thread-acme-hedy", t.hedy, t.acmeId);
    const globexByGus = yield* t.thread("thread-globex-gus", t.gus, t.globexId);

    // The Owner: whatever reaches Acme, never the Main vault (it reaches only their own Space).
    assert.deepStrictEqual(yield* t.targetNames(t.ownerId, acmeByOwner), [
      "Acme secrets",
      "Shared",
    ]);
    // An Admin: their Organization's Vault; not the Owner's Shared one, not the Main vault.
    assert.deepStrictEqual(yield* t.targetNames(t.ada, acmeByAda), ["Acme secrets"]);
    // An Admin of both Organizations, in an Acme Thread: nothing of Globex's own; the Owner's
    // Shared Vault reaches only Organizations Hedy runs, so the policy lets her edit it.
    assert.deepStrictEqual(yield* t.targetNames(t.hedy, acmeByHedy), ["Acme secrets", "Shared"]);
    assert.deepStrictEqual(yield* t.targetNames(t.gus, globexByGus), ["Globex secrets"]);
    // A Member and a Guest edit no Vault (`vault.edit`), a Vault allowed to Grace included.
    assert.deepStrictEqual(yield* t.targetNames(t.grace, acmeByGrace), []);
    assert.deepStrictEqual(yield* t.targetNames(t.linus, acmeByLinus), []);
  }),
);

it.effect("a Member cannot save into a Vault, even sending the field by hand", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const threadId = yield* t.thread("thread-grace", t.grace, t.acmeId);
    for (const vaultId of [t.acmeVault, t.gracesOwn]) {
      const reason = yield* reasonOf(
        t.requests.answer(t.save(threadId, { vaultId, name: "STRIPE_KEY" })).pipe(t.as(t.grace)),
      );
      assert.equal(reason, "vault_not_permitted");
      assert.deepStrictEqual(yield* t.entryNames(vaultId), []);
    }
    // Nothing was recorded: the card stays pending and is answered as today.
    assert.equal(t.dispatched.length, 0);
    yield* t.requests.answer(t.save(threadId)).pipe(t.as(t.grace));
    assert.equal(t.dispatched.length, 1);
  }),
);

it.effect("an Admin cannot save into the Main vault or another Organization's Vault", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const byAda = yield* t.thread("thread-ada", t.ada, t.acmeId);
    const byHedy = yield* t.thread("thread-hedy", t.hedy, t.acmeId);
    for (const [userId, threadId, vaultId] of [
      [t.ada, byAda, MAIN_VAULT_ID],
      [t.ada, byAda, t.globexVault],
      [t.ada, byAda, t.shared],
      // Hedy edits Globex's Vault, but this is an Acme Thread.
      [t.hedy, byHedy, t.globexVault],
    ] as const) {
      const reason = yield* reasonOf(
        t.requests.answer(t.save(threadId, { vaultId, name: "STRIPE_KEY" })).pipe(t.as(userId)),
      );
      assert.equal(reason, "vault_not_permitted");
      assert.deepStrictEqual(yield* t.entryNames(vaultId), []);
    }
    assert.equal(t.dispatched.length, 0);
  }),
);

it.effect("an Admin's answer is saved in Acme secrets, audited, and the next Thread lists it", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const asked = yield* t.thread("thread-ada-asks", t.ada, t.acmeId);
    const next = yield* t.thread("thread-grace-next", t.grace, t.acmeId);
    const globex = yield* t.thread("thread-gus-globex", t.gus, t.globexId);
    assert.deepStrictEqual(yield* t.delivery.turnNames(next), []);

    yield* t.requests
      .answer(t.save(asked, { vaultId: t.acmeVault, name: "STRIPE_KEY" }))
      .pipe(t.as(t.ada));

    assert.deepStrictEqual(yield* t.entryNames(t.acmeVault), ["STRIPE_KEY"]);
    // What someone typed for an agent is a sealed Secret: nobody reads it back, the Owner neither.
    const [saved] = (yield* t.vaults.listEntries({ vaultId: t.acmeVault }).pipe(t.as(t.ownerId)))
      .entries;
    assert.deepStrictEqual([saved?.class, saved?.sealed], ["secret", true]);
    assert.equal(
      yield* reasonOf(
        t.vaults.reveal({ vaultId: t.acmeVault, entryId: saved!.id }).pipe(t.as(t.ownerId)),
      ),
      "sealed",
    );
    // The turn still gets its one-use ref, as today.
    assert.deepStrictEqual(
      t.dispatched.map((command) =>
        command.type === "secret_request.record" ? command.secretStatus : command.type,
      ),
      ["saved"],
    );
    const audit = yield* t.server.sql<{
      readonly actorUserId: string;
      readonly detail: string;
    }>`
      SELECT actor_user_id AS "actorUserId", detail_json AS detail FROM audit_log
      WHERE action = 'secret.edit' AND target_name = 'STRIPE_KEY'
    `;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actorUserId, "ada");
    assert.notInclude(audit[0]?.detail ?? "", VALUE);

    // Names only, the winning Vault's name: never the value.
    const listed = yield* t.delivery.turnNames(next);
    assert.deepStrictEqual(listed, [
      { name: "STRIPE_KEY", description: "Stripe key", vault: "Acme secrets" },
    ]);
    assert.notInclude(JSON.stringify(listed), VALUE);
    // A Globex Thread never lists Acme's names.
    assert.deepStrictEqual(yield* t.delivery.turnNames(globex), []);
    // Leak smoke (ticket 09): the answer and its Vault entry are sealed; no file of the Hub's
    // state (its store included), no row and no process argument holds the value.
    const { stateDir } = Context.get(t.server.services, ServerConfig.ServerConfig);
    let rows = "";
    for (const { name } of yield* t.server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `) {
      rows += JSON.stringify(yield* t.server.sql.unsafe(`SELECT * FROM "${name}"`));
    }
    assert.deepStrictEqual(
      {
        files: yield* filesHolding(stateDir, VALUE),
        database: rows.includes(VALUE),
        processes: yield* processArgsHolding(VALUE),
      },
      { files: [], database: false, processes: [] },
    );
  }),
);

it.effect(
  "names the Hub reserves, Owner-only names and taken names are refused from the card",
  () =>
    Effect.gen(function* () {
      const t = yield* hub;
      const byAda = yield* t.thread("thread-ada-names", t.ada, t.acmeId);
      const byOwner = yield* t.thread("thread-owner-names", t.ownerId, t.acmeId);
      const attempt = (userId: UserId, threadId: ThreadId, name: string) =>
        reasonOf(
          t.requests.answer(t.save(threadId, { vaultId: t.acmeVault, name })).pipe(t.as(userId)),
        );
      assert.equal(yield* attempt(t.ada, byAda, "T3CODE_TOKEN"), "vault_name_invalid");
      assert.equal(yield* attempt(t.ownerId, byOwner, "ANTHROPIC_BASE_URL"), "vault_name_invalid");
      assert.equal(yield* attempt(t.ada, byAda, "GIT_SSH_COMMAND"), "vault_name_invalid");
      // Dangerous names stay the Owner's, confirmed in Settings → Vaults, not from a card.
      assert.equal(yield* attempt(t.ownerId, byOwner, "GIT_SSH_COMMAND"), "vault_name_invalid");
      assert.equal(yield* attempt(t.ada, byAda, "not a name"), "vault_name_invalid");
      yield* t.vaults
        .putEntry({ vaultId: t.acmeVault, name: "STRIPE_KEY", value: Redacted.make("older-value") })
        .pipe(t.as(t.ada));
      assert.equal(yield* attempt(t.ada, byAda, "STRIPE_KEY"), "vault_name_taken");
      assert.equal(t.dispatched.length, 0);
    }),
);

it.effect(
  "a retry after a failed record saves the same answer once; another value is refused",
  () =>
    Effect.gen(function* () {
      const t = yield* hub;
      const threadId = yield* t.thread("thread-ada-retry", t.ada, t.acmeId);
      const target = { vaultId: t.acmeVault, name: "STRIPE_KEY" };
      t.failing.records = 1;
      assert.equal(
        yield* reasonOf(t.requests.answer(t.save(threadId, target)).pipe(t.as(t.ada))),
        "record_failed",
      );
      assert.deepStrictEqual(yield* t.entryNames(t.acmeVault), ["STRIPE_KEY"]);
      // Another value for the same card is not this answer: refused, the entry untouched.
      assert.equal(
        yield* reasonOf(
          t.requests.answer(t.save(threadId, target, "another-value-9999")).pipe(t.as(t.ada)),
        ),
        "vault_name_taken",
      );
      // The same answer again goes on to the turn.
      yield* t.requests.answer(t.save(threadId, target)).pipe(t.as(t.ada));
      assert.deepStrictEqual(yield* t.entryNames(t.acmeVault), ["STRIPE_KEY"]);
      const records = t.dispatched.filter((command) => command.type === "secret_request.record");
      assert.deepStrictEqual(
        records.map((command) => [command.secretStatus, command.secretName]),
        [["saved", "STRIPE_KEY"]],
      );
    }),
);

it.effect("two answers at once: one saves, the other finds the card answered", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const threadId = yield* t.thread("thread-ada-twice", t.ada, t.acmeId);
    const target = { vaultId: t.acmeVault, name: "STRIPE_KEY" };
    const both = yield* Effect.all(
      [
        Effect.result(t.requests.answer(t.save(threadId, target)).pipe(t.as(t.ada))),
        Effect.result(t.requests.answer(t.save(threadId, target)).pipe(t.as(t.ada))),
      ],
      { concurrency: "unbounded" },
    );
    const reasons = both.map((result) =>
      result._tag === "Success" ? "saved" : (result.failure as { reason: string }).reason,
    );
    assert.deepStrictEqual(reasons.toSorted(), ["already_answered", "saved"]);
    assert.deepStrictEqual(yield* t.entryNames(t.acmeVault), ["STRIPE_KEY"]);
  }),
);

it.effect("a value too short to be masked is not saved to a Vault from a card", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    const threadId = yield* t.thread("thread-ada-short", t.ada, t.acmeId);
    const reason = yield* reasonOf(
      t.requests
        .answer(t.save(threadId, { vaultId: t.acmeVault, name: "PIN" }, "1234"))
        .pipe(t.as(t.ada)),
    );
    assert.equal(reason, "vault_value_short");
    assert.deepStrictEqual(yield* t.entryNames(t.acmeVault), []);
    assert.equal(t.dispatched.length, 0);
  }),
);

it.effect("an agent on a machine that does not serve the Thread's Space lists no names", () =>
  Effect.gen(function* () {
    const t = yield* hub;
    yield* t.vaults
      .putEntry({ vaultId: t.acmeVault, name: "STRIPE_KEY", value: Redacted.make(VALUE) })
      .pipe(t.as(t.ada));
    const threadId = yield* t.thread("thread-grace-elsewhere", t.grace, t.acmeId);
    assert.deepStrictEqual(
      (yield* t.delivery.turnNames(threadId)).map((entry) => entry.name),
      ["STRIPE_KEY"],
    );
    // Its process runs on Globex's Sandbox (or any machine not serving Acme): it gets nothing.
    yield* t.server.sql`
      UPDATE orchestration_v2_projection_threads
      SET active_environment_id = ${`sandbox:${t.globexId}`} WHERE thread_id = ${threadId}
    `;
    assert.deepStrictEqual(yield* t.delivery.turnNames(threadId), []);
  }),
);
