/**
 * Allowing Vaults and the effective set of a Thread (spec 5 «Vaults», ticket 03). The Owner;
 * Ada (Admin), Grace (Member) and Linus (Guest) of Acme; Gus (Admin) of Globex. What a turn,
 * terminal or script receives is EffectiveVaults' alone: names and value ids, never values.
 */
import {
  MAIN_VAULT_ID,
  ProjectId,
  SpaceId,
  ThreadId,
  UserId,
  type VaultError,
  VaultThreadEnvironmentInput,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";
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
    const made = yield* vaults.create({ name, spaceId }).pipe(as(ownerId));
    for (const [variable, value] of secrets) {
      yield* vaults
        .putEntry({ vaultId: made.id, name: variable, value: Redacted.make(value) })
        .pipe(as(ownerId));
    }
    return made.id;
  });
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
    names,
    winner,
  };
});

const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const space = (spaceId: SpaceId) => ({ kind: "space" as const, spaceId });
const user = (userId: UserId) => ({ kind: "user" as const, userId });

it.effect("a Vault allowed only to Globex never reaches an Acme Thread, by any path", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const globexOnly = yield* h.ownersVault("Globex keys", [["GLOBEX_KEY", "globex-key-value-1"]]);
    yield* h.vaults
      .allow({ vaultId: globexOnly, subject: space(h.globexId), allowed: true })
      .pipe(h.as(h.ownerId));
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
      INSERT INTO project_vault_choices (project_id, vault_id, choice) VALUES (${web}, ${globexOnly}, 'add')
    `;
    yield* h.server.sql`
      INSERT INTO space_default_vaults (space_id, vault_id, position) VALUES (${h.acmeId}, ${globexOnly}, 0)
    `;
    const set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.deepEqual(h.names(set), []);
    assert.deepEqual(set.vaults, []);
    // Globex's own Threads do get it.
    const gusThread = yield* h.thread("thread:gus", h.gus.id, h.globexId, null);
    const inGlobex = yield* h.effective.forThread({ threadId: gusThread, actingUserId: h.gus.id });
    assert.deepEqual(h.names(inGlobex), ["GLOBEX_KEY"]);
  }),
);

it.effect("a Vault allowed to Grace reaches her turns only, never Ada's in the same Thread", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const gracesVault = yield* h.ownersVault("Grace's tokens", [["GRACE_TOKEN", VALUES[2]!]]);
    yield* h.vaults
      .allow({ vaultId: gracesVault, subject: user(h.grace.id), allowed: true })
      .pipe(h.as(h.ownerId));
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    const thread = yield* h.thread("thread:shared", h.grace.id, h.acmeId, web);

    const hers = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
    assert.deepEqual(h.names(hers), ["GRACE_TOKEN"]);
    assert.equal(hers.variables[0]?.source, "user");
    const adas = yield* h.effective.forThread({ threadId: thread, actingUserId: h.ada.id });
    assert.deepEqual(h.names(adas), []);
    const owners = yield* h.effective.forThread({ threadId: thread, actingUserId: h.ownerId });
    assert.deepEqual(h.names(owners), []);

    // What each one is shown is computed for them, in the same Thread.
    const shownToGrace = yield* h.effective
      .threadEnvironment({ threadId: thread })
      .pipe(h.as(h.grace.id));
    assert.deepEqual(h.names(shownToGrace), ["GRACE_TOKEN"]);
    const shownToAda = yield* h.effective
      .threadEnvironment({ threadId: thread })
      .pipe(h.as(h.ada.id));
    assert.deepEqual(h.names(shownToAda), []);
    // It follows her into any Space she works in, Globex included once she joins it.
    yield* joinOrganization(h.server, h.globexId, "grace", "member");
    yield* h.directory.membershipsChanged([h.grace.id]);
    const inGlobex = yield* h.thread("thread:grace-globex", h.grace.id, h.globexId, null);
    assert.deepEqual(
      h.names(yield* h.effective.forThread({ threadId: inGlobex, actingUserId: h.grace.id })),
      ["GRACE_TOKEN"],
    );

    // Only names: no value, no value id, in what the client is shown.
    const shown = JSON.stringify(shownToGrace);
    assert.isFalse(VALUES.some((value) => shown.includes(value)));
    assert.notInclude(shown, "valueId");
    assert.notInclude(shown, hers.variables[0]!.valueId ?? "no value id");
  }),
);

it.effect("names resolve User, then Project, then Space defaults in their order", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("Acme first", [
      ["SHARED", VALUES[0]!],
      ["ONLY_FIRST", "only-in-first-0001"],
    ]);
    const second = yield* h.ownersVault("Acme second", [["SHARED", VALUES[1]!]]);
    const extra = yield* h.ownersVault("Acme extra", [["SHARED", "project-added-0003"]]);
    const mine = yield* h.ownersVault("Ada's", [["SHARED", "adas-own-value-0004"]]);
    for (const vaultId of [first, second, extra]) {
      yield* h.vaults
        .allow({ vaultId, subject: space(h.acmeId), allowed: true })
        .pipe(h.as(h.ownerId));
    }
    yield* h.vaults
      .allow({ vaultId: mine, subject: user(h.ada.id), allowed: true })
      .pipe(h.as(h.ownerId));
    const web = yield* h.project(h.ada.cookie, "acme-web", h.acmeId);
    const thread = yield* h.thread("thread:ada-web", h.ada.id, h.acmeId, web);
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

    // The Project's add beats the defaults; the User's own beats both.
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: extra, choice: "add" })
      .pipe(h.as(h.ada.id));
    set = yield* h.effective.forThread({ threadId: graces, actingUserId: h.grace.id });
    assert.equal(h.winner(set, "SHARED"), "Acme extra");
    set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.ada.id });
    assert.equal(h.winner(set, "SHARED"), "Ada's");
    assert.deepEqual(
      set.variables
        .find((variable) => variable.name === "SHARED")
        ?.shadowed.map((s) => [s.vaultName, s.source]),
      [
        ["Acme extra", "project"],
        ["Acme first", "space"],
        ["Acme second", "space"],
      ],
    );
    assert.deepEqual(
      set.vaults.map((vault) => [vault.name, vault.source]),
      [
        ["Ada's", "user"],
        ["Acme extra", "project"],
        ["Acme first", "space"],
        ["Acme second", "space"],
      ],
    );
  }),
);

it.effect("a Project removes a default and inherits it back; a Member chooses nothing", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("Acme first", [["FIRST", VALUES[0]!]]);
    const acmeOwn = yield* h.ownersVault("Acme own", [["ACME_OWN", VALUES[1]!]], h.acmeId);
    yield* h.vaults
      .allow({ vaultId: first, subject: space(h.acmeId), allowed: true })
      .pipe(h.as(h.ownerId));
    // An Organization's own Vault is allowed to it without an allowance.
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

it.effect(
  "only the Owner allows; the Main vault and Organizations' Vaults stay where they are",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const owners = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
      const acmeOwn = yield* h.ownersVault("Acme own", [["ACME_OWN", VALUES[1]!]], h.acmeId);
      for (const who of [h.ada.id, h.grace.id, h.linus.id, h.gus.id]) {
        assert.oneOf(
          yield* reasonOf(
            h.vaults
              .allow({ vaultId: owners, subject: space(h.acmeId), allowed: true })
              .pipe(h.as(who)),
          ),
          ["forbidden", "not-found"],
        );
      }
      assert.equal(
        yield* reasonOf(
          h.vaults
            .allow({ vaultId: MAIN_VAULT_ID, subject: space(h.acmeId), allowed: true })
            .pipe(h.as(h.ownerId)),
        ),
        "main-vault",
      );
      assert.equal(
        yield* reasonOf(
          h.vaults
            .allow({ vaultId: MAIN_VAULT_ID, subject: user(h.ada.id), allowed: true })
            .pipe(h.as(h.ownerId)),
        ),
        "main-vault",
      );
      for (const subject of [space(h.globexId), user(h.gus.id)]) {
        assert.equal(
          yield* reasonOf(
            h.vaults.allow({ vaultId: acmeOwn, subject, allowed: true }).pipe(h.as(h.ownerId)),
          ),
          "not-allowed",
        );
      }
      assert.equal(
        yield* reasonOf(
          h.vaults
            .allow({ vaultId: owners, subject: space(SpaceId.make("org-missing")), allowed: true })
            .pipe(h.as(h.ownerId)),
        ),
        "not-found",
      );
      // The Main vault is a fixed default of the Owner's Personal space, and of no other.
      yield* h.vaults
        .putEntry({
          vaultId: MAIN_VAULT_ID,
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
      assert.equal(
        yield* reasonOf(
          h.vaults
            .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [MAIN_VAULT_ID] })
            .pipe(h.as(h.ownerId)),
        ),
        "not-allowed",
      );
      const mine = yield* h.vaults.choices({ spaceId: personal }).pipe(h.as(h.ownerId));
      assert.deepEqual(mine.fixedDefaults, [MAIN_VAULT_ID]);

      // Allowing and taking back are audited, never with a value.
      yield* h.vaults
        .allow({ vaultId: owners, subject: user(h.grace.id), allowed: true })
        .pipe(h.as(h.ownerId));
      const listed = yield* h.vaults.list.pipe(h.as(h.ownerId));
      assert.deepEqual(listed.vaults.find((vault) => vault.id === owners)?.allowances, [
        { subject: user(h.grace.id), name: "grace" },
      ]);
      // Others are not told whom a Vault reaches.
      const gracesList = yield* h.vaults.list.pipe(h.as(h.grace.id));
      assert.deepEqual(gracesList.vaults.find((vault) => vault.id === owners)?.allowances, []);
      yield* h.vaults
        .allow({ vaultId: owners, subject: user(h.grace.id), allowed: false })
        .pipe(h.as(h.ownerId));
      const audited = yield* h.server.sql<{
        readonly action: string;
        readonly detail_json: string;
      }>`
      SELECT action, detail_json FROM audit_log WHERE action IN ('vault.allow', 'vault.choose') ORDER BY audit_id
    `;
      assert.deepEqual(
        audited.map((row) => [row.action, JSON.parse(row.detail_json)]),
        [
          [
            "vault.allow",
            { subjectKind: "user", subjectId: "grace", subjectName: "grace", allowed: true },
          ],
          [
            "vault.allow",
            { subjectKind: "user", subjectId: "grace", subjectName: "grace", allowed: false },
          ],
        ],
      );
      assert.isFalse(
        audited.some((row) => VALUES.some((value) => row.detail_json.includes(value))),
      );
    }),
);

it.effect(
  "taking back an allowance, archiving, a broken link or a lost Membership stops delivery",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
      const gracesVault = yield* h.ownersVault("Grace's", [["GRACE_TOKEN", VALUES[2]!]]);
      yield* h.vaults
        .allow({ vaultId: shared, subject: space(h.acmeId), allowed: true })
        .pipe(h.as(h.ownerId));
      yield* h.vaults
        .allow({ vaultId: gracesVault, subject: user(h.grace.id), allowed: true })
        .pipe(h.as(h.ownerId));
      yield* h.vaults
        .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
        .pipe(h.as(h.ada.id));
      const thread = yield* h.thread("thread:grace", h.grace.id, h.acmeId, null);
      const now = () =>
        h.effective
          .forThread({ threadId: thread, actingUserId: h.grace.id })
          .pipe(Effect.map(h.names));
      assert.deepEqual(yield* now(), ["GRACE_TOKEN", "SHARED_KEY"]);

      // A Secret link whose original goes is not delivered.
      const original = yield* h.vaults
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name: "LINKED",
          value: Redacted.make("linked-original-55"),
        })
        .pipe(h.as(h.ownerId));
      yield* h.vaults
        .linkEntry({ vaultId: shared, sourceEntryId: original.entry.id })
        .pipe(h.as(h.ownerId));
      assert.deepEqual(yield* now(), ["GRACE_TOKEN", "LINKED", "SHARED_KEY"]);
      const set = yield* h.effective.forThread({ threadId: thread, actingUserId: h.grace.id });
      const linked = set.variables.find((variable) => variable.name === "LINKED");
      const originalValue = yield* h.server.sql<{ readonly valueId: string }>`
      SELECT value_id AS "valueId" FROM vault_entries WHERE entry_id = ${original.entry.id}
    `;
      // A link's value id is its original's: a rotation reaches the next turn.
      assert.equal(linked?.valueId, originalValue[0]?.valueId);
      yield* h.vaults
        .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: original.entry.id, breakLinks: true })
        .pipe(h.as(h.ownerId));
      assert.deepEqual(yield* now(), ["GRACE_TOKEN", "SHARED_KEY"]);

      // Names the Hub keeps for itself are never delivered, however they got in.
      yield* h.server.sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, unmasked, version, created_at, updated_at)
      VALUES ('secret-planted', ${shared}, 'T3CODE_PLANTED', 'own', 'value-planted', 0, 1, '2026-01-01', '2026-01-01')
    `;
      assert.deepEqual(yield* now(), ["GRACE_TOKEN", "SHARED_KEY"]);

      yield* h.vaults
        .allow({ vaultId: shared, subject: space(h.acmeId), allowed: false })
        .pipe(h.as(h.ownerId));
      assert.deepEqual(yield* now(), ["GRACE_TOKEN"]);
      yield* h.vaults.update({ vaultId: gracesVault, archived: true }).pipe(h.as(h.ownerId));
      assert.deepEqual(yield* now(), []);
      yield* h.vaults.update({ vaultId: gracesVault, archived: false }).pipe(h.as(h.ownerId));
      assert.deepEqual(yield* now(), ["GRACE_TOKEN"]);

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

it.effect("a Project moved to another Space receives only the destination's Vaults", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const acmeOnly = yield* h.ownersVault("Acme only", [["ACME_ONLY", VALUES[0]!]]);
    const globexDefault = yield* h.ownersVault("Globex default", [["GLOBEX_DEFAULT", VALUES[1]!]]);
    yield* h.vaults
      .allow({ vaultId: acmeOnly, subject: space(h.acmeId), allowed: true })
      .pipe(h.as(h.ownerId));
    yield* h.vaults
      .allow({ vaultId: globexDefault, subject: space(h.globexId), allowed: true })
      .pipe(h.as(h.ownerId));
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

it.effect("an allowance whose Space or User is gone can still be taken back", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    const gone = SpaceId.make("org-gone");
    // Rows for a Space and a User that no longer exist (deleted after they were allowed).
    yield* h.server.sql`
      INSERT INTO vault_allowances (vault_id, subject_kind, subject_id, created_at)
      VALUES (${shared}, 'space', ${gone}, '2026-01-01'), (${shared}, 'user', 'ghost', '2026-01-01')
    `;
    yield* h.vaults
      .allow({ vaultId: shared, subject: space(gone), allowed: false })
      .pipe(h.as(h.ownerId));
    yield* h.vaults
      .allow({ vaultId: shared, subject: user(UserId.make("ghost")), allowed: false })
      .pipe(h.as(h.ownerId));
    const left = yield* h.server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM vault_allowances WHERE vault_id = ${shared}
    `;
    assert.equal(left[0]?.n, 0);
  }),
);

it.effect("an archived default can stay or be dropped; no new archived default is added", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const first = yield* h.ownersVault("First", [["FIRST", VALUES[0]!]]);
    const second = yield* h.ownersVault("Second", [["SECOND", VALUES[1]!]]);
    const third = yield* h.ownersVault("Third", [["THIRD", VALUES[2]!]]);
    for (const vaultId of [first, second, third]) {
      yield* h.vaults
        .allow({ vaultId, subject: space(h.acmeId), allowed: true })
        .pipe(h.as(h.ownerId));
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
  "taking a Vault back from the Owner's Personal space drops a legacy Project's choice",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const mine = yield* h.ownersVault("Mine", [["MINE", VALUES[0]!]]);
      const personal = SpaceId.make(`personal:${h.ownerId}`);
      yield* h.vaults
        .allow({ vaultId: mine, subject: space(personal), allowed: true })
        .pipe(h.as(h.ownerId));
      const notes = yield* h.project(h.owner, "notes", personal);
      // A Project from before Spaces: no Space stamped, so it is the Owner's Personal space's.
      yield* h.server
        .sql`UPDATE projection_projects SET space_id = NULL WHERE project_id = ${notes}`;
      yield* h.vaults
        .setProjectChoice({ projectId: notes, vaultId: mine, choice: "add" })
        .pipe(h.as(h.ownerId));
      yield* h.vaults
        .allow({ vaultId: mine, subject: space(personal), allowed: false })
        .pipe(h.as(h.ownerId));
      const left = yield* h.server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM project_vault_choices WHERE project_id = ${notes}
    `;
      assert.equal(left[0]?.n, 0);
    }),
);

