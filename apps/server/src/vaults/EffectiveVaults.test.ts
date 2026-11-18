/**
 * Reaching Vaults and the effective set of a Thread (spec 5 «Vaults», ticket 03; Grants ticket 07
 * for lent groups). The Owner; Ada (Admin), Grace (Member) and Linus (Guest) of Acme; Gus (Admin)
 * of Globex. What a turn, terminal or script receives is EffectiveVaults' alone: names and value
 * ids, never values.
 */
import {
  type GrantId,
  ProjectId,
  SpaceId,
  ThreadId,
  UserId,
  type VaultError,
  VaultGroupId,
  VaultThreadEnvironmentInput,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as CommandActor from "../auth/CommandActor.ts";
import * as Grants from "../grants/Grants.ts";
import { lendVaultGroup } from "../grants/Grants.testkit.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";
import { orgOwner, ownersDefault, userOwner } from "./VaultGroups.testkit.ts";
import * as Vaults from "./Vaults.ts";

const decodeThreadEnvironmentInput = Schema.decodeUnknownEffect(VaultThreadEnvironmentInput);

const VALUES = ["acme-default-one-111", "acme-default-two-222", "graces-own-token-333"];

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
    spaceId: SpaceId,
    role: "admin" | "member" | "guest",
  ) {
    const cookie = yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, spaceId, id, role);
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return { id: UserId.make(id), cookie };
  });
  const ada = yield* person("ada", acmeId, "admin");
  const grace = yield* person("grace", acmeId, "member");
  const linus = yield* person("linus", acmeId, "guest");
  const gus = yield* person("gus", globexId, "admin");
  const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
  yield* directory.membershipsChanged([ada.id, grace.id, linus.id, gus.id]);
  const vaults = Context.get(server.services, Vaults.Vaults);
  const effective = Context.get(server.services, EffectiveVaults.EffectiveVaults);
  const as =
    (userId: UserId, spaceLimit?: SpaceId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      spaceLimit === undefined
        ? CommandActor.actAs(userId)(effect)
        : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit })(effect);
  /** A Project made over the Hub's own door, as its creator. */
  const project = Effect.fn(function* (cookie: string, id: string, spaceId: SpaceId) {
    const made = yield* server.request("/api/projects/mutate", {
      cookie,
      body: {
        type: "project.create",
        commandId: `create-${id}`,
        projectId: id,
        title: id,
        workspaceRoot: server.newProjectFolder(id),
        spaceId,
      },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return ProjectId.make(id);
  });
  /** A Thread as the orchestrator stamps it: its Space and its creator. */
  const thread = Effect.fn(function* (
    id: string,
    ownerUserId: UserId,
    spaceId: SpaceId,
    projectId: ProjectId | null,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, space_id, owner_user_id
      ) VALUES (
        ${id}, ${projectId ?? "project:none"}, ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, '{}',
        ${spaceId}, ${ownerUserId}
      )
    `;
    return ThreadId.make(id);
  });
  /** A Vault of the Owner's with one secret. */
  const ownersVault = Effect.fn(function* (
    name: string,
    secrets: ReadonlyArray<readonly [string, string]>,
    spaceId: SpaceId | null = null,
  ) {
    const made = yield* vaults
      .create({ name, owner: spaceId === null ? userOwner(ownerId) : orgOwner(spaceId) })
      .pipe(as(ownerId));
    for (const [variable, value] of secrets) {
      yield* vaults
        .putEntry({ vaultId: made.id, name: variable, value: Redacted.make(value) })
        .pipe(as(ownerId));
    }
    return made.id;
  });
  const grants = Context.get(server.services, Grants.Grants);
  /** Group `vaultId` lent to `spaceId` by an active Grant of its owner (the Owner by default). */
  const lend = (
    vaultId: VaultGroupId,
    spaceId: SpaceId,
    lender: { readonly kind: "user" | "organization"; readonly id: string } = {
      kind: "user",
      id: ownerId,
    },
  ) => lendVaultGroup(server.sql, { vaultId, spaceId, lender });
  /** Its lender takes it back, as Grants does («Revoke»). */
  const revoke = (grantId: GrantId, by: UserId = ownerId) =>
    grants.end({ grantId }).pipe(as(by), Effect.asVoid);
  const names = (set: { readonly variables: ReadonlyArray<{ readonly name: string }> }) =>
    set.variables.map((variable) => variable.name);
  const winner = (
    set: {
      readonly variables: ReadonlyArray<{ readonly name: string; readonly vaultName: string }>;
    },
    name: string,
  ) => set.variables.find((variable) => variable.name === name)?.vaultName;
  return {
    server,
    owner,
    ownerId,
    main: yield* ownersDefault(server.sql),
    acmeId,
    globexId,
    ada,
    grace,
    linus,
    gus,
    directory,
    vaults,
    effective,
    as,
    project,
    thread,
    ownersVault,
    lend,
    revoke,
    names,
    winner,
  };
});

const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

it.effect("a group lent only to Globex never reaches an Acme Thread, by any path", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const globexOnly = yield* h.ownersVault("Globex keys", [["GLOBEX_KEY", "globex-key-value-1"]]);
    yield* h.lend(globexOnly, h.globexId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.globexId, vaultIds: [globexOnly] })
      .pipe(h.as(h.ownerId));
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    const graces = yield* h.thread("thread:grace-web", h.grace.id, h.acmeId, web);

    // Neither Acme's Admin nor the Owner adds it to Acme or to an Acme Project.
    for (const who of [h.ada.id, h.ownerId]) {
      assert.equal(
        yield* reasonOf(
          h.vaults.setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [globexOnly] }).pipe(h.as(who)),
        ),
        "not-allowed",
      );
      assert.equal(
        yield* reasonOf(
          h.vaults
            .setProjectChoice({ projectId: web, vaultId: globexOnly, choice: "add" })
            .pipe(h.as(who)),
        ),
        "not-allowed",
      );
    }
    // A choice left behind (a Project from another Space) changes nothing either.
    yield* h.server.sql`
      INSERT INTO project_vault_choices (project_id, group_id, choice) VALUES (${web}, ${globexOnly}, 'add')
    `;
    yield* h.server.sql`
      INSERT INTO space_default_vaults (space_id, group_id, position) VALUES (${h.acmeId}, ${globexOnly}, 0)
    `;
    const set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.deepEqual(h.names(set), []);
    // Only Acme's own (empty) `default`.
    assert.deepEqual(
      set.vaults.map((vault) => vault.name),
      ["default"],
    );
    // Globex's own Threads do get it.
    const gusThread = yield* h.thread("thread:gus", h.gus.id, h.globexId, null);
    const inGlobex = yield* h.effective.forThread({ threadId: gusThread, actingUserId: h.gus.id });
    assert.deepEqual(h.names(inGlobex), ["GLOBEX_KEY"]);
  }),
);

it.effect("a group lent to Grace's Personal space reaches her Threads there, nowhere else", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const gracesVault = yield* h.ownersVault("Grace's tokens", [["GRACE_TOKEN", VALUES[2]!]]);
    const personal = SpaceId.make(`personal:${h.grace.id}`);
    yield* h.lend(gracesVault, personal);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: personal, vaultIds: [gracesVault] })
      .pipe(h.as(h.grace.id));
    const mine = yield* h.thread("thread:grace-personal", h.grace.id, personal, null);
    const hers = yield* h.effective.forThread({ threadId: mine, actingUserId: h.grace.id });
    assert.deepEqual(h.names(hers), ["GRACE_TOKEN"]);
    assert.equal(hers.variables[0]?.source, "space");
    assert.isNotNull(hers.variables[0]?.grantId ?? null);
    // A loan is to a Space, not to a User: her Acme Threads do not receive it.
    const inAcme = yield* h.thread("thread:grace-acme", h.grace.id, h.acmeId, null);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inAcme, actingUserId: h.grace.id })),
      [],
    );
    // Ada does not even see her Thread there.
    assert.equal(
      yield* reasonOf(h.effective.threadEnvironment({ threadId: mine }).pipe(h.as(h.ada.id))),
      "not-found",
    );
    const shown = yield* h.effective.threadEnvironment({ threadId: mine }).pipe(h.as(h.grace.id));
    assert.deepEqual(h.names(shown), ["GRACE_TOKEN"]);
    assert.deepEqual(
      shown.vaults.map((vault) => [vault.name, vault.lent ?? false]),
      [
        ["default", false],
        ["Grace's tokens", true],
      ],
    );
    // Only names: no value, no value id, no Grant id, in what the client is shown.
    const text = JSON.stringify(shown);
    assert.isFalse(VALUES.some((value) => text.includes(value)));
    assert.notInclude(text, "valueId");
    assert.notInclude(text, hers.variables[0]!.valueId ?? "no value id");
  }),
);

it.effect("names resolve Project, then Space defaults in their order; lent ones after own", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("Acme first", [
      ["SHARED", VALUES[0]!],
      ["ONLY_FIRST", "only-in-first-0001"],
    ]);
    const second = yield* h.ownersVault("Acme second", [["SHARED", VALUES[1]!]]);
    const extra = yield* h.ownersVault("Acme extra", [["SHARED", "project-added-0003"]]);
    const acmesOwn = yield* h.ownersVault("Acme tools", [["SHARED", "acmes-own-0004"]], h.acmeId);
    for (const vaultId of [first, second, extra]) {
      yield* h.lend(vaultId, h.acmeId);
    }
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    const graces = yield* h.thread("thread:grace-web", h.grace.id, h.acmeId, web);

    // The Admin sets the defaults; the first in the list wins a shared name.
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [second, first] })
      .pipe(h.as(h.ada.id));
    let set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "SHARED"), "Acme second");
    assert.deepEqual(
      set.variables
        .find((variable) => variable.name === "SHARED")
        ?.shadowed.map((s) => s.vaultName),
      ["Acme first"],
    );
    assert.deepEqual(h.names(set), ["ONLY_FIRST", "SHARED"]);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [first, second] })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "SHARED"), "Acme first");

    // The Project's add beats the defaults; among adds, Acme's own beats a lent one.
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: extra, choice: "add" })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "SHARED"), "Acme extra");
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: acmesOwn, choice: "add" })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "SHARED"), "Acme tools");
    assert.deepEqual(
      set.vaults.map((vault) => [vault.name, vault.source, vault.grantId !== null]),
      [
        ["Acme tools", "project", false],
        ["Acme extra", "project", true],
        // Acme's `default`: a fixed default, before the chosen ones.
        ["default", "space", false],
        ["Acme first", "space", true],
        ["Acme second", "space", true],
      ],
    );
    // The Space lists its own groups first, then the lent ones by when they were lent.
    const choices = yield* h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ada.id));
    assert.deepEqual(
      choices.allowed.map((option) => [option.name, option.lent !== undefined]),
      [
        ["default", false],
        ["Acme tools", false],
        ["Acme first", true],
        ["Acme second", true],
        ["Acme extra", true],
      ],
    );
  }),
);

it.effect("a Project removes a default and inherits it back; a Member chooses nothing", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("Acme first", [["FIRST", VALUES[0]!]]);
    const acmeOwn = yield* h.ownersVault("Acme own", [["ACME_OWN", VALUES[1]!]], h.acmeId);
    yield* h.lend(first, h.acmeId);
    // An Organization's own Vault reaches it without a loan.
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [first, acmeOwn] })
      .pipe(h.as(h.ownerId));
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    const thread = yield* h.thread("thread:linus-web", h.linus.id, h.acmeId, web);
    // A Guest's Thread receives the defaults (decided 2026-11-11).
    let set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.linus.id });
    assert.deepEqual(h.names(set), ["ACME_OWN", "FIRST"]);

    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: first, choice: "remove" })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.linus.id });
    assert.deepEqual(h.names(set), ["ACME_OWN"]);
    const choices = yield* h.vaults
      .choices({ spaceId: h.acmeId, projectId: web })
      .pipe(h.as(h.grace.id));
    assert.isFalse(choices.canChoose);
    assert.deepEqual(choices.projectChoices, [{ vaultId: first, choice: "remove" }]);
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: first, choice: "inherit" })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.linus.id });
    assert.deepEqual(h.names(set), ["ACME_OWN", "FIRST"]);

    for (const who of [h.grace.id, h.linus.id, h.gus.id]) {
      assert.oneOf(
        yield* reasonOf(
          h.vaults.setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [] }).pipe(h.as(who)),
        ),
        ["forbidden", "not-found"],
        `${who} changed Acme's defaults`,
      );
      assert.oneOf(
        yield* reasonOf(
          h.vaults
            .setProjectChoice({ projectId: web, vaultId: first, choice: "remove" })
            .pipe(h.as(who)),
        ),
        ["forbidden", "not-found"],
        `${who} changed the Project's Vaults`,
      );
    }
    // Every default set and every add or remove is audited, by whom and on which Vault.
    const chosen = yield* h.server.sql<{
      readonly actor_user_id: string;
      readonly target_name: string;
      readonly detail_json: string;
    }>`
      SELECT actor_user_id, target_name, detail_json FROM audit_log
      WHERE action = 'vault.choose' ORDER BY audit_id
    `;
    assert.deepEqual(
      chosen.map((row) => [row.actor_user_id, row.target_name, JSON.parse(row.detail_json)]),
      [
        [h.ownerId, "Acme first", { scope: "space", choice: "default", position: 0 }],
        [h.ownerId, "Acme own", { scope: "space", choice: "default", position: 1 }],
        ["ada", "Acme first", { scope: "project", projectId: web, choice: "remove" }],
        ["ada", "Acme first", { scope: "project", projectId: web, choice: "inherit" }],
      ],
    );
    // An agent bound to Globex sees nothing of Acme's.
    assert.equal(
      yield* reasonOf(
        h.effective.threadEnvironment({ threadId: thread }).pipe(h.as(h.ownerId, h.globexId)),
      ),
      "not-found",
    );
    assert.oneOf(
      yield* reasonOf(h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ownerId, h.globexId))),
      ["forbidden", "not-found"],
    );
  }),
);

