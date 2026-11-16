/**
 * Vaults, their secrets and who may edit or read them (spec 5 «Vaults», ticket 02): the Owner,
 * an Admin, a Member and a Guest of Acme, and an Admin of Globex. Values never leave the Hub but
 * through the Owner's reveal, and never reach the database, the audit log, a log or a span.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the store's files and the database.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  MAIN_VAULT_ID,
  SpaceId,
  UserId,
  type VaultEntryId,
  type VaultError,
  type VaultId,
} from "@t3tools/contracts";
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

const hub = Effect.gen(function* () {
  const provider = makeFakeSecretProvider();
  const server = yield* serveAuthHttpWith({ providerReads: provider.options });
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
  return {
    server,
    provider,
    authenticator,
    owner,
    ownerId,
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
  };
});

type Hub = Effect.Success<typeof hub>;

/**
 * The Owner's setup: GITHUB_TOKEN in the Main vault; «Acme secrets» with a link, a copy, its own.
 * Revealable ones (reveal allowed when added), as every secret was before sealing.
 */
const acmeSecrets = Effect.fn(function* ({ vaults, as, ownerId, acmeId }: Hub) {
  const github = yield* vaults
    .putEntry({
      vaultId: MAIN_VAULT_ID,
      name: "GITHUB_TOKEN",
      value: Redacted.make(ORIGINAL),
      allowReveal: true,
    })
    .pipe(as(ownerId));
  const acme = yield* vaults.create({ name: "Acme secrets", spaceId: acmeId }).pipe(as(ownerId));
  const link = yield* vaults
    .linkEntry({ vaultId: acme.id, sourceEntryId: github.entry.id })
    .pipe(as(ownerId));
  const copy = yield* vaults
    .copyEntry({ vaultId: acme.id, sourceEntryId: github.entry.id, name: "GITHUB_TOKEN_COPY" })
    .pipe(as(ownerId));
  const own = yield* vaults
    .putEntry({
      vaultId: acme.id,
      name: "ACME_API_KEY",
      value: Redacted.make(ACME_OWN),
      allowReveal: true,
    })
    .pipe(as(ownerId));
  return { github: github.entry, acme, link: link.entry, copy: copy.entry, own: own.entry };
});

/** Drops an entry's sealed file: a read of it now fails, so an answer that is not a failure never read it. */
const dropValueFile = (setup: Hub, entryId: string) =>
  setup.valueFileOf(entryId).pipe(Effect.map((file) => NodeFS.rmSync(file)));

