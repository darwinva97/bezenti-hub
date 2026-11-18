/**
 * Spec 5 ticket 09: the Owner and four roles of two Organizations call every Vault door (WS
 * handlers call these services one to one; HTTP over HTTP). No answer holds a Secret's value, the
 * Owner's included (owned-resources 01: nothing reveals), nor a name its caller may not see; a new
 * Vault or secret door not called fails.
 */
// @effect-diagnostics globalJsonInEffect:off -- answers are searched as text.
import {
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  SpaceId,
  ThreadId,
  UserId,
  VaultGroupId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as Grants from "../grants/Grants.ts";
import { lendVaultGroup } from "../grants/Grants.testkit.ts";
import { HTTP_ENDPOINT_RULES, MCP_TOOL_RULES, RAW_ROUTE_RULES } from "../auth/DoorRules.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";
import * as SecretDelivery from "./SecretDelivery.ts";
import { orgOwner, ownersDefault, userOwner } from "./VaultGroups.testkit.ts";
import * as Vaults from "./Vaults.ts";

const MAIN_PRIVATE = "owner-private-value-0101";
const MAIN_LINKED = "main-linked-value-0202";
const ACME_OWN = "acme-own-value-0303";
const GLOBEX_OWN = "globex-own-value-0404";
const SHARED = "owner-shared-acme-0505";
const GRACES = "graces-own-value-0606";
const WRITTEN = "written-by-caller-0707";
const VALUES = [MAIN_PRIVATE, MAIN_LINKED, ACME_OWN, GLOBEX_OWN, SHARED, GRACES, WRITTEN];

/** Names, by who may see them (besides the Owner). */
const ACME_NAMES = ["GITHUB_TOKEN", "GITHUB_TOKEN_COPY", "ACME_API_KEY", "SHARED_KEY"];
const GLOBEX_NAMES = ["GLOBEX_DB_URL"];

/** Doors of Vaults and secrets tested in their own files, with their value checks. */
const SWEPT_ELSEWHERE: Record<string, string> = {
  "ws:secrets.answerRequest": "SecretRequestVaults.test.ts: the card's save, per role",
  "ws:secrets.vaultTargets": "SecretRequestVaults.test.ts: the picker's Vaults, per role",
  "mcp:request_secret": "SecretRequestVaults.test.ts and SecretRequests.test.ts",
  "http:vaults.masterKeyBackup": "MasterKeyHttp.test.ts: the master key, the Owner only",
  "http:vaults.masterKeyBackupConfirm": "MasterKeyHttp.test.ts",
  // Vaults ticket 03: Owner-only Installation RPCs and a Vault's usable scopes, per role.
  "ws:secretProviders.test": "SecretProviderScopes.test.ts: the Owner only, classes never values",
  "ws:secretProviders.impact": "SecretProviderScopes.test.ts: names of what breaks",
  "ws:secretProviders.scopes.list": "SecretProviderScopes.test.ts: the Owner only",
  "ws:secretProviders.scopes.put": "SecretProviderScopes.test.ts: the Owner only",
  "ws:secretProviders.scopes.delete": "SecretProviderScopes.test.ts: the Owner only",
  "ws:secretProviders.scopes.allow": "SecretProviderScopes.test.ts: the Owner only",
  "ws:vaults.providerScopes": "SecretProviderScopes.test.ts: editors, no auth, Direct the Owner's",
};

const RE_VAULTS = /vault|secret/iu;

const HUB = {
  environmentId: HUB_MACHINE_ENVIRONMENT_ID,
  contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
};

const team = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const ownerCookie = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: ownerCookie,
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
    return { name: id, id: UserId.make(id), cookie, spaceId, role };
  });
  const people = [
    { name: "owner", id: ownerId, cookie: ownerCookie, spaceId: null, role: "owner" as const },
    yield* person("ada", acmeId, "admin"),
    yield* person("grace", acmeId, "member"),
    yield* person("linus", acmeId, "guest"),
    yield* person("gus", globexId, "admin"),
    yield* person("gina", globexId, "member"),
    yield* person("otto", globexId, "guest"),
  ];
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged(
    people.map((who) => who.id),
  );
  const vaults = Context.get(server.services, Vaults.Vaults);
  const effective = Context.get(server.services, EffectiveVaults.EffectiveVaults);
  const delivery = Context.get(server.services, SecretDelivery.SecretDelivery);
  const as = (userId: UserId) => CommandActor.actAs(userId);
  const put = (vaultId: VaultGroupId, name: string, value: string) =>
    vaults.putEntry({ vaultId, name, value: Redacted.make(value) }).pipe(as(ownerId));

  // Full Vaults: the Owner's `default` (one kept, one also in Acme's twice, as a former link and
  // copy), Acme's and Globex's own, one of the Owner's allowed to Acme and one to Grace alone.
  const main = yield* ownersDefault(server.sql);
  yield* put(main, "OWNER_PRIVATE", MAIN_PRIVATE);
  const linked = yield* put(main, "GITHUB_TOKEN", MAIN_LINKED);
  const acme = yield* vaults
    .create({ name: "Acme secrets", owner: orgOwner(acmeId) })
    .pipe(as(ownerId));
  yield* put(acme.id, "GITHUB_TOKEN", MAIN_LINKED);
  yield* put(acme.id, "GITHUB_TOKEN_COPY", MAIN_LINKED);
  yield* put(acme.id, "ACME_API_KEY", ACME_OWN);
  const globex = yield* vaults
    .create({ name: "Globex secrets", owner: orgOwner(globexId) })
    .pipe(as(ownerId));
  yield* put(globex.id, "GLOBEX_DB_URL", GLOBEX_OWN);
  const shared = yield* vaults
    .create({ name: "Shared", owner: userOwner(ownerId) })
    .pipe(as(ownerId));
  yield* put(shared.id, "SHARED_KEY", SHARED);
  // Grants ticket 07: lent to Acme, and one lent to Grace's Personal space.
  const lend = (vaultId: VaultGroupId, spaceId: SpaceId) =>
    lendVaultGroup(server.sql, { vaultId, spaceId, lender: { kind: "user", id: ownerId } });
  const sharedGrant = yield* lend(shared.id, acmeId);
  const graces = yield* vaults
    .create({ name: "Grace's", owner: userOwner(ownerId) })
    .pipe(as(ownerId));
  yield* put(graces.id, "GRACE_KEY", GRACES);
  const gracesGrant = yield* lend(graces.id, SpaceId.make("personal:grace"));
  yield* vaults
    .setSpaceDefaults({ spaceId: acmeId, vaultIds: [acme.id, shared.id] })
    .pipe(as(ownerId));
  yield* vaults.setSpaceDefaults({ spaceId: globexId, vaultIds: [globex.id] }).pipe(as(ownerId));
  // Revealable, as every Secret was before migration 119 made new ones sealed: still never shown.
  yield* server.sql`UPDATE vault_entries SET revealable = 1 WHERE class = 'secret' AND kind = 'own'`;

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
  const thread = Effect.fn(function* (
    id: string,
    ownerUserId: UserId,
    spaceId: SpaceId,
    projectId: ProjectId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, space_id, owner_user_id
      ) VALUES (
        ${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, '{}',
        ${spaceId}, ${ownerUserId}
      )
    `;
    return ThreadId.make(id);
  });
  const acmeWeb = yield* project(people[1]!.cookie, "acme-web", acmeId);
  const globexApi = yield* project(people[4]!.cookie, "globex-api", globexId);
  const threads = [
    yield* thread("thread:acme-grace", UserId.make("grace"), acmeId, acmeWeb),
    yield* thread("thread:globex-gina", UserId.make("gina"), globexId, globexApi),
  ];
  return {
    server,
    authenticator,
    ownerId,
    acmeId,
    globexId,
    people,
    vaults,
    effective,
    delivery,
    as,
    vaultIds: [main, acme.id, globex.id, shared.id, graces.id],
    lend,
    lentGrants: [sharedGrant, gracesGrant],
    main,
    acmeVault: acme.id,
    mainEntry: linked.entry.id,
    projects: [acmeWeb, globexApi],
    threads,
  };
});

/** An answer or a refusal, as text: what the caller would read. */
const shown = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((answer) => JSON.stringify(answer)),
    Effect.catch((error) =>
      Effect.succeed(
        `${JSON.stringify(error)} ${String((error as { readonly message?: unknown })?.message)}`,
      ),
    ),
  );

it.effect(
  "no Vault door answers a Secret's value, refusals and the Owner's strong factor included; nor a name its caller may not see",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const swept = new Set<string>();
      // Grants ticket 15: Grace's Acme Thread starts a process, counted for the Owner's loan.
      yield* t.delivery
        .planTurn({ threadId: t.threads[0]!, target: HUB })
        .pipe(Effect.flatMap(t.delivery.resolve));
      const grants = Context.get(t.server.services, Grants.Grants);
      const answers: Array<{ readonly who: string; readonly door: string; readonly text: string }> =
        [];
      for (const who of t.people) {
        const call = Effect.fn(function* <A, E>(door: string, effect: Effect.Effect<A, E, never>) {
          swept.add(door);
          answers.push({ who: who.name, door, text: yield* shown(effect.pipe(t.as(who.id))) });
        });
        const v = t.vaults;
        // Reads.
        yield* call("ws:vaults.groups.list", v.list);
        for (const vaultId of t.vaultIds) {
          yield* call("ws:vaults.entries.list", v.listEntries({ vaultId }));
        }
        for (const spaceId of [t.acmeId, t.globexId]) {
          yield* call("ws:vaults.choices", v.choices({ spaceId }));
        }
        for (const [index, projectId] of t.projects.entries()) {
          const spaceId = index === 0 ? t.acmeId : t.globexId;
          yield* call("ws:vaults.choices", v.choices({ spaceId, projectId }));
        }
        for (const threadId of t.threads) {
          // As the WS door calls it: a Variable's value through Vaults, never a Secret's.
          yield* call(
            "ws:vaults.threadEnvironment",
            t.effective.threadEnvironment({ threadId }, { variableValue: t.vaults.variableValue }),
          );
        }
        // Writes, each carrying a value or reaching one: allowed or refused, neither answers it.
        const mine = `${who.name.toUpperCase()}_WROTE`;
        yield* call(
          "ws:vaults.entries.put",
          v.putEntry({ vaultId: t.acmeVault, name: mine, value: Redacted.make(WRITTEN) }),
        );
        yield* call(
          "ws:vaults.entries.put",
          v.putEntry({ vaultId: t.main, name: mine, value: Redacted.make(WRITTEN) }),
        );
        const listed = yield* v.listEntries({ vaultId: t.acmeVault }).pipe(
          t.as(who.id),
          Effect.map((page) => page.entries),
          Effect.orElseSucceed(() => []),
        );
        const own = listed.find((entry) => entry.name === mine);
        if (own !== undefined) {
          yield* call(
            "ws:vaults.entries.delete",
            v.deleteEntry({ vaultId: t.acmeVault, entryId: own.id }),
          );
        }
        // The Owner's own `default`'s entry: refused to anyone else, never with its value.
        yield* call(
          "ws:vaults.entries.delete",
          v.deleteEntry({ vaultId: t.main, entryId: t.mainEntry }),
        );
        yield* call("ws:vaults.unlinkedNotice.dismiss", v.dismissUnlinked);
        // A lent group's use: its lender and the borrowing Space's Admins only.
        for (const grantId of t.lentGrants) {
          yield* call("ws:grants.vaultUsage", grants.vaultUsage({ grantId }));
        }
        const made = yield* v
          .create({ name: `${who.name} scratch`, owner: orgOwner(t.acmeId) })
          .pipe(t.as(who.id), Effect.option);
        yield* call(
          "ws:vaults.groups.create",
          v.create({ name: `${who.name} scratch 2`, owner: orgOwner(t.globexId) }),
        );
        const scratch = made._tag === "Some" ? made.value.id : t.acmeVault;
        yield* call("ws:vaults.groups.update", v.update({ vaultId: scratch, description: "x" }));
        yield* call(
          "ws:vaults.spaceDefaults.set",
          v.setSpaceDefaults({ spaceId: t.acmeId, vaultIds: [t.acmeVault, t.vaultIds[3]!] }),
        );
        yield* call(
          "ws:vaults.projectChoices.set",
          v.setProjectChoice({
            projectId: t.projects[0]!,
            vaultId: t.acmeVault,
            choice: "inherit",
          }),
        );
        if (made._tag === "Some")
          yield* call("ws:vaults.groups.delete", v.remove({ vaultId: scratch }));
        else yield* call("ws:vaults.groups.delete", v.remove({ vaultId: t.acmeVault }));

        // HTTP: a reveal (no such door), the key's status, the audit log.
        const http = Effect.fn(function* (door: string, path: string, body?: unknown) {
          swept.add(door);
          const answer = yield* t.server.request(path, {
            cookie: who.cookie,
            ...(body === undefined ? {} : { body }),
          });
          answers.push({ who: who.name, door, text: JSON.stringify(answer.body) });
          return answer;
        });
        for (const vaultId of t.vaultIds) {
          const page = yield* v.listEntries({ vaultId }).pipe(t.as(t.ownerId));
          for (const entry of page.entries) {
            const refused = yield* http("http:vaults.reveal", "/api/vaults/reveal", {
              vaultId,
              entryId: entry.id,
              reauth: { method: "password", password: "nope", totpCode: "000000" },
            });
            assert.notEqual(refused.status, 200, `${who.name} got an answer from a reveal`);
          }
        }
        yield* http("http:vaults.masterKeyStatus", "/api/vaults/master-key");
        yield* http("http:audit.list", "/api/installation/audit");
      }

      // MCP: the agent's names, for its own Thread (no session: the Thread's owner decides).
      for (const threadId of t.threads) {
        swept.add("mcp:list_secret_names");
        answers.push({
          who: `agent of ${threadId}`,
          door: "mcp:list_secret_names",
          text: yield* shown(t.delivery.turnNames(threadId)),
        });
      }

      // The sweep reads what each may see (so it would find a value there).
      const textOf = (who: string, door: string) =>
        answers
          .filter((answer) => answer.who === who && answer.door === door)
          .map((answer) => answer.text)
          .join("\n");
      assert.include(textOf("grace", "ws:vaults.entries.list"), '"GRACE_KEY"');
      assert.include(textOf("grace", "ws:vaults.threadEnvironment"), '"GITHUB_TOKEN"');
      assert.include(textOf("linus", "ws:vaults.entries.list"), '"ACME_API_KEY"');
      assert.include(textOf("otto", "ws:vaults.entries.list"), '"GLOBEX_DB_URL"');
      assert.include(textOf("owner", "ws:vaults.entries.list"), '"OWNER_PRIVATE"');
      assert.include(
        textOf("agent of thread:globex-gina", "mcp:list_secret_names"),
        "GLOBEX_DB_URL",
      );
      assert.include(textOf("ada", "ws:vaults.entries.put"), '"ADA_WROTE"');
      assert.include(textOf("owner", "ws:grants.vaultUsage"), '"SHARED_KEY"');
      assert.include(textOf("ada", "ws:grants.vaultUsage"), '"SHARED_KEY"');
      for (const who of ["grace", "linus", "gus", "gina", "otto"]) {
        assert.notInclude(textOf(who, "ws:grants.vaultUsage"), '"SHARED_KEY"', who);
      }

      // No answer holds a value.
      const leaks = answers.filter(({ text }) => VALUES.some((value) => text.includes(value)));
      assert.deepEqual(
        leaks.map(({ who, door }) => `${who} ${door}`),
        [],
      );
      // No answer names a secret its caller may not see.
      const sees = (who: string): ReadonlyArray<string> => {
        const person = t.people.find((p) => p.name === who);
        if (who.startsWith("agent of thread:acme")) return ACME_NAMES;
        if (who.startsWith("agent of thread:globex")) return GLOBEX_NAMES;
        if (person?.role === "owner")
          return ["OWNER_PRIVATE", ...ACME_NAMES, ...GLOBEX_NAMES, "GRACE_KEY"];
        const org = person?.spaceId === t.acmeId ? ACME_NAMES : GLOBEX_NAMES;
        return who === "grace" ? [...org, "GRACE_KEY"] : org;
      };
      const all = ["OWNER_PRIVATE", ...ACME_NAMES, ...GLOBEX_NAMES, "GRACE_KEY"];
      const named = answers.flatMap(({ who, door, text }) =>
        all
          .filter((name) => !sees(who).includes(name))
          .filter((name) => new RegExp(`"${name}"`, "u").test(text))
          .map((name) => `${who} ${door} ${name}`),
      );
      assert.deepEqual(named, []);

      // Not even the Owner with a strong factor reads a revealable Secret: there is no such door.
      const page = yield* t.vaults.listEntries({ vaultId: t.acmeVault }).pipe(t.as(t.ownerId));
      const acmeOwn = page.entries.find((entry) => entry.name === "ACME_API_KEY");
      const revealed = yield* t.server.request("/api/vaults/reveal", {
        cookie: t.people[0]!.cookie,
        body: {
          vaultId: t.acmeVault,
          entryId: acmeOwn?.id,
          reauth: yield* passkeyReauth(t.server, t.authenticator),
        },
      });
      assert.notEqual(revealed.status, 200, "the Owner's reveal was answered");
      assert.isFalse(
        VALUES.some((value) => JSON.stringify(revealed.body).includes(value)),
        "the Owner's reveal answered a value",
      );

      // Every door about Vaults or secrets is called here, or in the file named for it.
      const doors = [
        ...[...WsRpcGroup.requests.keys()].map((tag) => `ws:${tag}`),
        ...Object.keys(HTTP_ENDPOINT_RULES).map((name) => `http:${name}`),
        ...Object.keys(RAW_ROUTE_RULES).map((name) => `raw:${name}`),
        ...Object.keys(MCP_TOOL_RULES).map((name) => `mcp:${name}`),
      ].filter((door) => RE_VAULTS.test(door));
      assert.deepEqual(
        doors
          .filter((door) => !swept.has(door) && !Object.hasOwn(SWEPT_ELSEWHERE, door))
          .toSorted(),
        [],
      );
    }).pipe(Effect.scoped),
);

const ANA_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7ana0101",
  "q2Ow3m1cZx5yJk7W8u9pQ2rSt4uVw6xYz8aBc0dEf1gHi2jKl3mNo4pQ0202",
  "-----END PRIVATE KEY-----",
].join("\n");
const ANA_ENV = "ana-variable-value-0303";

it.effect(
  "owned-resources 11: Ana's own Vault reaches nobody else, and a session limited to one Space sees nothing of another's, the Owner's included",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const ana = UserId.make("ana");
      yield* addMember(t.server, { id: "ana", displayName: "Ana" });
      yield* Context.get(t.server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
        ana,
      ]);
      const [own] = yield* t.server.sql<{ readonly groupId: VaultGroupId }>`
        SELECT group_id AS "groupId" FROM vault_groups
        WHERE owner_kind = 'user' AND owner_id = ${ana} AND is_default = 1
      `;
      assert.isDefined(own);
      yield* t.vaults
        .putEntry({ vaultId: own.groupId, name: "ANA_PEM", value: Redacted.make(ANA_PEM) })
        .pipe(t.as(ana));
      yield* t.vaults
        .putEntry({
          vaultId: own.groupId,
          name: "ANA_ENV",
          value: Redacted.make(ANA_ENV),
          class: "variable",
        })
        .pipe(t.as(ana));
      const limited = (userId: UserId, spaceLimit: SpaceId) =>
        CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit });
      const sessions = [
        { who: "ana", act: t.as(ana), names: ["ANA_PEM", "ANA_ENV"], variable: true },
        // The Owner reads names and Variables of someone else's Vault (spec: until platform-privacy).
        { who: "owner", act: t.as(t.ownerId), names: ["ANA_PEM", "ANA_ENV"], variable: true },
        {
          who: "owner limited to Acme",
          act: limited(t.ownerId, t.acmeId),
          names: [],
          variable: false,
        },
        {
          who: "ada limited to Acme",
          act: limited(UserId.make("ada"), t.acmeId),
          names: [],
          variable: false,
        },
        ...t.people
          .filter((person) => person.role !== "owner")
          .map((person) => ({
            who: person.name,
            act: t.as(person.id),
            names: [],
            variable: false,
          })),
      ];
      const answers: Array<{ readonly who: string; readonly text: string }> = [];
      for (const session of sessions) {
        const read = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E, never>) {
          const text = yield* shown(effect.pipe(session.act));
          answers.push({ who: session.who, text });
          return text;
        });
        const listed = yield* read(t.vaults.list);
        const entries = yield* read(t.vaults.listEntries({ vaultId: own.groupId }));
        for (const vaultId of t.vaultIds) yield* read(t.vaults.listEntries({ vaultId }));
        for (const spaceId of [t.acmeId, t.globexId, SpaceId.make(`personal:${ana}`)]) {
          yield* read(t.vaults.choices({ spaceId }));
        }
        for (const threadId of t.threads) {
          yield* read(
            t.effective.threadEnvironment({ threadId }, { variableValue: t.vaults.variableValue }),
          );
        }
        for (const name of session.names) {
          assert.include(entries, `"${name}"`, `${session.who} sees ${name}`);
        }
        assert.equal(
          entries.includes(ANA_ENV),
          session.variable,
          `${session.who} and her Variable`,
        );
        if (session.who.endsWith("limited to Acme")) {
          // Nothing of the Owner's own, of Globex or of Ana in a session bound to Acme.
          for (const name of ["OWNER_PRIVATE", "GLOBEX_DB_URL", "ANA_PEM", "ANA_ENV"]) {
            assert.notInclude(
              answers
                .filter((answer) => answer.who === session.who)
                .map((answer) => answer.text)
                .join("\n"),
              `"${name}"`,
              `${session.who} saw ${name}`,
            );
          }
          assert.notInclude(listed, "Globex secrets", `${session.who} listed Globex's group`);
        }
      }
      // Ana's Secret, whole or a line of it, is in no answer; her Variable only in hers and the
      // Owner's (unlimited) ones.
      const pemLines = ANA_PEM.split("\n").filter((line) => !line.startsWith("-----"));
      assert.deepEqual(
        answers
          .filter(
            ({ text }) => text.includes(ANA_PEM) || pemLines.some((line) => text.includes(line)),
          )
          .map(({ who }) => who),
        [],
      );
      assert.deepEqual(
        [
          ...new Set(answers.filter(({ text }) => text.includes(ANA_ENV)).map(({ who }) => who)),
        ].toSorted(),
        ["ana", "owner"],
      );
      // Her names reach nobody but her and the Owner.
      assert.deepEqual(
        [
          ...new Set(
            answers
              .filter(({ text }) => text.includes('"ANA_PEM"') || text.includes('"ANA_ENV"'))
              .map(({ who }) => who),
          ),
        ].toSorted(),
        ["ana", "owner"],
      );
      // Nobody else writes into her Vault.
      for (const person of t.people) {
        const wrote = yield* t.vaults
          .putEntry({ vaultId: own.groupId, name: "INTRUDER", value: Redacted.make(WRITTEN) })
          .pipe(t.as(person.id), Effect.option);
        assert.isTrue(wrote._tag === "None", `${person.name} wrote into Ana's Vault`);
      }
    }).pipe(Effect.scoped),
);