it.effect("the Owner's `default` is a fixed default of the Owner's Personal space alone", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    yield* h.vaults
      .putEntry({
        vaultId: h.main,
        name: "MAIN_TOKEN",
        value: Redacted.make("main-token-value-9"),
      })
      .pipe(h.as(h.ownerId));
    const personal = SpaceId.make(`personal:${h.ownerId}`);
    const notes = yield* h.thread("thread:owner-notes", h.ownerId, personal, null);
    const inAcme = yield* h.thread("thread:owner-acme", h.ownerId, h.acmeId, null);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: notes, actingUserId: h.ownerId })),
      ["MAIN_TOKEN"],
    );
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inAcme, actingUserId: h.ownerId })),
      [],
    );
    // A loan row naming a `default` (never given by Grants) reaches nothing either.
    yield* h.lend(h.main, h.acmeId);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inAcme, actingUserId: h.ownerId })),
      [],
    );
    assert.equal(
      yield* reasonOf(
        h.vaults.setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [h.main] }).pipe(h.as(h.ownerId)),
      ),
      "not-allowed",
    );
    const mine = yield* h.vaults.choices({ spaceId: personal }).pipe(h.as(h.ownerId));
    assert.deepEqual(mine.fixedDefaults, [h.main]);
  }),
);

it.effect("revoking a loan, archiving or a lost Membership stops delivery at the next call", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    const tools = yield* h.ownersVault("Tools", [["TOOLS_TOKEN", VALUES[2]!]]);
    const loan = yield* h.lend(shared, h.acmeId);
    yield* h.lend(tools, h.acmeId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared, tools] })
      .pipe(h.as(h.ada.id));
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: shared, choice: "add" })
      .pipe(h.as(h.ada.id));
    const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
    const now = () =>
      h.effective
        .forThread({ threadId: thread, actingUserId: h.grace.id })
        .pipe(Effect.map(h.names));
    assert.deepEqual(yield* now(), ["SHARED_KEY", "TOOLS_TOKEN"]);

    // Names the Hub keeps for itself are never delivered, however they got in.
    yield* h.server.sql`
      INSERT INTO vault_entries (entry_id, group_id, name, kind, value_id, unmasked, version, created_at, updated_at)
      VALUES ('secret-planted', ${shared}, 'T3CODE_PLANTED', 'own', 'value-planted', 0, 1, '2026-01-01', '2026-01-01')
    `;
    assert.deepEqual(yield* now(), ["SHARED_KEY", "TOOLS_TOKEN"]);

    // Revoked: gone from the next call, and Acme's default and its Project's add of it with it.
    yield* h.revoke(loan);
    assert.deepEqual(yield* now(), ["TOOLS_TOKEN"]);
    const left = yield* h.server.sql<{ readonly n: number }>`
      SELECT (SELECT COUNT(*) FROM space_default_vaults WHERE group_id = ${shared})
        + (SELECT COUNT(*) FROM project_vault_choices WHERE group_id = ${shared}) AS n
    `;
    assert.equal(left[0]?.n, 0);
    // Lent again, it comes back unchosen: nothing is delivered until Acme picks it.
    yield* h.lend(shared, h.acmeId);
    assert.deepEqual(yield* now(), ["TOOLS_TOKEN"]);

    yield* h.vaults.update({ vaultId: tools, archived: true }).pipe(h.as(h.ownerId));
    assert.deepEqual(yield* now(), []);
    yield* h.vaults.update({ vaultId: tools, archived: false }).pipe(h.as(h.ownerId));
    assert.deepEqual(yield* now(), ["TOOLS_TOKEN"]);

    // Out of Acme: nothing of hers runs there, so nothing is computed for her there.
    const removed = yield* h.server.request(`/api/spaces/${h.acmeId}/members/remove`, {
      body: { userId: h.grace.id },
      cookie: h.owner,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(
      yield* reasonOf(h.effective.forThread({ threadId: thread, actingUserId: h.grace.id })),
      "forbidden",
    );
  }),
);