it.effect("a Project never removes the Main vault from the Owner's Personal space", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    yield* h.vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        name: "MAIN_TOKEN",
        value: Redacted.make("main-token-value-9"),
      })
      .pipe(h.as(h.ownerId));
    const personal = SpaceId.make(`personal:${h.ownerId}`);
    const notes = yield* h.project(h.owner, "notes", personal);
    assert.equal(
      yield* reasonOf(
        h.vaults
          .setProjectChoice({ projectId: notes, vaultId: MAIN_VAULT_ID, choice: "remove" })
          .pipe(h.as(h.ownerId)),
      ),
      "not-allowed",
    );
    // A removal planted anyway changes nothing.
    yield* h.server.sql`
      INSERT INTO project_vault_choices (project_id, vault_id, choice) VALUES (${notes}, ${MAIN_VAULT_ID}, 'remove')
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
    yield* h.vaults
      .allow({ vaultId: shared, subject: space(h.acmeId), allowed: true })
      .pipe(h.as(h.ownerId));
    const toAda = yield* h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ada.id));
    assert.deepEqual(
      toAda.allowed.map((option) => option.names),
      [["SHARED_KEY"]],
    );
    // An agent bound to Acme does not see the Owner's own Vaults (vault.view), so not their names.
    const toAgent = yield* h.vaults.choices({ spaceId: h.acmeId }).pipe(h.as(h.ownerId, h.acmeId));
    assert.deepEqual(
      toAgent.allowed.map((option) => option.names),
      [[]],
    );
  }),
);

it.effect("the acting User comes from the session, never from the request or an agent", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const gracesVault = yield* h.ownersVault("Grace's", [["GRACE_TOKEN", VALUES[2]!]]);
    yield* h.vaults
      .allow({ vaultId: gracesVault, subject: user(h.grace.id), allowed: true })
      .pipe(h.as(h.ownerId));
    const thread = yield* h.thread("thread:shared", h.grace.id, h.acmeId, null);
    // The wire input has no User: an extra field is dropped when decoded.
    const decoded = yield* decodeThreadEnvironmentInput({
      threadId: thread,
      actingUserId: h.grace.id,
    });
    assert.deepEqual(Object.keys(decoded), ["threadId"]);
    // Ada's agent (an MCP call bound to Acme) asking with Grace's id still gets Ada's set.
    const agentOfAda = CommandActor.actAsResolved({
      _tag: "User",
      userId: h.ada.id,
      via: "agent",
      spaceLimit: h.acmeId,
    });
    const shown = yield* h.effective
      .threadEnvironment({ threadId: thread, actingUserId: h.grace.id } as never)
      .pipe(agentOfAda);
    assert.deepEqual(h.names(shown), []);
  }),
);

it.effect("a credential bound to Globex gets nothing from Acme, even for the same User", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    yield* h.vaults
      .allow({ vaultId: shared, subject: space(h.acmeId), allowed: true })
      .pipe(h.as(h.ownerId));
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
    const shared = yield* h.ownersVault("Shared", [["SHARED_KEY", VALUES[0]!]]);
    yield* h.vaults
      .allow({ vaultId: shared, subject: space(h.acmeId), allowed: true })
      .pipe(h.as(h.ownerId));
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [shared] })
      .pipe(h.as(h.ownerId));
    yield* h.server.sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, unmasked, version, created_at, updated_at)
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
