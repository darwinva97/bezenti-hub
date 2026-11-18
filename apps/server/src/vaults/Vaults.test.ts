/**
 * Vaults, their secrets and who may edit or read them (spec 5 «Vaults», ticket 02): the Owner,
 * an Admin, a Member and a Guest of Acme, and an Admin of Globex. A Secret's value never leaves the
 * Hub, not even to the Owner (owned-resources 01), and never reaches the database, the audit log, a
 * log or a span. Tests compare stored values as booleans, so no failure ever prints one.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the store's files and the database.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SpaceId, UserId, type VaultError, VaultGroupId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import * as CommandActor from "../auth/CommandActor.ts";
import * as SecretCipher from "../auth/SecretCipher.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  serveAuthHttpWith,
} from "../auth/UserAuth.testkit.ts";
import {
  FAKE_PROVIDER_ID,
  FAKE_PROVIDER_LABEL,
  makeFakeSecretProvider,
} from "./ProviderReads.testkit.ts";
import { lendVaultGroup } from "../grants/Grants.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultKeyCheck from "./VaultKeyCheck.ts";
import * as Vaults from "./Vaults.ts";

const REVEAL = "/api/vaults/reveal";
const BOGUS_REAUTH = { method: "password", password: "nope", totpCode: "000000" };
const ORIGINAL = "ghp_original_token_0001";
const ROTATED = "ghp_rotated_token_0002";
const ACME_OWN = "acme-own-secret-value-77";
const ADMIN_WRITES = "admin-wrote-this-value-99";
const ADMIN_REPLACES = "admin-replaced-value-42";
const VALUES = [ORIGINAL, ROTATED, ACME_OWN, ADMIN_WRITES, ADMIN_REPLACES];

/** The Hub of these tests; `identityIssuer` makes it a workload identity issuer (ticket 07). */
const hubWith = Effect.fn(function* (options: { readonly identityIssuer?: string } = {}) {
  const provider = makeFakeSecretProvider();
  const server = yield* serveAuthHttpWith({ providerReads: provider.options, ...options });
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
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
    // An Admin's rights need a passkey or an authenticator app.
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return { id: UserId.make(id), cookie };
  });
  const people = {
    admin: yield* person("ada", acmeId, "admin"),
    member: yield* person("grace", acmeId, "member"),
    guest: yield* person("linus", acmeId, "guest"),
    otherAdmin: yield* person("gus", globexId, "admin"),
  };
  // Joined behind the directory's back: it forgets what it read of them.
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged(
    Object.values(people).map((who) => who.id),
  );
  const vaults = Context.get(server.services, Vaults.Vaults);
  const store = Context.get(server.services, ServerSecretStore.ServerSecretStore);
  const valuesDir = NodePath.join(store.directory ?? "", "vault-values");
  /** The sealed file holding an entry's value now. */
  const valueFileOf = (entryId: string) =>
    server.sql<{ readonly valueId: string }>`
      SELECT value_id AS "valueId" FROM vault_entries WHERE entry_id = ${entryId}
    `.pipe(Effect.map((rows) => NodePath.join(valuesDir, `${rows[0]?.valueId}.sealed`)));
  const valueFiles = () => (NodeFS.existsSync(valuesDir) ? NodeFS.readdirSync(valuesDir) : []);
  const as =
    (userId: UserId, spaceLimit?: SpaceId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      spaceLimit === undefined
        ? CommandActor.actAs(userId)(effect)
        : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit })(effect);
  const reveal = (cookie: string, vaultId: string, entryId: string, reauth: unknown) =>
    server.request(REVEAL, { cookie, body: { vaultId, entryId, reauth } });
  const values = Context.get(server.services, ServerSecretStore.VaultValueStore);
  /** The value an entry delivers now, opened from the store. */
  const storedValue = (entryId: string) =>
    server.sql<{ readonly valueId: string | null }>`
      SELECT value_id AS "valueId" FROM vault_entries WHERE entry_id = ${entryId}
    `.pipe(
      Effect.flatMap((rows) => values.get(rows[0]?.valueId ?? "missing")),
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    );
  /** Whether an entry delivers `expected`: a boolean, so a failure never prints a value. */
  const holds = (entryId: string, expected: string) =>
    storedValue(entryId).pipe(
      Effect.map((found) => Option.isSome(found) && found.value === expected),
    );
  // The Owner's `default` group (owned-resources 03): the Main vault before.
  const [mainRow] = yield* server.sql<{ readonly groupId: string }>`
    SELECT group_id AS "groupId" FROM vault_groups
    WHERE owner_kind = 'user' AND owner_id = ${ownerId} AND is_default = 1
  `;
  const main = VaultGroupId.make(mainRow?.groupId ?? "missing");
  return {
    server,
    provider,
    authenticator,
    owner,
    ownerId,
    main,
    acmeId,
    globexId,
    people,
    vaults,
    store,
    valuesDir,
    valueFileOf,
    valueFiles,
    as,
    reveal,
    storedValue,
    holds,
  };
});

const hub = hubWith();

type Hub = Effect.Success<typeof hub>;

/** An Organization as a group's owner, or a User. */
const org = (spaceId: SpaceId) => ({ kind: "organization" as const, spaceId });
const mine = (userId: UserId) => ({ kind: "user" as const, userId });

/**
 * The Owner's setup: GITHUB_TOKEN in the Owner's `default`; «Acme secrets», a group of Acme, with
 * its own GITHUB_TOKEN and GITHUB_TOKEN_COPY (what a Secret link and a copy became) and its own.
 */
const acmeSecrets = Effect.fn(function* ({ vaults, as, ownerId, acmeId, main }: Hub) {
  const github = yield* vaults
    .putEntry({
      vaultId: main,
      name: "GITHUB_TOKEN",
      value: Redacted.make(ORIGINAL),
    })
    .pipe(as(ownerId));
  const acme = yield* vaults.create({ name: "Acme secrets", owner: org(acmeId) }).pipe(as(ownerId));
  const link = yield* vaults
    .putEntry({ vaultId: acme.id, name: "GITHUB_TOKEN", value: Redacted.make(ORIGINAL) })
    .pipe(as(ownerId));
  const copy = yield* vaults
    .putEntry({ vaultId: acme.id, name: "GITHUB_TOKEN_COPY", value: Redacted.make(ORIGINAL) })
    .pipe(as(ownerId));
  const own = yield* vaults
    .putEntry({
      vaultId: acme.id,
      name: "ACME_API_KEY",
      value: Redacted.make(ACME_OWN),
    })
    .pipe(as(ownerId));
  return { github: github.entry, acme, link: link.entry, copy: copy.entry, own: own.entry };
});

/** Drops an entry's sealed file: a read of it now fails, so an answer that is not a failure never read it. */
const dropValueFile = (setup: Hub, entryId: string) =>
  setup.valueFileOf(entryId).pipe(Effect.map((file) => NodeFS.rmSync(file)));

