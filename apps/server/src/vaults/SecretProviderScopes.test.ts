/**
 * Provider scopes (Vaults ticket 03): the Owner's alone; an Admin adds Provider entries only
 * through a scope allowed to their Vault and inside its paths, checked at save and again when
 * read; a change that breaks entries asks first; «Test connection» says classes, never values.
 */
import {
  ProviderScopePutInput,
  SecretProviderId,
  SpaceId,
  UserId,
  type ProviderScopeId,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttpWith,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as ProviderReads from "./ProviderReads.ts";
import { FAKE_PROVIDER_ID, makeFakeSecretProvider } from "./ProviderReads.testkit.ts";
import * as SecretProviderScopes from "./SecretProviderScopes.ts";
import * as Vaults from "./Vaults.ts";

const hub = Effect.gen(function* () {
  const provider = makeFakeSecretProvider();
  const server = yield* serveAuthHttpWith({ providerReads: provider.options });
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const made = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  const acmeId = SpaceId.make(made.body.id as string);
  const person = Effect.fn(function* (id: string, role: "admin" | "member" | "guest") {
    yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, acmeId, id, role);
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return UserId.make(id);
  });
  const admin = yield* person("ada", "admin");
  const member = yield* person("grace", "member");
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
    admin,
    member,
  ]);
  const vaults = Context.get(server.services, Vaults.Vaults);
  const scopes = Context.get(server.services, SecretProviderScopes.SecretProviderScopes);
  const reads = Context.get(server.services, ProviderReads.ProviderReads);
  const as = (userId: UserId) => CommandActor.actAs(userId);
  const acme = yield* vaults.create({ name: "Acme secrets", spaceId: acmeId }).pipe(as(ownerId));
  const other = yield* vaults.create({ name: "Other", spaceId: acmeId }).pipe(as(ownerId));
  const putScope = (input: Omit<ProviderScopePutInput, "providerId">, userId: UserId = ownerId) =>
    scopes.put({ providerId: FAKE_PROVIDER_ID, ...input }).pipe(as(userId));
  const putEntry = (userId: UserId, name: string, reference: string, scopeId?: ProviderScopeId) =>
    vaults
      .putEntry({
        vaultId: acme.id,
        name,
        provider: {
          providerId: FAKE_PROVIDER_ID,
          reference,
          ...(scopeId === undefined ? {} : { scopeId }),
        },
      })
      .pipe(as(userId));
  return {
    server,
    provider,
    ownerId,
    admin,
    member,
    vaults,
    scopes,
    reads,
    as,
    acme,
    other,
    putScope,
    putEntry,
  };
});

const reasonOf = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

it.effect("only the Owner manages scopes and tests providers; Admins and Members are refused", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    for (const who of [h.admin, h.member]) {
      assert.equal(
        yield* reasonOf(h.putScope({ label: "Acme", auth: {}, allowedPaths: ["kv/acme"] }, who)),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(h.scopes.test({ providerId: FAKE_PROVIDER_ID }).pipe(h.as(who))),
        "forbidden",
      );
      assert.equal(yield* reasonOf(h.scopes.list.pipe(h.as(who))), "forbidden");
    }
    const made = yield* h.putScope({
      label: "Acme",
      auth: { role: "acme" },
      allowedPaths: ["kv/acme"],
    });
    assert.deepEqual(made.scope?.auth, { role: "acme" });
  }),
);

it.effect("a scope's auth holds only its known non-secret fields; anything else is refused", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const decode = Schema.decodeUnknownEffect(ProviderScopePutInput);
    const base = { providerId: "vault", label: "Acme", allowedPaths: ["kv/acme"] };
    // At the door: the payload does not decode.
    for (const auth of [
      { token: "s.secret" },
      { role: "acme", password: "x" },
      { secret_id: "y" },
    ]) {
      yield* decode({ ...base, auth }).pipe(Effect.flip);
    }
    yield* decode({ ...base, auth: { role: "acme", mount: "kv", namespace: "acme" } });
    // And in the service, for a caller that skipped it.
    assert.equal(
      yield* reasonOf(
        h.putScope({ label: "Acme", auth: { token: "s.secret" }, allowedPaths: ["kv/acme"] }),
      ),
      "invalid",
    );
  }),
);