it.effect("pending, rejected, cancelled and ended loans give nothing", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    const loan = yield* h.lend(shared, h.acmeId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
      .pipe(h.as(h.ada.id));
    const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
    for (const [state, endReason] of [
      ["pending", null],
      ["rejected", null],
      ["cancelled", null],
      ["ended", "revoked"],
    ] as const) {
      yield* h.server.sql`
        UPDATE grants SET state = ${state}, end_reason = ${endReason} WHERE grant_id = ${loan}
      `;
      const set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
      assert.deepEqual(h.names(set), [], state);
      const choices = yield* h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ada.id));
      assert.notInclude(
        choices.allowed.map((option) => option.vaultId),
        shared,
        state,
      );
    }
  }),
);

it.effect("a lent group's dangerous names never reach the borrower, whoever wrote them", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    // Even the Owner's own dangerous name, which the Owner's own Space would receive.
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    yield* h.vaults
      .putEntry({
        vaultId: shared,
        name: "NODE_OPTIONS",
        value: Redacted.make("--require ./lender-hook.js"),
        confirmDangerous: true,
      })
      .pipe(h.as(h.ownerId));
    // Acme's own group defines the same name: it still wins, from Acme's side.
    const acmeOwn = yield* h.ownersVault("Acme own", [], h.acmeId);
    yield* h.server.sql`
      INSERT INTO vault_entries (entry_id, group_id, name, kind, value_id, unmasked, version,
        created_at, updated_at, updated_by)
      VALUES ('secret-acme-node', ${acmeOwn}, 'NODE_OPTIONS', 'own', 'value-acme-node', 0, 1,
        '2026-01-01', '2026-01-01', ${h.ownerId})
    `;
    yield* h.lend(shared, h.acmeId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
      .pipe(h.as(h.ada.id));
    const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
    let set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
    assert.deepEqual(h.names(set), ["SHARED_KEY"]);
    assert.deepEqual(set.withheld, [
      { name: "NODE_OPTIONS", vaultId: shared, vaultName: "Shared", reason: "lent-dangerous" },
    ]);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared, acmeOwn] })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "NODE_OPTIONS"), "Acme own");
    // The panel says why it is not delivered, by name.
    const shown = yield* h.effective.threadEnvironment({ threadId: thread }).pipe(h.as(h.grace.id));
    assert.deepEqual(
      (shown.withheld ?? []).map((item) => [item.name, item.reason]),
      [["NODE_OPTIONS", "lent-dangerous"]],
    );
    assert.notInclude(JSON.stringify(shown), "lender-hook");
    // The Owner's own Personal space still receives the Owner's dangerous name.
    const personal = SpaceId.make(`personal:${h.ownerId}`);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: personal, vaultIds: [shared] })
      .pipe(h.as(h.ownerId));
    const notes = yield* h.thread("thread:owner-notes", h.ownerId, personal, null);
    const own = yield* h.effective.forThread({ threadId: notes, actingUserId: h.ownerId });
    assert.deepEqual(h.names(own), ["NODE_OPTIONS", "SHARED_KEY"]);
    assert.deepEqual(own.withheld, []);
  }),
);