/** `op:type` of each `secret.edit` row of an entry (owned-resources 05). */
const auditTypes = (setup: Hub, name: string) =>
  setup.server.sql<{ readonly detail_json: string }>`
    SELECT detail_json FROM audit_log WHERE action = 'secret.edit' AND target_name = ${name}
    ORDER BY audit_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const detail = JSON.parse(row.detail_json) as { op: string; type?: string };
        return `${detail.op}:${detail.type ?? "none"}`;
      }),
    ),
  );

const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const mentionsAValue = (text: string) => VALUES.some((value) => text.includes(value));

it.effect("every owner has a `default` group nobody deletes, renames or archives", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people, acmeId } = setup;
    const listed = yield* vaults.list.pipe(as(ownerId));
    // The Owner's own first; then each Organization's `default`, and every User's, which the
    // Owner only reads (owned-resources 04).
    assert.equal(listed.groups[0]?.id, setup.main);
    assert.isTrue(listed.groups.every((group) => group.isDefault && group.name === "default"));
    assert.deepEqual(
      listed.groups
        .filter((group) => group.owner.kind === "organization")
        .map((group) => group.ownerName),
      ["Acme", "Globex"],
    );
    const others = listed.groups.filter(
      (group) => group.owner.kind === "user" && group.id !== setup.main,
    );
    assert.deepEqual(
      others.map((group) => [group.ownerName, group.canEdit, group.canManage]).toSorted(),
      [
        ["ada", false, false],
        ["grace", false, false],
        ["gus", false, false],
        ["linus", false, false],
      ],
    );
    const acmeDefault = listed.groups.find((group) => group.ownerName === "Acme")!;
    assert.deepEqual(acmeDefault.owner, { kind: "organization", spaceId: acmeId });
    for (const [who, group] of [
      [ownerId, setup.main],
      [ownerId, acmeDefault.id],
      [people.admin.id, acmeDefault.id],
    ] as const) {
      assert.equal(
        yield* reasonOf(vaults.remove({ vaultId: group }).pipe(as(who))),
        "default-group",
      );
      assert.equal(
        yield* reasonOf(vaults.update({ vaultId: group, name: "renamed" }).pipe(as(who))),
        "default-group",
      );
      assert.equal(
        yield* reasonOf(vaults.update({ vaultId: group, archived: true }).pipe(as(who))),
        "default-group",
      );
    }
    assert.isFalse(acmeDefault.canManage);
    // `default` is the default group's name alone.
    assert.equal(
      yield* reasonOf(vaults.create({ name: "Default", owner: org(acmeId) }).pipe(as(ownerId))),
      "duplicate-name",
    );
    // The Owner's `default` (the Main vault) is the Owner's alone.
    for (const who of Object.values(people)) {
      const theirs = yield* vaults.list.pipe(as(who.id));
      assert.notInclude(
        theirs.groups.map((group) => group.id),
        setup.main,
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: setup.main, name: "MINE", value: Redacted.make("x".repeat(9)) })
            .pipe(as(who.id)),
        ),
        "not-found",
      );
    }
  }),
);

it.effect(
  "an Organization's Admins manage its groups and edit them unread; Members and Guests read names",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, people, acmeId, globexId } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      const globex = yield* vaults
        .create({ name: "Globex secrets", owner: org(globexId) })
        .pipe(as(setup.ownerId));

      // Acme's Admin creates, renames, archives and deletes Acme's groups; nobody else does.
      const { admin } = people;
      const made = yield* vaults
        .create({ name: "Acme deploy", owner: org(acmeId) })
        .pipe(as(admin.id));
      assert.deepEqual(made.owner, { kind: "organization", spaceId: acmeId });
      const renamed = yield* vaults
        .update({ vaultId: made.id, name: "Acme release", archived: true })
        .pipe(as(admin.id));
      assert.deepEqual([renamed.name, renamed.archived], ["Acme release", true]);
      assert.isTrue((yield* vaults.remove({ vaultId: made.id }).pipe(as(admin.id))).deleted);
      for (const who of [people.member, people.guest, people.otherAdmin]) {
        assert.oneOf(
          yield* reasonOf(
            vaults.create({ name: `${who.id} group`, owner: org(acmeId) }).pipe(as(who.id)),
          ),
          ["forbidden"],
          `${who.id} created a group of Acme`,
        );
        assert.oneOf(
          yield* reasonOf(vaults.update({ vaultId: acme.id, name: "Mine now" }).pipe(as(who.id))),
          ["forbidden", "not-found"],
          `${who.id} renamed a group of Acme`,
        );
      }
      // Nor does an Admin make a group of someone else.
      assert.equal(
        yield* reasonOf(
          vaults.create({ name: "Owner's", owner: mine(setup.ownerId) }).pipe(as(admin.id)),
        ),
        "forbidden",
      );
      const audits = yield* setup.server.sql<{ readonly action: string }>`
        SELECT action FROM audit_log WHERE action LIKE 'vault_group.%' AND target_id = ${made.id}
        ORDER BY audit_id
      `;
      assert.deepEqual(
        audits.map((row) => row.action),
        ["vault_group.create", "vault_group.update", "vault_group.delete"],
      );

      // Its entries: added, replaced and deleted without reading.
      const seen = yield* vaults.list.pipe(as(admin.id));
      assert.deepEqual(
        seen.groups.map((group) => [group.name, group.ownerName, group.canEdit, group.canManage]),
        [
          // Her own Vault's `default` (owned-resources 04), then Acme's.
          ["default", "ada", true, false],
          ["default", "Acme", true, false],
          ["Acme secrets", "Acme", true, true],
        ],
      );
      assert.deepEqual(
        seen.owners.map((owner) => owner.name),
        ["ada", "Acme"],
      );
      const added = yield* vaults
        .putEntry({ vaultId: acme.id, name: "ADMIN_TOKEN", value: Redacted.make(ADMIN_WRITES) })
        .pipe(as(admin.id));
      const replaced = yield* vaults
        .putEntry({
          vaultId: acme.id,
          entryId: own.id,
          name: own.name,
          value: Redacted.make(ADMIN_REPLACES),
        })
        .pipe(as(admin.id));
      assert.equal(replaced.entry.version, 2);
      assert.isFalse(mentionsAValue(JSON.stringify([seen, added, replaced])));
      const deleted = yield* vaults
        .deleteEntry({ vaultId: acme.id, entryId: added.entry.id })
        .pipe(as(admin.id));
      assert.isTrue(deleted.deleted);
      // Another Organization's group is not there for them.
      assert.equal(
        yield* reasonOf(vaults.listEntries({ vaultId: globex.id }).pipe(as(admin.id))),
        "not-found",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: globex.id, name: "X_TOKEN", value: Redacted.make("y".repeat(9)) })
            .pipe(as(admin.id)),
        ),
        "not-found",
      );
      // Members and Guests: names only.
      for (const who of [people.member, people.guest]) {
        const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(who.id));
        assert.deepEqual(listed.entries.map((entry) => entry.name).toSorted(), [
          "ACME_API_KEY",
          "GITHUB_TOKEN",
          "GITHUB_TOKEN_COPY",
        ]);
        assert.isFalse(listed.group.canEdit);
        assert.equal(
          yield* reasonOf(
            vaults
              .putEntry({
                vaultId: acme.id,
                entryId: own.id,
                name: own.name,
                value: Redacted.make("z".repeat(9)),
              })
              .pipe(as(who.id)),
          ),
          "forbidden",
        );
        assert.equal(
          yield* reasonOf(
            vaults.deleteEntry({ vaultId: acme.id, entryId: own.id }).pipe(as(who.id)),
          ),
          "forbidden",
        );
      }
      // Globex's Admin sees Globex's only.
      const theirs = yield* vaults.list.pipe(as(people.otherAdmin.id));
      assert.deepEqual(
        theirs.groups.map((group) => [group.name, group.ownerName]),
        [
          ["default", "gus"],
          ["default", "Globex"],
          ["Globex secrets", "Globex"],
        ],
      );
    }),
);

it.effect("an agent bound to one Space sees no Vault of another, the Owner's own included", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, acmeId, globexId, people } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const inAcme = yield* vaults.list.pipe(as(ownerId, acmeId));
    assert.deepEqual(
      inAcme.groups.filter((group) => !group.isDefault).map((group) => group.id),
      [acme.id],
    );
    const inGlobex = yield* vaults.list.pipe(as(people.admin.id, globexId));
    assert.deepEqual(inGlobex.groups, []);
    assert.equal(
      yield* reasonOf(vaults.listEntries({ vaultId: setup.main }).pipe(as(ownerId, acmeId))),
      "not-found",
    );
  }),
);

it.effect(
  "nobody reads a Secret back, the Owner with a strong factor included, and no reveal is audited",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, people, owner, reveal } = setup;
      const { acme, own, link } = yield* acmeSecrets(setup);
      // As migration 141 found the ones that were revealable.
      yield* server.sql`UPDATE vault_entries SET revealable = 1 WHERE kind = 'own'`;
      for (const { cookie } of Object.values(people)) {
        const refused = yield* reveal(cookie, acme.id, own.id, BOGUS_REAUTH);
        assert.notEqual(refused.status, 200);
        assert.isFalse(mentionsAValue(JSON.stringify(refused.body)));
      }
      for (const entryId of [own.id, link.id]) {
        const asked = yield* reveal(
          owner,
          acme.id,
          entryId,
          yield* passkeyReauth(server, setup.authenticator),
        );
        assert.equal(asked.status, 404, "the reveal door is gone");
        assert.isFalse(mentionsAValue(JSON.stringify(asked.body)));
      }
      const listed = yield* setup.vaults
        .listEntries({ vaultId: acme.id })
        .pipe(setup.as(setup.ownerId));
      assert.isFalse(mentionsAValue(JSON.stringify(listed)));
      const audited = yield* server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.reveal'
      `;
      assert.equal(audited[0]?.n, 0);
    }),
);