const auditOps = (setup: Hub, name: string) =>
  setup.server.sql<{ readonly detail_json: string }>`
    SELECT detail_json FROM audit_log WHERE action = 'secret.edit' AND target_name = ${name}
    ORDER BY audit_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const detail = JSON.parse(row.detail_json) as { op: string; class?: string };
        return detail.class === undefined ? detail.op : `${detail.op}:${detail.class}`;
      }),
    ),
  );

const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const mentionsAValue = (text: string) => VALUES.some((value) => text.includes(value));

it.effect("the Main vault exists from the start and is the Owner's alone", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const listed = yield* vaults.list.pipe(as(ownerId));
    assert.equal(listed.vaults[0]?.id, MAIN_VAULT_ID);
    assert.isTrue(listed.vaults[0]?.isMain);
    assert.equal(
      yield* reasonOf(vaults.remove({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId))),
      "main-vault",
    );
    for (const who of Object.values(people)) {
      const theirs = yield* vaults.list.pipe(as(who.id));
      assert.notInclude(
        theirs.vaults.map((vault) => vault.id),
        MAIN_VAULT_ID,
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: MAIN_VAULT_ID, name: "MINE", value: Redacted.make("x".repeat(9)) })
            .pipe(as(who.id)),
        ),
        "not-found",
      );
    }
  }),
);

it.effect(
  "only the Owner creates, manages, links and copies; Admins edit their own Organization's",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, people, acmeId, globexId } = setup;
      const { acme, github, own } = yield* acmeSecrets(setup);
      const globex = yield* vaults
        .create({ name: "Globex secrets", spaceId: globexId })
        .pipe(as(setup.ownerId));

      for (const who of Object.values(people)) {
        assert.equal(
          yield* reasonOf(
            vaults.create({ name: `${who.id} vault`, spaceId: acmeId }).pipe(as(who.id)),
          ),
          "forbidden",
          `${who.id} created a Vault`,
        );
      }
      // Acme's Admin: their Organization's Vault, without reading; nothing else.
      const { admin } = people;
      const seen = yield* vaults.list.pipe(as(admin.id));
      assert.deepEqual(
        seen.vaults.map((vault) => [vault.name, vault.canEdit, vault.canManage, vault.canReveal]),
        [["Acme secrets", true, false, false]],
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
      assert.equal(
        yield* reasonOf(vaults.update({ vaultId: acme.id, name: "Mine now" }).pipe(as(admin.id))),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(vaults.remove({ vaultId: acme.id }).pipe(as(admin.id))),
        "forbidden",
      );
      // A link or a copy would hand the Main vault's value to Acme: the Owner's alone.
      assert.equal(
        yield* reasonOf(
          vaults
            .linkEntry({ vaultId: acme.id, sourceEntryId: github.id, name: "STOLEN" })
            .pipe(as(admin.id)),
        ),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .copyEntry({ vaultId: acme.id, sourceEntryId: github.id, name: "STOLEN" })
            .pipe(as(admin.id)),
        ),
        "forbidden",
      );
      // Another Organization's Vault is not there for them.
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
        assert.isFalse(listed.vault.canEdit);
        // A link's original is the Owner's to know.
        assert.isTrue(listed.entries.every((entry) => entry.linkedFrom === null));
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
        theirs.vaults.map((vault) => vault.name),
        ["Globex secrets"],
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
      inAcme.vaults.map((vault) => vault.id),
      [acme.id],
    );
    const inGlobex = yield* vaults.list.pipe(as(people.admin.id, globexId));
    assert.deepEqual(inGlobex.vaults, []);
    assert.equal(
      yield* reasonOf(vaults.listEntries({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId, acmeId))),
      "not-found",
    );
  }),
);

it.effect(
  "only the Owner reveals, with a strong factor in the request, audited without the value",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, people, owner, reveal } = setup;
      const { acme, own, link } = yield* acmeSecrets(setup);
      for (const [who, { cookie, id }] of Object.entries(people)) {
        // Refused by the policy itself, whatever factor they would show.
        assert.oneOf(
          yield* reasonOf(
            setup.vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(setup.as(id)),
          ),
          ["forbidden", "not-found"],
          `${who} revealed a value`,
        );
        const refused = yield* reveal(cookie, acme.id, own.id, BOGUS_REAUTH);
        assert.oneOf(refused.status, [403, 404], `${who} revealed a value`);
        assert.isFalse(mentionsAValue(JSON.stringify(refused.body)));
      }
      const bare = yield* reveal(owner, acme.id, own.id, BOGUS_REAUTH);
      assert.equal(bare.status, 403);
      assert.isFalse(mentionsAValue(JSON.stringify(bare.body)));
      const audited = yield* server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.reveal'
    `;
      assert.equal(audited[0]?.n, 0);

      const shown = yield* reveal(
        owner,
        acme.id,
        own.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(shown.status, 200);
      assert.deepEqual(shown.body, { name: "ACME_API_KEY", value: ACME_OWN });
      // A link shows its original's value.
      const linked = yield* reveal(
        owner,
        acme.id,
        link.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(linked.body.value, ORIGINAL);
      const [entry] = yield* server.sql<{
        readonly detail_json: string;
        readonly target_name: string;
      }>`
      SELECT detail_json, target_name FROM audit_log WHERE action = 'secret.reveal' ORDER BY audit_id LIMIT 1
    `;
      assert.equal(entry?.target_name, "ACME_API_KEY");
      assert.deepEqual(JSON.parse(entry?.detail_json ?? "{}"), {
        vault: "Acme secrets",
        vaultId: acme.id,
        kind: "own",
      });
    }),
);