it.effect("on a machine lent to the Space, lent groups give only that machine's owner's own", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    const acmeOwn = yield* h.ownersVault("Acme own", [["ACME_OWN", VALUES[1]!]], h.acmeId);
    // Ada's own group, lent to Acme by Ada.
    const adas = yield* h.vaults
      .create({ name: "Ada's", owner: userOwner(h.ada.id) })
      .pipe(h.as(h.ada.id));
    yield* h.vaults
      .putEntry({ vaultId: adas.id, name: "ADA_KEY", value: Redacted.make("adas-key-0005") })
      .pipe(h.as(h.ada.id));
    yield* h.lend(shared, h.acmeId);
    yield* h.lend(adas.id, h.acmeId, { kind: "user", id: h.ada.id });
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared, adas.id, acmeOwn] })
      .pipe(h.as(h.ada.id));
    const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
    const on = (ownerUserId: UserId | null) =>
      h.effective.forThread({
        threadId: thread,
        actingUserId: h.grace.id,
        lentMachine: { ownerUserId },
      });
    // Ada's machine lent to Acme: Ada's group goes there, the Owner's does not; Acme's own does.
    let set = yield* on(h.ada.id);
    assert.deepEqual(h.names(set), ["ACME_OWN", "ADA_KEY"]);
    assert.deepEqual(
      set.withheld.map((item) => [item.name, item.reason]),
      [["SHARED_KEY", "lent-machine"]],
    );
    // A machine whose owner is gone: no lent group at all.
    set = yield* on(null);
    assert.deepEqual(h.names(set), ["ACME_OWN"]);
    // Anywhere else, all of them.
    set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
    assert.deepEqual(h.names(set), ["ACME_OWN", "ADA_KEY", "SHARED_KEY"]);
  }),
);