it.effect("a Secret is listed without its value and is always sealed", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const secret = yield* vaults
      .putEntry({ vaultId: acme.id, name: "NEW_TOKEN", value: Redacted.make(ACME_OWN) })
      .pipe(as(ownerId));
    assert.equal(secret.entry.class, "secret");
    assert.notProperty(secret.entry, "value");
    assert.notProperty(secret.entry, "sealed");
    const mainSecret = yield* vaults
      .putEntry({ vaultId: setup.main, name: "MAIN_TOKEN", value: Redacted.make(ROTATED) })
      .pipe(as(ownerId));
    assert.notProperty(mainSecret.entry, "value");
    const rows = yield* setup.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM vault_entries WHERE revealable = 1
      `;
    assert.equal(rows[0]?.n, 0, "every Secret written is sealed");
  }),
);

it.effect(
  "making a Secret a Variable takes a new value, the old never read; a Variable becomes a Secret as it is",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, people } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      const put = (input: Omit<Parameters<typeof vaults.putEntry>[0], "vaultId">) =>
        vaults.putEntry({ vaultId: acme.id, ...input });
      // A Member edits nothing, a class change included.
      assert.equal(
        yield* reasonOf(
          put({
            entryId: own.id,
            name: own.name,
            class: "variable",
            value: Redacted.make("https://api.acme.example"),
          }).pipe(as(people.member.id)),
        ),
        "forbidden",
      );
      // A Secret becomes a Variable only with a new value, whoever edits.
      for (const who of [ownerId, people.admin.id]) {
        assert.equal(
          yield* reasonOf(
            put({ entryId: own.id, name: own.name, class: "variable" }).pipe(as(who)),
          ),
          "needs-new-value",
        );
      }
      // With one, the old value is never read (its file is gone).
      yield* dropValueFile(setup, own.id);
      const variable = yield* put({
        entryId: own.id,
        name: own.name,
        class: "variable",
        value: Redacted.make("https://api.acme.example"),
      }).pipe(as(people.admin.id));
      assert.deepEqual(
        [variable.entry.class, variable.entry.value],
        ["variable", "https://api.acme.example"],
      );
      // Back to a Secret: whoever edits, sealed, its value no longer listed.
      const secret = yield* put({ entryId: own.id, name: own.name, class: "secret" }).pipe(
        as(people.admin.id),
      );
      assert.equal(secret.entry.class, "secret");
      assert.notProperty(secret.entry, "value");
      // Owned-resources 05: each with the entry's type after it.
      assert.deepEqual(yield* auditTypes(setup, own.name), [
        "add:secret",
        "to-variable:variable",
        "replace:variable",
        "to-secret:secret",
      ]);
    }),
);

it.effect("a Variable's value goes to whoever sees its name but Guests; a Secret's to nobody", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const region = yield* vaults
      .putEntry({
        vaultId: acme.id,
        name: "AWS_REGION",
        value: Redacted.make("eu-west-1"),
        class: "variable",
      })
      .pipe(as(people.admin.id));
    assert.deepEqual(region.warnings, []);
    assert.equal(region.entry.value, "eu-west-1");
    // A credential-looking Variable is saved, with a warning.
    const risky = yield* vaults
      .putEntry({
        vaultId: acme.id,
        name: "DEPLOY_TOKEN",
        value: Redacted.make("ghp_looks_like_a_token_0003"),
        class: "variable",
      })
      .pipe(as(people.admin.id));
    assert.deepEqual(risky.warnings, ["looks-like-credential"]);
    // What a link and a copy of a Variable became: Variables of Acme's own.
    for (const name of ["KUBE_SERVER", "KUBE_SERVER_COPY"]) {
      yield* vaults
        .putEntry({
          vaultId: acme.id,
          name,
          value: Redacted.make("https://k3s.example:6443"),
          class: "variable",
        })
        .pipe(as(ownerId));
    }

    const valuesSeen = (userId: UserId) =>
      vaults.listEntries({ vaultId: acme.id }).pipe(
        as(userId),
        Effect.map((listed) =>
          Object.fromEntries(
            listed.entries.map((entry) => [entry.name, [entry.class, entry.value ?? null]]),
          ),
        ),
      );
    const secrets = {
      ACME_API_KEY: ["secret", null],
      GITHUB_TOKEN: ["secret", null],
      GITHUB_TOKEN_COPY: ["secret", null],
    };
    for (const who of [ownerId, people.admin.id, people.member.id]) {
      assert.deepEqual(yield* valuesSeen(who), {
        ...secrets,
        AWS_REGION: ["variable", "eu-west-1"],
        DEPLOY_TOKEN: ["variable", "ghp_looks_like_a_token_0003"],
        KUBE_SERVER: ["variable", "https://k3s.example:6443"],
        KUBE_SERVER_COPY: ["variable", "https://k3s.example:6443"],
      });
    }
    // Decision 4: a Guest sees the name and «Variable», never the value.
    assert.deepEqual(yield* valuesSeen(people.guest.id), {
      ...secrets,
      AWS_REGION: ["variable", null],
      DEPLOY_TOKEN: ["variable", null],
      KUBE_SERVER: ["variable", null],
      KUBE_SERVER_COPY: ["variable", null],
    });
  }),
);

it.effect(
  "names are environment variables the Hub does not reserve; values are text up to 64 KiB",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId } = setup;
      const put = (name: string, value = "long-enough-value") =>
        vaults
          .putEntry({ vaultId: setup.main, name, value: Redacted.make(value) })
          .pipe(as(ownerId));
      for (const name of ["path", "1ABC", "A=B", "A B", "A\u0000B", "", "Ä"]) {
        assert.equal(yield* reasonOf(put(name)), "invalid-name", JSON.stringify(name));
      }
      // The Hub's own: refused even to the Owner, confirmed or not.
      for (const name of [
        "T3_TOKEN",
        "T3CODE_HOME",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_BASE_URL",
      ]) {
        assert.equal(yield* reasonOf(put(name)), "reserved-name", name);
        assert.equal(
          yield* reasonOf(
            vaults
              .putEntry({
                vaultId: setup.main,
                name,
                value: Redacted.make("long-enough-value"),
                confirmDangerous: true,
              })
              .pipe(as(ownerId)),
          ),
          "reserved-name",
          name,
        );
      }
      assert.equal(yield* reasonOf(put("NUL_INSIDE", "abc\u0000def")), "invalid-value");
      assert.equal(yield* reasonOf(put("TOO_BIG", "x".repeat(64 * 1024 + 1))), "invalid-value");
      yield* put("JUST_FITS", "x".repeat(64 * 1024));
      assert.equal(yield* reasonOf(put("JUST_FITS")), "duplicate-name");
      // Short values are kept, with a warning, and never masked.
      const short = yield* put("PIN", "1234");
      assert.deepEqual(short.warnings, ["short-value"]);
      assert.isTrue(short.entry.unmasked);
      const long = yield* put("API_KEY");
      assert.deepEqual(long.warnings, []);
      assert.isFalse(long.entry.unmasked);
    }),
);

it.effect(
  "values live sealed in the store: not in the database, the audit log, a log or a span",
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
      const { server, vaults, as, people, valuesDir } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      yield* vaults
        .putEntry({ vaultId: acme.id, name: "ADMIN_TOKEN", value: Redacted.make(ADMIN_WRITES) })
        .pipe(as(people.admin.id));
      yield* vaults
        .putEntry({
          vaultId: acme.id,
          entryId: own.id,
          name: own.name,
          value: Redacted.make(ADMIN_REPLACES),
        })
        .pipe(as(people.admin.id));
      // An Admin's refused write says why, never what.
      const refused = yield* Effect.flip(
        vaults
          .putEntry({ vaultId: setup.main, name: "GITHUB_TOKEN", value: Redacted.make(ROTATED) })
          .pipe(as(people.admin.id)),
      );
      assert.isFalse(mentionsAValue(JSON.stringify(refused) + refused.message));
      assert.isTrue(yield* setup.holds(own.id, ADMIN_REPLACES), "the replaced value is stored");

      // Every table of the database, rows as text.
      const tables = yield* server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
      for (const { name } of tables) {
        const rows = yield* server.sql.unsafe(`SELECT * FROM "${name}"`);
        const text = JSON.stringify(rows, (_key, value) =>
          value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value,
        );
        assert.isFalse(mentionsAValue(text), `a value is in the table ${name}`);
      }
      // Sealed files, none in clear.
      const files = setup.valueFiles();
      assert.isAbove(files.length, 0);
      for (const file of files) {
        assert.match(file, /\.sealed$/);
        const bytes = NodeFS.readFileSync(NodePath.join(valuesDir, file)).toString("latin1");
        assert.isFalse(mentionsAValue(bytes), `${file} holds a value in clear`);
      }
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.isAbove(spans.length, 0);
      assert.isFalse(recorded.some(mentionsAValue), "a value reached a log or a span");
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

it.effect(
  "deletions leave no sealed value behind; a value left by a crash goes at the next start",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, vaults, as, ownerId, store, valueFiles } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      // GITHUB_TOKEN, Acme's GITHUB_TOKEN, its copy and ACME_API_KEY hold values.
      assert.lengthOf(valueFiles(), 4);
      yield* vaults
        .putEntry({ vaultId: acme.id, entryId: own.id, name: "ACME_RENAMED" })
        .pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 4);
      yield* vaults.deleteEntry({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 3);
      yield* vaults.remove({ vaultId: acme.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 1);

      // A replace leaves one value, the new one.
      const github = (yield* vaults.listEntries({ vaultId: setup.main }).pipe(as(ownerId)))
        .entries[0]!;
      yield* vaults
        .putEntry({
          vaultId: setup.main,
          entryId: github.id,
          name: github.name,
          value: Redacted.make(ROTATED),
        })
        .pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 1);

      const values = Context.get(server.services, ServerSecretStore.VaultValueStore);
      yield* values.set("value-left-behind", new TextEncoder().encode("left-behind-value"));
      // A Hub secret whose name looks like a value is not the sweep's.
      yield* store.set("value-not-a-vault-one", new TextEncoder().encode("hub-secret"));
      assert.lengthOf(valueFiles(), 2);
      yield* Layer.build(Vaults.layer.pipe(Layer.provide(Layer.succeedContext(server.services))));
      assert.lengthOf(valueFiles(), 1);
      assert.isTrue((yield* store.get("value-not-a-vault-one"))._tag === "Some");
      // No name of the store's own reaches the Vault values' folder.
      assert.equal(
        (yield* Effect.flip(store.get(`vault-values/${valueFiles()[0]!.replace(".sealed", "")}`)))
          ._tag,
        "SecretStoreDecodeError",
      );
    }),
);

it.effect("a value's file renamed to another secret, or from another entry, does not open", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { store, valueFileOf, storedValue } = setup;
    const { own, copy } = yield* acmeSecrets(setup);
    const directory = store.directory ?? "";
    NodeFS.copyFileSync(yield* valueFileOf(own.id), yield* valueFileOf(copy.id));
    assert.isTrue((yield* Effect.exit(storedValue(copy.id)))._tag === "Failure");
    // A Hub secret (another purpose) moved under a Vault value's name does not open either.
    const hubSecret = NodeFS.readdirSync(directory).find((file) => file.endsWith(".sealed"));
    assert.isDefined(hubSecret);
    NodeFS.copyFileSync(NodePath.join(directory, hubSecret!), yield* valueFileOf(own.id));
    assert.isTrue((yield* Effect.exit(storedValue(own.id)))._tag === "Failure");
  }),
);

it.effect(
  "the database's key check: written once, re-sealed after a rotation, a wrong key stops the Hub",
  () =>
    Effect.gen(function* () {
      const { server } = yield* hub;
      const keyring = (
        current: SecretCipher.MasterKey,
        ...older: Array<SecretCipher.MasterKey>
      ) => ({
        current,
        keys: [current, ...older],
        keyFile: "/state/master.key",
      });
      const run = (ring: ReturnType<typeof keyring>) =>
        VaultKeyCheck.checkDatabaseKey(ring).pipe(
          Effect.provide(Layer.succeedContext(server.services)),
        );
      const keyIdNow = () =>
        server.sql<{ readonly keyId: string }>`SELECT key_id AS "keyId" FROM vault_key_check`.pipe(
          Effect.map((rows) => rows[0]?.keyId),
        );
      // The Hub wrote it at its start with its own key; another key alone does not open it.
      const stranger = SecretCipher.MasterKey.generate();
      const before = yield* keyIdNow();
      assert.isString(before);
      const refused = yield* Effect.flip(run(keyring(stranger)));
      assert.equal(refused._tag, "MasterKeyError");
      assert.equal(yield* keyIdNow(), before);

      yield* server.sql`DELETE FROM vault_key_check`;
      const first = SecretCipher.MasterKey.generate();
      yield* run(keyring(first));
      assert.equal(yield* keyIdNow(), first.id);
      // Rotated: the new key with the previous one beside it re-seals the check.
      const second = SecretCipher.MasterKey.generate();
      yield* run(keyring(second, first));
      assert.equal(yield* keyIdNow(), second.id);
      yield* run(keyring(second));
      const wrong = yield* Effect.flip(run(keyring(first)));
      assert.equal(wrong._tag, "MasterKeyError");
    }),
);

it.effect(
  "a name that changes how tools run: never an Admin's; the Owner's only confirmed, and audited",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, people, server } = setup;
      const { acme } = yield* acmeSecrets(setup);
      const put = (who: UserId, name: string, confirmDangerous?: boolean) =>
        vaults
          .putEntry({
            vaultId: acme.id,
            name,
            value: Redacted.make("long-enough-value"),
            ...(confirmDangerous === undefined ? {} : { confirmDangerous }),
          })
          .pipe(as(who));
      for (const name of [
        "GIT_SSH_COMMAND",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "PYTHONSTARTUP",
        "HTTPS_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "BASH_FUNC_LS",
        "XDG_RUNTIME_DIR",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
      ]) {
        assert.equal(yield* reasonOf(put(people.admin.id, name, true)), "dangerous-name", name);
      }
      // The provider homes the AI gateway sets (spec 4 ticket 06) are the Hub's: nobody sets
      // them, the Owner included, confirmed or not.
      for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
        assert.equal(yield* reasonOf(put(people.admin.id, name, true)), "reserved-name", name);
        assert.equal(yield* reasonOf(put(ownerId, name, true)), "reserved-name", name);
      }
      assert.equal(yield* reasonOf(put(ownerId, "GIT_SSH_COMMAND")), "confirm-dangerous");
      const set = yield* put(ownerId, "GIT_SSH_COMMAND", true);
      // Once set, an Admin neither replaces nor renames it.
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({
              vaultId: acme.id,
              entryId: set.entry.id,
              name: "GIT_SSH_COMMAND",
              value: Redacted.make("ssh -o ProxyCommand=evil"),
              confirmDangerous: true,
            })
            .pipe(as(people.admin.id)),
        ),
        "dangerous-name",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: acme.id, entryId: set.entry.id, name: "SAFE_NAME" })
            .pipe(as(people.admin.id)),
        ),
        "dangerous-name",
      );
      // Nor renames a plain one into one.
      const plain = yield* put(people.admin.id, "PLAIN_TOKEN");
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({
              vaultId: acme.id,
              entryId: plain.entry.id,
              name: "NODE_OPTIONS",
              confirmDangerous: true,
            })
            .pipe(as(people.admin.id)),
        ),
        "dangerous-name",
      );
      const [audited] = yield* server.sql<{ readonly detail_json: string }>`
        SELECT detail_json FROM audit_log
        WHERE action = 'secret.edit' AND target_name = 'GIT_SSH_COMMAND'
      `;
      assert.equal(JSON.parse(audited?.detail_json ?? "{}").dangerous, true);
    }),
);

it.effect(
  "a replace that fails leaves the old value live and unaudited, and no new value behind",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, server, valueFiles } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      const before = valueFiles().toSorted();
      yield* server.sql`
        CREATE TRIGGER vault_entries_refuse BEFORE UPDATE ON vault_entries
        BEGIN SELECT RAISE(ABORT, 'the disk is full'); END
      `;
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({
              vaultId: acme.id,
              entryId: own.id,
              name: own.name,
              value: Redacted.make(ROTATED),
            })
            .pipe(as(ownerId)),
        ),
        "storage",
      );
      yield* server.sql`DROP TRIGGER vault_entries_refuse`;
      assert.isTrue(yield* setup.holds(own.id, ACME_OWN), "the failed replace kept the value");
      const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      assert.equal(listed.entries.find((entry) => entry.id === own.id)?.version, 1);
      const replaces = yield* server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'secret.edit' AND detail_json LIKE '%"replace"%'
      `;
      assert.equal(replaces[0]?.n, 0);
      assert.deepEqual(valueFiles().toSorted(), before);
    }),
);