it.effect("rotating the original changes what its Secret links hold; a copy keeps its value", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId } = setup;
    const { acme, github, link, copy } = yield* acmeSecrets(setup);
    const revealOf = (entryId: VaultEntryId, vaultId: VaultId = acme.id) =>
      vaults.reveal({ vaultId, entryId }).pipe(
        as(ownerId),
        Effect.map((shown) => Redacted.value(shown.value)),
      );
    assert.equal(yield* revealOf(link.id), ORIGINAL);
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        entryId: github.id,
        name: github.name,
        value: Redacted.make(ROTATED),
      })
      .pipe(as(ownerId));
    assert.equal(yield* revealOf(link.id), ROTATED);
    assert.equal(yield* revealOf(copy.id), ORIGINAL);
    const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
    assert.deepEqual(listed.entries.find((entry) => entry.id === link.id)?.linkedFrom, {
      entryId: github.id,
      name: "GITHUB_TOKEN",
    });
    // A link's value is the Main vault's: replacing it here is refused.
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({
            vaultId: acme.id,
            entryId: link.id,
            name: link.name,
            value: Redacted.make("q".repeat(9)),
          })
          .pipe(as(ownerId)),
      ),
      "not-linkable",
    );
  }),
);

it.effect(
  "deleting an original lists the links it breaks, which stay «broken» and reveal nothing",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId } = setup;
      const { acme, github, link } = yield* acmeSecrets(setup);
      const asked = yield* vaults
        .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: github.id })
        .pipe(as(ownerId));
      assert.isFalse(asked.deleted);
      assert.deepEqual(
        asked.brokenLinks.map((broken) => [broken.vaultName, broken.name]),
        [["Acme secrets", "GITHUB_TOKEN"]],
      );
      const done = yield* vaults
        .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: github.id, breakLinks: true })
        .pipe(as(ownerId));
      assert.isTrue(done.deleted);
      const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      const broken = listed.entries.find((entry) => entry.id === link.id);
      assert.isTrue(broken?.broken);
      assert.equal(
        yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: link.id }).pipe(as(ownerId))),
        "not-found",
      );
    }),
);

// Spec «Variables y Secrets sellados», ticket 01.