it.effect("a scope's probe path must be inside its allowed paths, at save and when tested", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    for (const probe of ["kv/globex#token", "kv/acme-evil#token", "kv/acme/../globex#token"]) {
      assert.equal(
        yield* reasonOf(
          h.putScope({
            label: "Acme",
            auth: {},
            allowedPaths: ["kv/acme"],
            probeReference: probe,
          }),
        ),
        "invalid",
        probe,
      );
    }
    const made = yield* h.putScope({
      label: "Acme",
      auth: {},
      allowedPaths: ["kv/acme"],
      probeReference: "kv/acme/probe#token",
    });
    h.provider.state.answer = () => ({ _tag: "value", value: "probe-secret-value-0001" });
    const tested = yield* h.scopes
      .test({ providerId: FAKE_PROVIDER_ID, scopeId: made.scope!.id })
      .pipe(h.as(h.ownerId));
    assert.deepEqual(tested, { auth: { ok: true }, probe: { ok: true } });
    assert.notInclude(JSON.stringify(tested), "probe-secret-value-0001");
    assert.deepEqual(h.provider.state.batches.at(-1), ["kv/acme/probe#token"]);
    // Narrowed since (behind the service's back): the probe is not read any more.
    yield* h.server.sql`
      UPDATE secret_provider_scopes SET allowed_paths_json = '["kv/other"]'
      WHERE scope_id = ${made.scope!.id}
    `;
    const reads = h.provider.state.batches.length;
    assert.equal(
      yield* reasonOf(
        h.scopes
          .test({ providerId: FAKE_PROVIDER_ID, scopeId: made.scope!.id })
          .pipe(h.as(h.ownerId)),
      ),
      "invalid",
    );
    assert.lengthOf(h.provider.state.batches, reads);
  }),
);

it.effect(
  "an Admin adds a Provider entry only through a scope allowed to the Vault, inside its paths",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const scope = (yield* h.putScope({ label: "Acme", auth: {}, allowedPaths: ["kv/acme"] }))
        .scope!;
      // Not yet allowed to the Vault; and never «Direct» for an Admin.
      assert.equal(
        yield* reasonOf(h.putEntry(h.admin, "A_TOKEN", "kv/acme/app#token", scope.id)),
        "invalid-reference",
      );
      assert.equal(
        yield* reasonOf(h.putEntry(h.admin, "A_TOKEN", "kv/acme/app#token")),
        "forbidden",
      );
      yield* h.scopes
        .allow({ scopeId: scope.id, vaultId: h.acme.id, allowed: true })
        .pipe(h.as(h.ownerId));
      // The prefix itself, and what lies under it, pass.
      for (const [name, reference] of [
        ["EXACT", "kv/acme"],
        ["UNDER", "kv/acme/app#token"],
        ["FIELD", "kv/acme#token"],
      ] as const) {
        const added = yield* h.putEntry(h.admin, name, reference, scope.id);
        assert.deepEqual(added.entry.provider?.scope, "Acme");
      }
      // A sibling sharing its letters, another case, and path tricks do not.
      for (const reference of [
        "kv/acme-evil/x#token",
        "kv/acmex#token",
        "KV/acme/app#token",
        "kv/Acme/app#token",
        "kv/acme/../globex#token",
        "kv/acme//app#token",
        "kv/acme%2fapp#token",
        "kv/acme/%2e%2e/globex#token",
      ]) {
        assert.equal(
          yield* reasonOf(h.putEntry(h.admin, "BAD", reference, scope.id)),
          "invalid-reference",
          reference,
        );
      }
      // A Member, never.
      assert.equal(
        yield* reasonOf(h.putEntry(h.member, "M_TOKEN", "kv/acme/app#token", scope.id)),
        "forbidden",
      );
    }),
);

it.effect(
  "narrowing, deleting or taking back a scope asks first, then its entries are broken",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const scope = (yield* h.putScope({ label: "Acme", auth: {}, allowedPaths: ["kv/acme"] }))
        .scope!;
      yield* h.scopes
        .allow({ scopeId: scope.id, vaultId: h.acme.id, allowed: true })
        .pipe(h.as(h.ownerId));
      const app = (yield* h.putEntry(h.admin, "APP_TOKEN", "kv/acme/app#token", scope.id)).entry;
      yield* h.putEntry(h.admin, "DB_TOKEN", "kv/acme/db#token", scope.id);
      const brokenNames = Effect.gen(function* () {
        const listed = yield* h.vaults.listEntries({ vaultId: h.acme.id }).pipe(h.as(h.ownerId));
        return listed.entries.filter((entry) => entry.broken).map((entry) => entry.name);
      });
      // Narrowed to `kv/acme/db`: APP_TOKEN would break; nothing changes until confirmed.
      const narrow = { scopeId: scope.id, label: "Acme", auth: {}, allowedPaths: ["kv/acme/db"] };
      const asked = yield* h.putScope(narrow);
      assert.deepEqual(
        [asked.scope, asked.breaks.map((entry) => entry.name)],
        [null, ["APP_TOKEN"]],
      );
      assert.deepEqual(yield* brokenNames, []);
      yield* h.putScope({ ...narrow, confirm: true });
      assert.deepEqual(yield* brokenNames, ["APP_TOKEN"]);
      // Checked again when read: the broken entry is never asked of the provider.
      const read = yield* h.reads.read([
        {
          providerId: FAKE_PROVIDER_ID,
          scopeId: scope.id,
          reference: "kv/acme/app#token",
          vaultId: h.acme.id,
        },
      ]);
      assert.deepEqual(read, [{ _tag: "broken" }]);
      assert.lengthOf(h.provider.state.batches, 0);
      // Taken back from the Vault: asks, then every entry of the scope there is broken.
      const takeBack = { scopeId: scope.id, vaultId: h.acme.id, allowed: false };
      assert.lengthOf((yield* h.scopes.allow(takeBack).pipe(h.as(h.ownerId))).breaks, 2);
      assert.deepEqual(yield* brokenNames, ["APP_TOKEN"]);
      yield* h.scopes.allow({ ...takeBack, confirm: true }).pipe(h.as(h.ownerId));
      assert.deepEqual(yield* brokenNames, ["APP_TOKEN", "DB_TOKEN"]);
      // Deleted: asks, then gone.
      assert.isFalse((yield* h.scopes.remove({ scopeId: scope.id }).pipe(h.as(h.ownerId))).deleted);
      assert.isTrue(
        (yield* h.scopes.remove({ scopeId: scope.id, confirm: true }).pipe(h.as(h.ownerId)))
          .deleted,
      );
      assert.deepEqual(yield* brokenNames, ["APP_TOKEN", "DB_TOKEN"]);
      // The impact of deleting the provider names its entries, never a value.
      const impact = yield* h.scopes.impact({ providerId: FAKE_PROVIDER_ID }).pipe(h.as(h.ownerId));
      assert.deepEqual(
        impact.breaks.map((entry) => entry.name),
        ["APP_TOKEN", "DB_TOKEN"],
      );
      assert.equal(app.name, "APP_TOKEN");
    }),
);