it.effect("a Project moved to another Space receives only the destination's Vaults", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const acmeOnly = yield* h.ownersVault("Acme only", [["ACME_ONLY", VALUES[0]!]]);
    const globexDefault = yield* h.ownersVault("Globex default", [["GLOBEX_DEFAULT", VALUES[1]!]]);
    yield* h.lend(acmeOnly, h.acmeId);
    yield* h.lend(globexDefault, h.globexId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.globexId, vaultIds: [globexDefault] })
      .pipe(h.as(h.ownerId));
    const web = yield* h.project(h.owner, "acme-web", h.acmeId);
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: acmeOnly, choice: "add" })
      .pipe(h.as(h.ownerId));
    const thread = yield* h.thread("thread:owner-web", h.ownerId, h.acmeId, web);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId })),
      ["ACME_ONLY"],
    );
    // The move restamps the Project and its Threads (spec 3 ticket 12); the choice stays behind.
    yield* h.server
      .sql`UPDATE projection_projects SET space_id = ${h.globexId} WHERE project_id = ${web}`;
    yield* h.server
      .sql`UPDATE orchestration_v2_projection_threads SET space_id = ${h.globexId} WHERE project_id = ${web}`;
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId })),
      ["GLOBEX_DEFAULT"],
    );
  }),
);