it.effect(
  "a new Secret is sealed: nobody reveals it, its copies or links, and its value is never read",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, vaults, as, ownerId, owner, reveal } = setup;
      const { acme } = yield* acmeSecrets(setup);
      const sealed = yield* vaults
        .putEntry({ vaultId: acme.id, name: "SEALED_TOKEN", value: Redacted.make(ACME_OWN) })
        .pipe(as(ownerId));
      assert.deepEqual([sealed.entry.class, sealed.entry.sealed], ["secret", true]);
      assert.notProperty(sealed.entry, "value");
      yield* dropValueFile(setup, sealed.entry.id);
      assert.equal(
        yield* reasonOf(
          vaults.reveal({ vaultId: acme.id, entryId: sealed.entry.id }).pipe(as(ownerId)),
        ),
        "sealed",
      );
      // Over HTTP: refused before the strong factor is checked (a bogus one gets 409, not 403).
      const refused = yield* reveal(owner, acme.id, sealed.entry.id, BOGUS_REAUTH);
      assert.equal(refused.status, 409);
      assert.isFalse(mentionsAValue(JSON.stringify(refused.body)));

      // A copy of a sealed Secret is sealed; a link shows its original's class and seal.
      const mainSealed = yield* vaults
        .putEntry({ vaultId: MAIN_VAULT_ID, name: "MAIN_SEALED", value: Redacted.make(ROTATED) })
        .pipe(as(ownerId));
      const copy = yield* vaults
        .copyEntry({ vaultId: acme.id, sourceEntryId: mainSealed.entry.id, name: "SEALED_COPY" })
        .pipe(as(ownerId));
      const link = yield* vaults
        .linkEntry({ vaultId: acme.id, sourceEntryId: mainSealed.entry.id })
        .pipe(as(ownerId));
      for (const entry of [copy.entry, link.entry]) {
        assert.deepEqual([entry.class, entry.sealed], ["secret", true], entry.name);
        assert.equal(
          yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: entry.id }).pipe(as(ownerId))),
          "sealed",
          entry.name,
        );
      }
      const audited = yield* server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.reveal'
      `;
      assert.equal(audited[0]?.n, 0);
    }),
);

it.effect(
  "sealing is one way; allowing reveal or making a Variable takes a new value, the old never read",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, people } = setup;
      const { acme, own, link } = yield* acmeSecrets(setup);
      const put = (input: Omit<Parameters<typeof vaults.putEntry>[0], "vaultId">) =>
        vaults.putEntry({ vaultId: acme.id, ...input });
      // A Member edits nothing, sealing included.
      assert.equal(
        yield* reasonOf(
          put({ entryId: own.id, name: own.name, allowReveal: false }).pipe(as(people.member.id)),
        ),
        "forbidden",
      );
      // An Admin seals the Owner's revealable secret, without a value.
      const sealed = yield* put({ entryId: own.id, name: own.name, allowReveal: false }).pipe(
        as(people.admin.id),
      );
      assert.isTrue(sealed.entry.sealed);
      assert.equal(
        yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId))),
        "sealed",
      );
      // Undoing it without a new value is refused, even to the Owner.
      assert.equal(
        yield* reasonOf(
          put({ entryId: own.id, name: own.name, allowReveal: true }).pipe(as(ownerId)),
        ),
        "needs-new-value",
      );
      // With one, it is allowed and the sealed value is never read (its file is gone).
      yield* dropValueFile(setup, own.id);
      const allowed = yield* put({
        entryId: own.id,
        name: own.name,
        allowReveal: true,
        value: Redacted.make(ADMIN_REPLACES),
      }).pipe(as(people.admin.id));
      assert.isFalse(allowed.entry.sealed);
      const shown = yield* vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(
        as(ownerId),
        Effect.map((revealed) => Redacted.value(revealed.value)),
      );
      assert.equal(shown, ADMIN_REPLACES);

      // A Secret becomes a Variable only with a new value, whoever edits.
      for (const who of [ownerId, people.admin.id]) {
        assert.equal(
          yield* reasonOf(
            put({ entryId: own.id, name: own.name, class: "variable" }).pipe(as(who)),
          ),
          "needs-new-value",
        );
      }
      const variable = yield* put({
        entryId: own.id,
        name: own.name,
        class: "variable",
        value: Redacted.make("https://api.acme.example"),
      }).pipe(as(people.admin.id));
      assert.deepEqual(
        [variable.entry.class, variable.entry.sealed, variable.entry.value],
        ["variable", false, "https://api.acme.example"],
      );
      // Back to a Secret: whoever edits, and it is sealed.
      const secret = yield* put({ entryId: own.id, name: own.name, class: "secret" }).pipe(
        as(people.admin.id),
      );
      assert.deepEqual([secret.entry.class, secret.entry.sealed], ["secret", true]);
      assert.notProperty(secret.entry, "value");
      assert.deepEqual(yield* auditOps(setup, own.name), [
        "add",
        "seal",
        "allow-reveal",
        "replace",
        "class:variable",
        "replace",
        "class:secret",
      ]);

      // A link is what its original is: neither its class nor its seal changes here.
      for (const change of [{ class: "variable" as const }, { allowReveal: false }]) {
        assert.equal(
          yield* reasonOf(put({ entryId: link.id, name: link.name, ...change }).pipe(as(ownerId))),
          "not-linkable",
        );
      }
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
    // A Main vault Variable linked and copied in: the link and the copy are Variables too.
    const cluster = yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        name: "KUBE_SERVER",
        value: Redacted.make("https://k3s.example:6443"),
        class: "variable",
      })
      .pipe(as(ownerId));
    yield* vaults
      .linkEntry({ vaultId: acme.id, sourceEntryId: cluster.entry.id })
      .pipe(as(ownerId));
    yield* vaults
      .copyEntry({ vaultId: acme.id, sourceEntryId: cluster.entry.id, name: "KUBE_SERVER_COPY" })
      .pipe(as(ownerId));

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
          .putEntry({ vaultId: MAIN_VAULT_ID, name, value: Redacted.make(value) })
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
                vaultId: MAIN_VAULT_ID,
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
      const { server, vaults, as, people, owner, valuesDir } = setup;
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
          .putEntry({ vaultId: MAIN_VAULT_ID, name: "GITHUB_TOKEN", value: Redacted.make(ROTATED) })
          .pipe(as(people.admin.id)),
      );
      assert.isFalse(mentionsAValue(JSON.stringify(refused) + refused.message));
      const shown = yield* setup.reveal(
        owner,
        acme.id,
        own.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(shown.body.value, ADMIN_REPLACES);

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
      // GITHUB_TOKEN, its copy and ACME_API_KEY hold values; the link holds none.
      assert.lengthOf(valueFiles(), 3);
      yield* vaults
        .putEntry({ vaultId: acme.id, entryId: own.id, name: "ACME_RENAMED" })
        .pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 3);
      yield* vaults.deleteEntry({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 2);
      yield* vaults.remove({ vaultId: acme.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 1);

      // A replace leaves one value, the new one.
      const github = (yield* vaults.listEntries({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId)))
        .entries[0]!;
      yield* vaults
        .putEntry({
          vaultId: MAIN_VAULT_ID,
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
    const { vaults, as, ownerId, store, valueFileOf } = setup;
    const { acme, own, copy } = yield* acmeSecrets(setup);
    const directory = store.directory ?? "";
    NodeFS.copyFileSync(yield* valueFileOf(own.id), yield* valueFileOf(copy.id));
    assert.equal(
      yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: copy.id }).pipe(as(ownerId))),
      "storage",
    );
    // A Hub secret (another purpose) moved under a Vault value's name does not open either.
    const hubSecret = NodeFS.readdirSync(directory).find((file) => file.endsWith(".sealed"));
    assert.isDefined(hubSecret);
    NodeFS.copyFileSync(NodePath.join(directory, hubSecret!), yield* valueFileOf(own.id));
    assert.equal(
      yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId))),
      "storage",
    );
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
      const shown = yield* vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId));
      assert.equal(Redacted.value(shown.value), ACME_OWN);
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

it.effect("a link tells those who do not see the Main vault nothing of its original", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const acme = yield* vaults
      .create({ name: "Acme secrets", spaceId: setup.acmeId })
      .pipe(as(ownerId));
    const pin = yield* vaults
      .putEntry({ vaultId: MAIN_VAULT_ID, name: "SHORT_PIN", value: Redacted.make("1234") })
      .pipe(as(ownerId));
    const link = yield* vaults
      .linkEntry({ vaultId: acme.id, sourceEntryId: pin.entry.id })
      .pipe(as(ownerId));
    const seen = (who: UserId) =>
      vaults.listEntries({ vaultId: acme.id }).pipe(
        as(who),
        Effect.map((listed) => listed.entries.find((entry) => entry.id === link.entry.id)!),
      );
    assert.isTrue((yield* seen(ownerId)).unmasked);
    for (const who of [people.admin, people.member, people.guest]) {
      const entry = yield* seen(who.id);
      assert.isFalse(entry.unmasked, `${who.id} learnt the original is short`);
      assert.isNull(entry.linkedFrom);
    }
    const rotatedAt = (yield* seen(people.member.id)).updatedAt;
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        entryId: pin.entry.id,
        name: "SHORT_PIN",
        value: Redacted.make("a-much-longer-value"),
      })
      .pipe(as(ownerId));
    const after = yield* seen(people.member.id);
    assert.equal(after.version, 1);
    assert.equal(after.updatedAt, rotatedAt);
    yield* vaults
      .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: pin.entry.id, breakLinks: true })
      .pipe(as(ownerId));
    // Its editors learn it broke; its readers do not learn the original is gone.
    assert.isTrue((yield* seen(people.admin.id)).broken);
    assert.isFalse((yield* seen(people.guest.id)).broken);
    assert.isFalse((yield* seen(people.member.id)).broken);
  }),
);

it.effect("a joined machine has no Vaults: nothing is written, every call says so", () =>
  Effect.gen(function* () {
    const { server, as, ownerId } = yield* hub;
    yield* server.sql`DELETE FROM vaults`;
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
      SELECT (SELECT COUNT(*) FROM vaults) + (SELECT COUNT(*) FROM vault_key_check) AS n
    `;
    assert.equal(rows[0]?.n, 0);
    assert.equal(yield* reasonOf(vaults.list.pipe(as(ownerId))), "unavailable");
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({ vaultId: MAIN_VAULT_ID, name: "X_TOKEN", value: Redacted.make("long-value") })
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
    yield* server.sql`DELETE FROM vaults`;
    yield* server.sql`
      UPDATE vault_key_check SET key_id = ${stranger.id},
        sealed = ${SecretCipher.seal(stranger, "key-check", "vault_key_check", new TextEncoder().encode("t3code vault key check"))}
    `;
    const failed = yield* Effect.flip(
      Layer.build(Vaults.layer.pipe(Layer.provide(Layer.succeedContext(server.services)))),
    );
    assert.equal(failed._tag, "MasterKeyError");
    const rows = yield* server.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM vaults`;
    assert.equal(rows[0]?.n, 0, "the Main vault was written before the key check");
  }),
);

// Ticket 02 of «Variables, Secretos sellados y Secret providers»: Provider entries.

it.effect(
  "only the Owner adds a Provider entry: a sealed Secret nobody reveals, its path for editors",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId, people, provider, server, owner, reveal } = setup;
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
        [added.entry.kind, added.entry.class, added.entry.sealed, added.entry.broken],
        ["provider", "secret", true, false],
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
      // Sealed: refused before the factor, and the provider is never asked.
      assert.equal(
        yield* reasonOf(
          vaults.reveal({ vaultId: acme.id, entryId: added.entry.id }).pipe(as(ownerId)),
        ),
        "sealed",
      );
      assert.equal((yield* reveal(owner, acme.id, added.entry.id, BOGUS_REAUTH)).status, 409);
      assert.lengthOf(provider.state.batches, 0);
      // It takes no value, class or reveal; an Admin changes nothing of it but may delete it.
      for (const change of [
        { value: Redacted.make("x".repeat(9)) },
        { class: "variable" as const },
        { allowReveal: true },
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
          vaultId: MAIN_VAULT_ID,
          name: "MAIN_KUBE",
          provider: { providerId: FAKE_PROVIDER_ID, reference: "kv/main#token" },
        })
        .pipe(as(ownerId));
      assert.equal(
        yield* reasonOf(
          vaults.linkEntry({ vaultId: acme.id, sourceEntryId: main.entry.id }).pipe(as(ownerId)),
        ),
        "not-linkable",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .copyEntry({ vaultId: acme.id, sourceEntryId: main.entry.id, name: "COPIED" })
            .pipe(as(ownerId)),
        ),
        "not-linkable",
      );
      // A provider removed from the settings: «broken», shown to everyone, never read.
      provider.state.providers = {};
      const listed = yield* vaults.listEntries({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId));
      const broken = listed.entries.find((entry) => entry.name === "MAIN_KUBE");
      assert.deepEqual([broken?.broken, broken?.provider?.label], [true, null]);
      assert.lengthOf(provider.state.batches, 0);
    }),
);