const LENT_SECRET = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW0707",
  "QyNTUxOQAAACBhbmFzLWxlbnQta2V5LWZvci1hY21lLW9ubHktMDcwNwAAAJgAAAAAAAA0707",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const LENT_VARIABLE = "ana-lent-variable-value-0707";

it.effect(
  "Grants ticket 07: Ana's group lent to Acme gives Acme names and its Variable, never the Secret; nothing once it ends",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const ana = UserId.make("ana");
      yield* addMember(t.server, { id: "ana", displayName: "Ana" });
      yield* Context.get(t.server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
        ana,
      ]);
      const group = yield* t.vaults
        .create({ name: "Ana lends", owner: userOwner(ana) })
        .pipe(t.as(ana));
      yield* t.vaults
        .putEntry({ vaultId: group.id, name: "ANA_LENT_KEY", value: Redacted.make(LENT_SECRET) })
        .pipe(t.as(ana));
      yield* t.vaults
        .putEntry({
          vaultId: group.id,
          name: "ANA_LENT_ENV",
          value: Redacted.make(LENT_VARIABLE),
          class: "variable",
        })
        .pipe(t.as(ana));
      const grantId = yield* lendVaultGroup(t.server.sql, {
        vaultId: group.id,
        spaceId: t.acmeId,
        lender: { kind: "user", id: ana },
      });
      yield* t.vaults
        .setSpaceDefaults({ spaceId: t.acmeId, vaultIds: [t.acmeVault, group.id] })
        .pipe(t.as(t.ownerId));
      const grants = Context.get(t.server.services, Grants.Grants);
      const limited = (userId: UserId, spaceLimit: SpaceId) =>
        CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit });
      const byName = (name: string) => t.people.find((person) => person.name === name)!;
      // Who sees its names, and who reads its Variable, while it is lent.
      const sessions = [
        { who: "ana", act: t.as(ana), names: true, variable: true },
        { who: "owner", act: t.as(t.ownerId), names: true, variable: true },
        { who: "ada", act: t.as(byName("ada").id), names: true, variable: true },
        { who: "grace", act: t.as(byName("grace").id), names: true, variable: true },
        { who: "linus", act: t.as(byName("linus").id), names: true, variable: false },
        {
          who: "ada limited to Acme",
          act: limited(byName("ada").id, t.acmeId),
          names: true,
          variable: true,
        },
        ...["gus", "gina", "otto"].map((who) => ({
          who,
          act: t.as(byName(who).id),
          names: false,
          variable: false,
        })),
        {
          who: "owner limited to Globex",
          act: limited(t.ownerId, t.globexId),
          names: false,
          variable: false,
        },
      ];
      const answers: Array<{
        readonly who: string;
        readonly phase: string;
        readonly text: string;
      }> = [];
      const sweep = Effect.fn(function* (phase: string) {
        for (const session of sessions) {
          const read = Effect.fn(function* <A, E>(effect: Effect.Effect<A, E, never>) {
            const text = yield* shown(effect.pipe(session.act));
            answers.push({ who: session.who, phase, text });
            return text;
          });
          yield* read(t.vaults.list);
          yield* read(t.vaults.listEntries({ vaultId: group.id }));
          for (const spaceId of [t.acmeId, t.globexId]) yield* read(t.vaults.choices({ spaceId }));
          for (const threadId of t.threads) {
            yield* read(
              t.effective.threadEnvironment(
                { threadId },
                { variableValue: t.vaults.variableValue },
              ),
            );
          }
          yield* read(grants.listGiven);
          yield* read(grants.listReceived({}));
          // Nobody but Ana writes into it, nor renames, archives or deletes it.
          if (session.who !== "ana" && session.who !== "owner") {
            const refused = Effect.fn(function* <A, E>(write: Effect.Effect<A, E, never>) {
              const wrote = yield* write.pipe(session.act, Effect.option);
              assert.isTrue(wrote._tag === "None", `${session.who} wrote into Ana's lent group`);
            });
            yield* refused(
              t.vaults.putEntry({
                vaultId: group.id,
                name: "INTRUDER",
                value: Redacted.make(WRITTEN),
              }),
            );
            yield* refused(t.vaults.update({ vaultId: group.id, name: "Taken" }));
            yield* refused(t.vaults.remove({ vaultId: group.id }));
          }
        }
        // The agent of Grace's Acme Thread: its names, the Variable's value, never the Secret.
        answers.push({
          who: "agent of thread:acme-grace",
          phase,
          text: yield* shown(t.delivery.turnNames(t.threads[0]!)),
        });
      });
      yield* sweep("lent");
      const textOf = (who: string, phase: string) =>
        answers
          .filter((answer) => answer.who === who && answer.phase === phase)
          .map((answer) => answer.text)
          .join("\n");
      for (const session of sessions) {
        const text = textOf(session.who, "lent");
        assert.equal(text.includes('"ANA_LENT_KEY"'), session.names, `${session.who} names`);
        assert.equal(text.includes(LENT_VARIABLE), session.variable, `${session.who} Variable`);
      }
      const agent = textOf("agent of thread:acme-grace", "lent");
      assert.include(agent, "ANA_LENT_KEY");
      assert.include(agent, LENT_VARIABLE);

      // Once the loan ends, Acme sees nothing of it, and its Thread receives nothing from it.
      yield* t.server.sql`
        UPDATE grants SET state = 'ended', end_reason = 'revoked' WHERE grant_id = ${grantId}
      `;
      yield* sweep("ended");
      for (const session of sessions.filter((s) => !["ana", "owner"].includes(s.who))) {
        const text = textOf(session.who, "ended");
        assert.notInclude(text, '"ANA_LENT_KEY"', `${session.who} after the end`);
        assert.notInclude(text, LENT_VARIABLE, `${session.who} after the end`);
      }
      assert.notInclude(textOf("agent of thread:acme-grace", "ended"), "ANA_LENT_KEY");

      // The Secret, whole or a line of it, is in no answer, before or after.
      const lines = LENT_SECRET.split("\n").filter((line) => !line.startsWith("-----"));
      assert.deepEqual(
        answers
          .filter(
            ({ text }) => text.includes(LENT_SECRET) || lines.some((line) => text.includes(line)),
          )
          .map(({ who, phase }) => `${who} ${phase}`),
        [],
      );
    }).pipe(Effect.scoped),
);