// Review of ticket 03.

it.effect("an archived default can stay or be dropped; no new archived default is added", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("First", [["FIRST", VALUES[0]!]]);
    const second = yield* h.ownersVault("Second", [["SECOND", VALUES[1]!]]);
    const third = yield* h.ownersVault("Third", [["THIRD", VALUES[2]!]]);
    for (const vaultId of [first, second, third]) {
      yield* h.lend(vaultId, h.acmeId);
    }
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [first, second] })
      .pipe(h.as(h.ada.id));
    yield* h.vaults.update({ vaultId: first, archived: true }).pipe(h.as(h.ownerId));
    yield* h.vaults.update({ vaultId: third, archived: true }).pipe(h.as(h.ownerId));
    // Unchecking another default sends the archived one along: the save goes through.
    let chosen = yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [first] })
      .pipe(h.as(h.ada.id));
    assert.deepEqual(chosen.defaults, [first]);
    chosen = yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [] })
      .pipe(h.as(h.ada.id));
    assert.deepEqual(chosen.defaults, []);
    assert.equal(
      yield* reasonOf(
        h.vaults.setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [third] }).pipe(h.as(h.ada.id)),
      ),
      "not-allowed",
    );
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    assert.equal(
      yield* reasonOf(
        h.vaults
          .setProjectChoice({ projectId: web, vaultId: third, choice: "add" })
          .pipe(h.as(h.ada.id)),
      ),
      "not-allowed",
    );
  }),
);

it.effect(
  "the Owner's named groups reach the Owner's Personal space without a loan, chosen there",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const mine = yield* h.ownersVault("Mine", [["MINE", VALUES[0]!]]);
      const personal = SpaceId.make(`personal:${h.ownerId}`);
      const notes = yield* h.project(h.owner, "notes", personal);
      // A Project from before Spaces: no Space stamped, so it is the Owner's Personal space's.
      yield* h.server
        .sql`UPDATE projection_projects SET space_id = NULL WHERE project_id = ${notes}`;
      const thread = yield* h.thread("thread:notes-mine", h.ownerId, personal, notes);
      // Reaching it is not receiving it: only once chosen.
      assert.deepEqual(
        h.names(yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId })),
        [],
      );
      yield* h.vaults
        .setProjectChoice({ projectId: notes, vaultId: mine, choice: "add" })
        .pipe(h.as(h.ownerId));
      assert.deepEqual(
        h.names(yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId })),
        ["MINE"],
      );
    }),
);