it.effect("a joined machine has no Vaults: nothing is written, every call says so", () =>
  Effect.gen(function* () {
    const { server, as, ownerId, main } = yield* hub;
    yield* server.sql`DELETE FROM vault_groups`;
    yield* server.sql`DELETE FROM vault_key_check`;
    const joined = Context.add(server.services, ServerSecretStore.MasterKeyring, {
      keyring: Option.none(),
      unavailable: Option.none(),
    });
    const built = yield* Layer.build(
      Vaults.layer.pipe(Layer.provide(Layer.succeedContext(joined))),
    );
    const vaults = Context.get(built, Vaults.Vaults);
    const rows = yield* server.sql<{ readonly n: number }>`
      SELECT (SELECT COUNT(*) FROM vault_groups) + (SELECT COUNT(*) FROM vault_key_check) AS n
    `;
    assert.equal(rows[0]?.n, 0);
    assert.equal(yield* reasonOf(vaults.list.pipe(as(ownerId))), "unavailable");
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: main, name: "X_TOKEN", value: Redacted.make("long-value") })
          .pipe(as(ownerId)),
      ),
      "unavailable",
    );
  }),
);

it.effect("a database another key sealed stops the start before the database changes", () =>
  Effect.gen(function* () {
    const { server } = yield* hub;
    const stranger = SecretCipher.MasterKey.generate();
    yield* server.sql`DELETE FROM vault_groups`;
    yield* server.sql`
      UPDATE vault_key_check SET key_id = ${stranger.id},
        sealed = ${SecretCipher.seal(stranger, "key-check", "vault_key_check", new TextEncoder().encode("t3code vault key check"))}
    `;
    const failed = yield* Effect.flip(
      Layer.build(Vaults.layer.pipe(Layer.provide(Layer.succeedContext(server.services)))),
    );
    assert.equal(failed._tag, "MasterKeyError");
    const rows = yield* server.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM vault_groups`;
    assert.equal(rows[0]?.n, 0, "a default group was written before the key check");
  }),
);

// Ticket 02 of «Variables, Secretos sellados y Secret providers»: Provider entries.

it.effect("only the Owner adds a Provider entry: a sealed Secret, its path for editors", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people, provider, server } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const source = { providerId: FAKE_PROVIDER_ID, reference: "kv/acme/kube#token" };
    for (const who of Object.values(people)) {
      assert.oneOf(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: acme.id, name: "KUBE_TOKEN", provider: source })
            .pipe(as(who.id)),
        ),
        ["forbidden", "not-found"],
        who.id,
      );
    }
    const added = yield* vaults
      .putEntry({ vaultId: acme.id, name: "KUBE_TOKEN", provider: source })
      .pipe(as(ownerId));
    assert.deepEqual(
      [added.entry.kind, added.entry.class, added.entry.broken],
      ["provider", "secret", false],
    );
    assert.deepEqual(added.entry.provider, {
      label: FAKE_PROVIDER_LABEL,
      reference: "kv/acme/kube#token",
      // The Owner's own access, no Provider scope (ticket 03: «Direct»).
      scope: null,
    });
    // A Member sees «Provider: OpenBao», never where it reads.
    const seen = (yield* vaults
      .listEntries({ vaultId: acme.id })
      .pipe(as(people.member.id))).entries.find((entry) => entry.name === "KUBE_TOKEN");
    assert.deepEqual(seen?.provider, {
      label: FAKE_PROVIDER_LABEL,
      reference: null,
      scope: null,
    });
    // Listing it never asks the provider.
    assert.lengthOf(provider.state.batches, 0);
    // It takes no value or class; an Admin changes nothing of it but may delete it.
    for (const change of [
      { value: Redacted.make("x".repeat(9)) },
      { class: "variable" as const },
    ]) {
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({
              vaultId: acme.id,
              entryId: added.entry.id,
              name: "KUBE_TOKEN",
              ...change,
            })
            .pipe(as(ownerId)),
        ),
        "invalid-value",
      );
    }
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: acme.id, entryId: added.entry.id, name: "KUBE_RENAMED" })
          .pipe(as(people.admin.id)),
      ),
      "forbidden",
    );
    // Audited with its provider's label, never its reference or a value.
    const [audited] = yield* server.sql<{ readonly detail_json: string }>`
        SELECT detail_json FROM audit_log WHERE action = 'secret.edit' AND target_name = 'KUBE_TOKEN'
      `;
    assert.deepEqual(JSON.parse(audited?.detail_json ?? "{}"), {
      vault: "Acme secrets",
      vaultId: acme.id,
      kind: "provider",
      type: "secret",
      op: "add",
      provider: FAKE_PROVIDER_LABEL,
    });
    const deleted = yield* vaults
      .deleteEntry({ vaultId: acme.id, entryId: added.entry.id })
      .pipe(as(people.admin.id));
    assert.isTrue(deleted.deleted);
  }),
);

it.effect(
  "a reference that leaves its path is refused; a Provider entry is neither linked nor copied",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, provider } = setup;
      const { acme } = yield* acmeSecrets(setup);
      for (const reference of [
        "kv/acme/../globex#token",
        "kv/acme//token",
        "kv/acme/%2e%2e/globex",
        "op://not/this/kind",
      ]) {
        assert.equal(
          yield* reasonOf(
            vaults
              .putEntry({
                vaultId: acme.id,
                name: "KUBE_TOKEN",
                provider: { providerId: FAKE_PROVIDER_ID, reference },
              })
              .pipe(as(ownerId)),
          ),
          "invalid-reference",
          reference,
        );
      }
      const main = yield* vaults
        .putEntry({
          vaultId: setup.main,
          name: "MAIN_KUBE",
          provider: { providerId: FAKE_PROVIDER_ID, reference: "kv/main#token" },
        })
        .pipe(as(ownerId));
      assert.equal(main.entry.kind, "provider");
      // A provider removed from the settings: «broken», shown to everyone, never read.
      provider.state.providers = {};
      const listed = yield* vaults.listEntries({ vaultId: setup.main }).pipe(as(ownerId));
      const broken = listed.entries.find((entry) => entry.name === "MAIN_KUBE");
      assert.deepEqual([broken?.broken, broken?.provider?.label], [true, null]);
      assert.lengthOf(provider.state.batches, 0);
    }),
);

it.effect(
  "a template names its own Vault's entries only, never another template, and is never listed with a value",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, people, server } = setup;
      const { acme } = yield* acmeSecrets(setup);
      const put = (input: Omit<Parameters<typeof vaults.putEntry>[0], "vaultId">) =>
        vaults.putEntry({ vaultId: acme.id, ...input });
      yield* put({
        name: "KUBE_SERVER",
        value: Redacted.make("https://k3s:6443"),
        class: "variable",
      }).pipe(as(people.admin.id));
      const token = yield* put({
        name: "KUBE_TOKEN",
        value: Redacted.make("kube-token-value-0001"),
        delivery: "file",
      }).pipe(as(people.admin.id));
      const text = "server: {{ KUBE_SERVER }}\ntokenFile: {{ KUBE_TOKEN | path }}\n";
      yield* vaults
        .putEntry({
          vaultId: setup.main,
          name: "MAIN_URL",
          value: Redacted.make("https://x"),
          class: "variable",
        })
        .pipe(as(ownerId));
      // Another Vault's name (the Main vault's MAIN_URL), syntax, an unknown filter, a `path` of
      // an entry delivered as a variable: refused when saved.
      for (const [bad, reason] of [
        ["{{ MAIN_URL }}", "invalid-template"],
        ["{{ KUBE_SERVER", "invalid-template"],
        ["{{ KUBE_SERVER | upper }}", "invalid-template"],
        ["{{ KUBE_SERVER | path }}", "invalid-template"],
      ] as const) {
        assert.equal(
          yield* reasonOf(put({ name: "KUBECONFIG", template: { text: bad } }).pipe(as(ownerId))),
          reason,
          bad,
        );
      }
      const kubeconfig = yield* put({
        name: "KUBECONFIG",
        template: { text },
        delivery: "file",
      }).pipe(as(people.admin.id));
      // One input is a Secret: the template is a sealed Secret; no value is stored for it.
      assert.deepEqual(
        [kubeconfig.entry.kind, kubeconfig.entry.class, kubeconfig.entry.delivery],
        ["template", "secret", "file"],
      );
      assert.equal(kubeconfig.entry.template?.text, text);
      assert.isUndefined(kubeconfig.entry.value);
      // Another template is never an input.
      assert.equal(
        yield* reasonOf(
          put({ name: "NESTED", template: { text: "{{ KUBECONFIG }}" } }).pipe(as(ownerId)),
        ),
        "invalid-template",
      );
      // A template is never `none`, and takes no value.
      assert.equal(
        yield* reasonOf(
          put({ name: "NONE", template: { text: "{{ KUBE_SERVER }}" }, delivery: "none" }).pipe(
            as(ownerId),
          ),
        ),
        "invalid-template",
      );
      // The input whose path it takes stays a file.
      assert.equal(
        yield* reasonOf(
          put({ entryId: token.entry.id, name: "KUBE_TOKEN", delivery: "env" }).pipe(as(ownerId)),
        ),
        "invalid-template",
      );
      // Nobody reads it back, the Owner included.
      const asOwner = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      assert.notProperty(
        asOwner.entries.find((entry) => entry.name === "KUBECONFIG")!,
        "value",
      );
      // A Guest sees that it is a template, not its text; a Member sees the text (names only).
      const asGuest = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(people.guest.id));
      const asMember = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(people.member.id));
      const shownTo = (list: typeof asGuest) =>
        list.entries.find((entry) => entry.name === "KUBECONFIG")?.template?.text;
      assert.deepEqual([shownTo(asGuest), shownTo(asMember)], [null, text]);
      // A Variable-only template is a Variable; its input turning Secret makes it a Secret.
      const region = yield* put({
        name: "REGION_URL",
        template: { text: "{{ KUBE_SERVER | urlencode }}" },
      }).pipe(as(ownerId));
      assert.equal(region.entry.class, "variable");
      const server_ = (yield* vaults
        .listEntries({ vaultId: acme.id })
        .pipe(as(ownerId))).entries.find((entry) => entry.name === "KUBE_SERVER");
      yield* put({
        entryId: server_!.id,
        name: "KUBE_SERVER",
        class: "secret",
      }).pipe(as(ownerId));
      const after = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      assert.equal(after.entries.find((entry) => entry.name === "REGION_URL")?.class, "secret");
      // An input gone breaks the template, shown «broken», not delivered.
      yield* vaults.deleteEntry({ vaultId: acme.id, entryId: token.entry.id }).pipe(as(ownerId));
      const gone = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      assert.isTrue(gone.entries.find((entry) => entry.name === "KUBECONFIG")?.broken);
      // A template of the Owner's `default` composes that group's entries.
      const mainTemplate = yield* vaults
        .putEntry({ vaultId: setup.main, name: "MAIN_T", template: { text: "{{ MAIN_URL }}" } })
        .pipe(as(ownerId));
      assert.isFalse(mainTemplate.entry.broken);
      // The audit names the template and its delivery, never its text.
      const audited = yield* server.sql<{ readonly detail_json: string }>`
        SELECT detail_json FROM audit_log WHERE target_name = 'KUBECONFIG'
      `;
      assert.isTrue(audited.length > 0);
      for (const row of audited) assert.notInclude(row.detail_json, "tokenFile");
    }),
);

it.effect("an entry that only feeds a template is said to reach nothing until one names it", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const raw = yield* vaults
      .putEntry({
        vaultId: acme.id,
        name: "RAW_TOKEN",
        value: Redacted.make("raw-token-value-0002"),
        delivery: "none",
      })
      .pipe(as(ownerId));
    assert.deepEqual([raw.entry.delivery, raw.warnings], ["none", ["not-used-by-template"]]);
    yield* vaults
      .putEntry({
        vaultId: acme.id,
        name: "AUTH_HEADER",
        template: { text: "Bearer {{ RAW_TOKEN }}" },
      })
      .pipe(as(ownerId));
    const again = yield* vaults
      .putEntry({ vaultId: acme.id, entryId: raw.entry.id, name: "RAW_TOKEN", description: "x" })
      .pipe(as(ownerId));
    assert.deepEqual(again.warnings, []);
  }),
);

// Vaults ticket 07: workload identity entries, a token the Hub signs, the Owner's alone.
it.effect("a workload identity entry is the Owner's alone, always a sealed Secret file", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({ identityIssuer: "https://hub.example.com" });
    const { vaults, as, ownerId, acmeId, people } = setup;
    const acme = yield* vaults
      .create({ name: "Acme cluster", owner: org(acmeId) })
      .pipe(as(ownerId));
    const added = yield* vaults
      .putEntry({ vaultId: acme.id, name: "KUBE_TOKEN", identity: { audience: "kubernetes" } })
      .pipe(as(ownerId));
    assert.deepInclude(added.entry, {
      kind: "identity",
      class: "secret",
      delivery: "file",
      identity: { audience: "kubernetes", ttlSeconds: 600 },
    });
    // An Admin of the Organization neither adds, changes nor deletes one.
    const admin = as(people.admin.id);
    assert.strictEqual(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: acme.id, name: "OTHER", identity: { audience: "vault" } })
          .pipe(admin),
      ),
      "forbidden",
    );
    assert.strictEqual(
      yield* reasonOf(
        vaults.putEntry({ vaultId: acme.id, entryId: added.entry.id, name: "RENAMED" }).pipe(admin),
      ),
      "forbidden",
    );
    assert.strictEqual(
      yield* reasonOf(
        vaults.deleteEntry({ vaultId: acme.id, entryId: added.entry.id }).pipe(admin),
      ),
      "forbidden",
    );
    // It takes no value or class, is never an environment variable, and never names the
    // Hub itself as audience; its lifetime is 1 minute to 1 hour.
    const owner = as(ownerId);
    for (const input of [
      { name: "A", identity: { audience: "vault" }, value: Redacted.make("x") },
      { name: "C", identity: { audience: "vault" }, delivery: "env" as const },
      { name: "D", identity: { audience: "https://hub.example.com" } },
      { name: "E", identity: { audience: "a b" } },
      { name: "F", identity: { audience: "vault", ttlSeconds: 3601 } },
      { name: "G", identity: { audience: "vault", ttlSeconds: 59 } },
    ]) {
      assert.strictEqual(
        yield* reasonOf(vaults.putEntry({ vaultId: acme.id, ...input }).pipe(owner)),
        "invalid-value",
        input.name,
      );
    }
    // The Owner changes its audience and lifetime; a value never.
    const changed = yield* vaults
      .putEntry({
        vaultId: acme.id,
        entryId: added.entry.id,
        name: "KUBE_TOKEN",
        identity: { audience: "https://k8s.example.com", ttlSeconds: 900 },
      })
      .pipe(owner);
    assert.deepStrictEqual(changed.entry.identity, {
      audience: "https://k8s.example.com",
      ttlSeconds: 900,
    });
    assert.strictEqual(
      yield* reasonOf(
        vaults
          .putEntry({
            vaultId: acme.id,
            entryId: added.entry.id,
            name: "KUBE_TOKEN",
            value: Redacted.make("not-a-token"),
          })
          .pipe(owner),
      ),
      "invalid-value",
    );
    // A template takes only its file's path, never the token itself.
    assert.strictEqual(
      yield* reasonOf(
        vaults
          .putEntry({
            vaultId: acme.id,
            name: "KUBECONFIG",
            template: { text: "token: {{ KUBE_TOKEN }}" },
            delivery: "file",
          })
          .pipe(owner),
      ),
      "invalid-template",
    );
    const kubeconfig = yield* vaults
      .putEntry({
        vaultId: acme.id,
        name: "KUBECONFIG",
        template: { text: "tokenFile: {{ KUBE_TOKEN | path }}" },
        delivery: "file",
      })
      .pipe(owner);
    assert.isFalse(kubeconfig.entry.broken);
    // One in the Owner's own `default` too.
    const main = yield* vaults
      .putEntry({ vaultId: setup.main, name: "HUB_ID", identity: { audience: "vault" } })
      .pipe(owner);
    assert.equal(main.entry.kind, "identity");
    // The Owner deletes it.
    const removed = yield* vaults
      .deleteEntry({ vaultId: acme.id, entryId: kubeconfig.entry.id })
      .pipe(
        Effect.andThen(vaults.deleteEntry({ vaultId: acme.id, entryId: added.entry.id })),
        owner,
      );
    assert.isTrue(removed.deleted);
  }),
);

it.effect("without an issuer the Hub keeps no workload identity entry", () =>
  Effect.gen(function* () {
    const { vaults, as, ownerId, acmeId } = yield* hub;
    const acme = yield* vaults.create({ name: "Acme", owner: org(acmeId) }).pipe(as(ownerId));
    assert.strictEqual(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: acme.id, name: "KUBE_TOKEN", identity: { audience: "kubernetes" } })
          .pipe(as(ownerId)),
      ),
      "identity-no-issuer",
    );
  }),
);

// Owned-resources 03: what a Secret link became. Migration 142 leaves a former link sharing its
// original's value id; the Hub's start gives it its own copy before any request.

/** Points `entryId` at the value `sharedWith` holds, as migration 142 leaves a former link. */
const shareValue = (setup: Hub, entryId: string, sharedWith: string) =>
  setup.server.sql`
    UPDATE vault_entries SET value_id = (
      SELECT value_id FROM vault_entries WHERE entry_id = ${sharedWith}
    ) WHERE entry_id = ${entryId}
  `;

const valueIdOf = (setup: Hub, entryId: string) =>
  setup.server.sql<{ readonly valueId: string | null }>`
    SELECT value_id AS "valueId" FROM vault_entries WHERE entry_id = ${entryId}
  `.pipe(Effect.map((rows) => rows[0]?.valueId ?? null));

const unshare = (setup: Hub, services = setup.server.services) =>
  Vaults.unshareValues.pipe(Effect.provide(Layer.succeedContext(services)));

it.effect("a shared value is never changed or removed under the entry that still holds it", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, holds, main } = setup;
    const { github, link, copy } = yield* acmeSecrets(setup);
    yield* shareValue(setup, link.id, github.id);
    yield* shareValue(setup, copy.id, github.id);
    const shared = yield* valueIdOf(setup, github.id);
    const bytesBefore = NodeFS.readFileSync(yield* setup.valueFileOf(github.id));
    // Replacing one of them writes a new value; the shared one is neither rewritten nor removed.
    yield* vaults
      .putEntry({
        vaultId: link.vaultId,
        entryId: link.id,
        name: link.name,
        value: Redacted.make(ROTATED),
      })
      .pipe(as(ownerId));
    assert.notEqual(yield* valueIdOf(setup, link.id), shared);
    assert.isTrue(
      NodeFS.readFileSync(yield* setup.valueFileOf(github.id)).equals(bytesBefore),
      "the shared value's file is untouched",
    );
    assert.isTrue(yield* holds(github.id, ORIGINAL), "the original keeps its value");
    assert.isTrue(yield* holds(copy.id, ORIGINAL), "the other sharer keeps its value");
    // Deleting the original leaves the value the copy still holds.
    yield* vaults.deleteEntry({ vaultId: main, entryId: github.id }).pipe(as(ownerId));
    assert.isTrue(yield* holds(copy.id, ORIGINAL), "deleting the original kept the copy's");
    assert.equal(yield* valueIdOf(setup, copy.id), shared);
  }),
);

it.effect("the start gives each former link its own value, once, and a crash loses nothing", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, holds, main, valueFiles } = setup;
    const { github, link, copy } = yield* acmeSecrets(setup);
    yield* shareValue(setup, link.id, github.id);
    yield* shareValue(setup, copy.id, github.id);
    const shared = yield* valueIdOf(setup, github.id);

    // A crash after the first copy is written and before its row moves: every entry still
    // delivers, and the next start finishes the job.
    const values = Context.get(setup.server.services, ServerSecretStore.VaultValueStore);
    const crashing = Context.add(setup.server.services, ServerSecretStore.VaultValueStore, {
      ...values,
      set: (id: string, bytes: Uint8Array) =>
        values.set(id, bytes).pipe(Effect.andThen(Effect.die("crash"))),
    });
    assert.equal((yield* Effect.exit(unshare(setup, crashing)))._tag, "Failure");
    for (const entryId of [github.id, link.id, copy.id]) {
      assert.isTrue(yield* holds(entryId, ORIGINAL), `${entryId} delivers after the crash`);
    }

    yield* unshare(setup);
    const ids = [
      yield* valueIdOf(setup, github.id),
      yield* valueIdOf(setup, link.id),
      yield* valueIdOf(setup, copy.id),
    ];
    // One keeps the shared id; each other gets its own, the same value (as booleans).
    assert.include(ids, shared);
    assert.equal(new Set(ids).size, 3);
    for (const entryId of [github.id, link.id, copy.id]) {
      assert.isTrue(yield* holds(entryId, ORIGINAL), `${entryId} holds the same value`);
    }
    // Twice is a no-op.
    const files = valueFiles().toSorted();
    yield* unshare(setup);
    assert.deepEqual(
      [yield* valueIdOf(setup, github.id), yield* valueIdOf(setup, link.id)],
      [ids[0], ids[1]],
    );
    assert.deepEqual(valueFiles().toSorted(), files);

    // From now on they are independent: replacing the original leaves the former link, and back.
    yield* vaults
      .putEntry({
        vaultId: main,
        entryId: github.id,
        name: github.name,
        value: Redacted.make(ROTATED),
      })
      .pipe(as(ownerId));
    assert.isTrue(yield* holds(link.id, ORIGINAL), "the former link kept its value");
    yield* vaults
      .putEntry({
        vaultId: link.vaultId,
        entryId: link.id,
        name: link.name,
        value: Redacted.make(ADMIN_REPLACES),
      })
      .pipe(as(ownerId));
    assert.isTrue(yield* holds(github.id, ROTATED), "the original kept its own");
    // Deleting either never removes what the other holds.
    yield* vaults.deleteEntry({ vaultId: main, entryId: github.id }).pipe(as(ownerId));
    assert.isTrue(yield* holds(link.id, ADMIN_REPLACES), "the former link survives the original");
    assert.isTrue(yield* holds(copy.id, ORIGINAL), "the former copy survives the original");
  }),
);

it.effect("the Owner is told once which entries were Secret links; nobody else is", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const { acme, link } = yield* acmeSecrets(setup);
    yield* setup.server.sql`
      INSERT INTO vault_unlinked_notices (entry_id, group_id, name, original_name, created_at)
      VALUES (${link.id}, ${acme.id}, ${link.name}, 'GITHUB_TOKEN', '2026-11-17T00:00:00.000Z')
    `;
    const listed = yield* vaults.list.pipe(as(ownerId));
    assert.deepEqual(listed.unlinked, [
      {
        vaultId: acme.id,
        vaultName: "Acme secrets",
        entryId: link.id,
        name: "GITHUB_TOKEN",
        originalName: "GITHUB_TOKEN",
      },
    ]);
    assert.deepEqual((yield* vaults.list.pipe(as(people.admin.id))).unlinked, []);
    assert.equal(yield* reasonOf(vaults.dismissUnlinked.pipe(as(people.admin.id))), "forbidden");
    assert.deepEqual(yield* vaults.dismissUnlinked.pipe(as(ownerId)), { dismissed: 1 });
    assert.deepEqual((yield* vaults.list.pipe(as(ownerId))).unlinked, []);
  }),
);

// Grants ticket 07: a group lent to a Space is read there, never written.

it.effect(
  "a group lent to Acme is listed there as borrowed and read-only; its lender keeps it",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, acmeId, people } = setup;
      const tools = yield* vaults.create({ name: "Tools", owner: mine(ownerId) }).pipe(as(ownerId));
      yield* vaults
        .putEntry({ vaultId: tools.id, name: "TOOLS_TOKEN", value: Redacted.make(ACME_OWN) })
        .pipe(as(ownerId));
      yield* vaults
        .putEntry({
          vaultId: tools.id,
          name: "TOOLS_REGION",
          value: Redacted.make("eu-west-1"),
          class: "variable",
        })
        .pipe(as(ownerId));
      const grantId = yield* lendVaultGroup(setup.server.sql, {
        vaultId: tools.id,
        spaceId: acmeId,
        lender: { kind: "user", id: ownerId },
      });
      for (const who of [people.admin, people.member, people.guest]) {
        const listed = (yield* vaults.list.pipe(as(who.id))).groups.find(
          (group) => group.id === tools.id,
        );
        assert.equal(listed?.borrowed?.grantId, grantId, who.id);
        assert.equal(listed?.borrowed?.spaceId, acmeId);
        assert.equal(listed?.borrowed?.spaceName, "Acme");
        assert.isFalse(listed?.canEdit);
        assert.isFalse(listed?.canManage);
        assert.deepEqual(listed?.allowances, []);
      }
      // The lender lists it as theirs, not borrowed.
      const owners = (yield* vaults.list.pipe(as(ownerId))).groups.find(
        (group) => group.id === tools.id,
      );
      assert.isUndefined(owners?.borrowed);
      assert.isTrue(owners?.canEdit);
      // Variables with their value to Admins and Members, names only to a Guest; a Secret never.
      const shown = (who: UserId) =>
        vaults.listEntries({ vaultId: tools.id }).pipe(
          as(who),
          Effect.map((listed) =>
            Object.fromEntries(listed.entries.map((entry) => [entry.name, entry.value ?? null])),
          ),
        );
      assert.deepEqual(yield* shown(people.member.id), {
        TOOLS_REGION: "eu-west-1",
        TOOLS_TOKEN: null,
      });
      assert.deepEqual(yield* shown(people.guest.id), { TOOLS_REGION: null, TOOLS_TOKEN: null });
      // Nobody in Acme writes into it, its Admin included.
      for (const who of [people.admin, people.member]) {
        assert.equal(
          yield* reasonOf(
            vaults
              .putEntry({
                vaultId: tools.id,
                name: "PLANTED",
                value: Redacted.make("planted-0001"),
              })
              .pipe(as(who.id)),
          ),
          "forbidden",
        );
        assert.equal(
          yield* reasonOf(vaults.update({ vaultId: tools.id, name: "Mine" }).pipe(as(who.id))),
          "forbidden",
        );
      }
      // Once the loan ends, Acme sees nothing of it.
      yield* setup.server.sql`
      UPDATE grants SET state = 'ended', end_reason = 'revoked' WHERE grant_id = ${grantId}
    `;
      assert.isUndefined(
        (yield* vaults.list.pipe(as(people.member.id))).groups.find(
          (group) => group.id === tools.id,
        ),
      );
      assert.equal(
        yield* reasonOf(vaults.listEntries({ vaultId: tools.id }).pipe(as(people.member.id))),
        "not-found",
      );
    }),
);

// Owned-resources 04: every User's own Vault.

it.effect("a User's own Vault is theirs alone; the Owner reads its names and Variables", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const grace = people.member.id;
    const [mineRow] = yield* setup.server.sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM vault_groups
      WHERE owner_kind = 'user' AND owner_id = ${grace} AND is_default = 1
    `;
    const graceDefault = VaultGroupId.make(mineRow!.groupId);
    // She adds a Secret and a Variable, and a group of her own; she never removes `default`.
    yield* vaults
      .putEntry({ vaultId: graceDefault, name: "GRACE_TOKEN", value: Redacted.make(ACME_OWN) })
      .pipe(as(grace));
    yield* vaults
      .putEntry({
        vaultId: graceDefault,
        name: "GRACE_REGION",
        value: Redacted.make("eu-west-1"),
        class: "variable",
      })
      .pipe(as(grace));
    const side = yield* vaults.create({ name: "Side project", owner: mine(grace) }).pipe(as(grace));
    assert.deepEqual([side.canEdit, side.canManage], [true, true]);
    assert.equal(
      yield* reasonOf(vaults.remove({ vaultId: graceDefault }).pipe(as(grace))),
      "default-group",
    );
    // A name that changes how tools run: hers, once she confirms.
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: graceDefault, name: "NODE_OPTIONS", value: Redacted.make("--x=1") })
          .pipe(as(grace)),
      ),
      "confirm-dangerous",
    );
    yield* vaults
      .putEntry({
        vaultId: graceDefault,
        name: "NODE_OPTIONS",
        value: Redacted.make("--max-old-space-size=4096"),
        confirmDangerous: true,
      })
      .pipe(as(grace));

    // The Owner reads its names and Variables, and changes nothing.
    const asOwner = yield* vaults.listEntries({ vaultId: graceDefault }).pipe(as(ownerId));
    assert.deepEqual(
      asOwner.entries.map((entry) => [entry.name, entry.value ?? null]),
      [
        ["GRACE_REGION", "eu-west-1"],
        ["GRACE_TOKEN", null],
        ["NODE_OPTIONS", null],
      ],
    );
    assert.deepEqual([asOwner.group.canEdit, asOwner.group.canManage], [false, false]);
    assert.isFalse(mentionsAValue(JSON.stringify(asOwner)));
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: graceDefault, name: "OWNERS", value: Redacted.make("x".repeat(9)) })
          .pipe(as(ownerId)),
      ),
      "forbidden",
    );
    assert.equal(
      yield* reasonOf(vaults.update({ vaultId: side.id, name: "Owner's now" }).pipe(as(ownerId))),
      "forbidden",
    );
    assert.equal(
      yield* reasonOf(vaults.create({ name: "For Grace", owner: mine(grace) }).pipe(as(ownerId))),
      "forbidden",
    );
    // Nobody else sees it, her Organization's Admin included.
    for (const who of [people.admin.id, people.guest.id, people.otherAdmin.id]) {
      assert.equal(
        yield* reasonOf(vaults.listEntries({ vaultId: graceDefault }).pipe(as(who))),
        "not-found",
      );
      const theirs = yield* vaults.list.pipe(as(who));
      assert.notInclude(
        theirs.groups.map((group) => group.id),
        graceDefault,
      );
    }
  }),
);