it.effect("a provider change is audited by field names, never with a credential's value", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const credential = "known-provider-credential-0002";
    const before = {} as ServerSettings["secretProviders"];
    const after = {
      [SecretProviderId.make("bao")]: {
        kind: "credentialed",
        label: "Bao",
        config: { address: "https://bao.example", token: credential },
      },
    } as unknown as ServerSettings["secretProviders"];
    yield* h.scopes.recordProviderChanges(before, after).pipe(h.as(h.ownerId));
    yield* h.scopes
      .recordProviderChanges(after, {
        [SecretProviderId.make("bao")]: {
          kind: "credentialed",
          label: "Bao",
          config: { address: "https://bao.example", token: `${credential}-rotated` },
        },
      } as unknown as ServerSettings["secretProviders"])
      .pipe(h.as(h.ownerId));
    yield* h.scopes.recordProviderChanges(after, {}).pipe(h.as(h.ownerId));
    const rows = yield* h.server.sql<{ readonly action: string; readonly detail: string }>`
      SELECT action, detail_json AS detail FROM audit_log WHERE action LIKE 'secret_provider.%'
      ORDER BY audit_id
    `;
    assert.deepEqual(
      rows.map((row) => [row.action, JSON.parse(row.detail)]),
      [
        ["secret_provider.create", { kind: "credentialed", changed: "label, address, token" }],
        ["secret_provider.update", { kind: "credentialed", changed: "token" }],
        ["secret_provider.delete", { kind: "credentialed" }],
      ],
    );
    assert.notInclude(JSON.stringify(rows), credential);
    void Redacted;
  }),
);

it.effect(
  "a Vault's editors see its usable scopes, never their auth; only the Owner sees «Direct»",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const scope = (yield* h.putScope({
        label: "Acme",
        auth: { role: "acme-reader" },
        allowedPaths: ["kv/acme"],
      })).scope!;
      yield* h.scopes
        .allow({ scopeId: scope.id, vaultId: h.acme.id, allowed: true })
        .pipe(h.as(h.ownerId));
      const forAdmin = yield* h.vaults.providerScopes({ vaultId: h.acme.id }).pipe(h.as(h.admin));
      assert.deepEqual(
        forAdmin.scopes.map((item) => [item.label, item.allowedPaths]),
        [["Acme", ["kv/acme"]]],
      );
      assert.deepEqual(forAdmin.direct, []);
      assert.notInclude(JSON.stringify(forAdmin), "acme-reader");
      const forOwner = yield* h.vaults.providerScopes({ vaultId: h.acme.id }).pipe(h.as(h.ownerId));
      assert.deepEqual(
        forOwner.direct.map((item) => item.providerId),
        [FAKE_PROVIDER_ID],
      );
      // Another Vault the scope is not allowed to: none. A Member edits nothing: refused.
      assert.deepEqual(
        (yield* h.vaults.providerScopes({ vaultId: h.other.id }).pipe(h.as(h.admin))).scopes,
        [],
      );
      assert.equal(
        yield* reasonOf(h.vaults.providerScopes({ vaultId: h.acme.id }).pipe(h.as(h.member))),
        "forbidden",
      );
      // «Test connection» and the scope changes are audited, by name.
      yield* h.scopes
        .test({ providerId: FAKE_PROVIDER_ID, scopeId: scope.id })
        .pipe(h.as(h.ownerId));
      const actions = yield* h.server.sql<{ readonly action: string }>`
      SELECT action FROM audit_log
      WHERE action LIKE 'provider_scope.%' OR action = 'secret_provider.test' ORDER BY audit_id
    `;
      assert.deepEqual(
        actions.map((row) => row.action),
        ["provider_scope.create", "provider_scope.allow", "secret_provider.test"],
      );
    }),
);