it.effect("a Project never removes the Owner's `default` from the Owner's Personal space", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    yield* h.vaults
      .putEntry({
        vaultId: h.main,
        name: "MAIN_TOKEN",
        value: Redacted.make("main-token-value-9"),
      })
      .pipe(h.as(h.ownerId));
    const personal = SpaceId.make(`personal:${h.ownerId}`);
    const notes = yield* h.project(h.owner, "notes", personal);
    assert.equal(
      yield* reasonOf(
        h.vaults
          .setProjectChoice({ projectId: notes, vaultId: h.main, choice: "remove" })
          .pipe(h.as(h.ownerId)),
      ),
      "not-allowed",
    );
    // A removal planted anyway changes nothing.
    yield* h.server.sql`
      INSERT INTO project_vault_choices (project_id, group_id, choice) VALUES (${notes}, ${h.main}, 'remove')
    `;
    const thread = yield* h.thread("thread:notes", h.ownerId, personal, notes);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId })),
      ["MAIN_TOKEN"],
    );
  }),
);

it.effect("the Space's choices list names only to whoever may see each Vault", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    yield* h.lend(shared, h.acmeId);
    const toAda = yield* h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ada.id));
    // Acme's (empty) `default` first, then the Owner's group lent to it.
    assert.deepEqual(
      toAda.allowed.map((option) => [option.name, option.names]),
      [
        ["default", []],
        ["Shared", ["SHARED_KEY"]],
      ],
    );
    // Globex's Admin does not see Acme at all.
    assert.oneOf(yield* reasonOf(h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.gus.id))), [
      "forbidden",
      "not-found",
    ]);
  }),
);

it.effect("the acting User comes from the session, never from the request or an agent", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const [graces] = yield* h.server.sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM vault_groups
      WHERE owner_kind = 'user' AND owner_id = ${h.grace.id} AND is_default = 1
    `;
    yield* h.vaults
      .putEntry({
        vaultId: VaultGroupId.make(graces!.groupId),
        name: "GRACE_TOKEN",
        value: Redacted.make(VALUES[2]!),
      })
      .pipe(h.as(h.grace.id));
    const personal = SpaceId.make(`personal:${h.grace.id}`);
    const thread = yield* h.thread("thread:grace-own", h.grace.id, personal, null);
    // The wire input has no User: an extra field is dropped when decoded.
    const decoded = yield* decodeThreadEnvironmentInput({
      threadId: thread,
      actingUserId: h.grace.id,
    });
    assert.deepEqual(Object.keys(decoded), ["threadId"]);
    // Ada's agent (an MCP call bound to Acme) asking with Grace's id is still Ada: no such Thread.
    const agentOfAda = CommandActor.actAsResolved({
      _tag: "User",
      userId: h.ada.id,
      via: "agent",
      spaceLimit: h.acmeId,
    });
    assert.equal(
      yield* reasonOf(
        h.effective
          .threadEnvironment({ threadId: thread, actingUserId: h.grace.id } as never)
          .pipe(agentOfAda),
      ),
      "not-found",
    );
  }),
);

it.effect("a credential bound to Globex gets nothing from Acme, even for the same User", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    yield* h.lend(shared, h.acmeId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
      .pipe(h.as(h.ownerId));
    yield* joinOrganization(h.server, h.globexId, "grace", "member");
    yield* h.directory.membershipsChanged([h.grace.id]);
    const thread = yield* h.thread("thread:grace-acme", h.grace.id, h.acmeId, null);
    assert.deepEqual(
      h.names(yield* h.effective.threadEnvironment({ threadId: thread }).pipe(h.as(h.grace.id))),
      ["SHARED_KEY"],
    );
    assert.equal(
      yield* reasonOf(
        h.effective.threadEnvironment({ threadId: thread }).pipe(h.as(h.grace.id, h.globexId)),
      ),
      "not-found",
    );
    assert.equal(
      yield* reasonOf(
        h.effective
          .forThread({ threadId: thread, actingUserId: h.grace.id })
          .pipe(h.as(h.grace.id, h.globexId)),
      ),
      "forbidden",
    );
  }),
);

it.effect("names are checked again when the set is computed, whoever wrote them", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    // Acme's own group: a lent one never delivers a dangerous name at all.
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]], h.acmeId);
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
      .pipe(h.as(h.ownerId));
    yield* h.server.sql`
      INSERT INTO vault_entries (entry_id, group_id, name, kind, value_id, unmasked, version, created_at, updated_at)
      VALUES
        ('secret-gateway', ${shared}, 'ANTHROPIC_BASE_URL', 'own', 'value-gateway', 0, 1, '2026-01-01', '2026-01-01'),
        ('secret-lower', ${shared}, 'lower_case', 'own', 'value-lower', 0, 1, '2026-01-01', '2026-01-01'),
        ('secret-danger', ${shared}, 'GIT_SSH_COMMAND', 'own', 'value-danger', 0, 1, '2026-01-01', '2026-01-01')
    `;
    const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
    const set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
    assert.deepEqual(h.names(set), ["GIT_SSH_COMMAND", "SHARED_KEY"]);
    assert.isTrue(set.variables.find((variable) => variable.name === "GIT_SSH_COMMAND")?.dangerous);
    assert.isFalse(set.variables.find((variable) => variable.name === "SHARED_KEY")?.dangerous);
  }),
);

// Owned-resources 04: every User's own Vault reaches their Personal space alone.

it.effect("a User's own `default` reaches their Personal space, never an Organization's", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const [mine] = yield* h.server.sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM vault_groups
      WHERE owner_kind = 'user' AND owner_id = ${h.grace.id} AND is_default = 1
    `;
    yield* h.vaults
      .putEntry({
        vaultId: VaultGroupId.make(mine!.groupId),
        name: "GRACE_OWN",
        value: Redacted.make("graces-personal-value-7"),
      })
      .pipe(h.as(h.grace.id));
    const personal = SpaceId.make(`personal:${h.grace.id}`);
    const inPersonal = yield* h.thread("thread:grace-personal", h.grace.id, personal, null);
    const inAcme = yield* h.thread("thread:grace-acme", h.grace.id, h.acmeId, null);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inPersonal, actingUserId: h.grace.id })),
      ["GRACE_OWN"],
    );
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inAcme, actingUserId: h.grace.id })),
      [],
    );
    // Nor can anyone else's choice bring it into Acme.
    assert.equal(
      yield* reasonOf(
        h.vaults
          .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [VaultGroupId.make(mine!.groupId)] })
          .pipe(h.as(h.ada.id)),
      ),
      "not-allowed",
    );
    // She chooses her Personal space's groups; the Owner only reads them.
    const choices = yield* h.vaults.choices({ spaceId: personal }).pipe(h.as(h.grace.id));
    assert.isTrue(choices.canChoose);
    assert.deepEqual(choices.fixedDefaults, [VaultGroupId.make(mine!.groupId)]);
    assert.equal(
      yield* reasonOf(
        h.vaults.setSpaceDefaults({ spaceId: personal, vaultIds: [] }).pipe(h.as(h.ownerId)),
      ),
      "forbidden",
    );
  }),
);

// Owned-resources 05: a Thread's «Secrets» panel shows Variables with their value.

it.effect(
  "a Thread's panel shows a Variable's value to whoever may read it, never a Secret's",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const config = yield* h.ownersVault("Acme config", [], h.acmeId);
      yield* h.vaults
        .putEntry({
          vaultId: config,
          name: "REGION",
          value: Redacted.make("eu-west-1"),
          class: "variable",
        })
        .pipe(h.as(h.ada.id));
      yield* h.vaults
        .putEntry({ vaultId: config, name: "API_KEY", value: Redacted.make(VALUES[0]!) })
        .pipe(h.as(h.ada.id));
      yield* h.vaults
        .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [config] })
        .pipe(h.as(h.ada.id));
      const panel = (userId: UserId, threadId: ThreadId) =>
        h.effective.threadEnvironment({ threadId }, { variableValue: h.vaults.variableValue }).pipe(
          h.as(userId),
          Effect.map((shown) =>
            Object.fromEntries(
              shown.variables.map((variable) => [variable.name, variable.value ?? null]),
            ),
          ),
        );
      const graces = yield* h.thread("thread:grace-config", h.grace.id, h.acmeId, null);
      assert.deepEqual(yield* panel(h.grace.id, graces), { API_KEY: null, REGION: "eu-west-1" });
      // A Guest reads names only (decision 4 of «Variables y Secrets sellados»).
      const linus = yield* h.thread("thread:linus-config", h.linus.id, h.acmeId, null);
      assert.deepEqual(yield* panel(h.linus.id, linus), { API_KEY: null, REGION: null });
      // Without Vaults' reader, names only.
      const bare = yield* h.effective
        .threadEnvironment({ threadId: graces })
        .pipe(h.as(h.grace.id));
      assert.isTrue(bare.variables.every((variable) => !("value" in variable)));
      assert.isFalse(VALUES.some((value) => JSON.stringify(bare).includes(value)));
    }),
);
