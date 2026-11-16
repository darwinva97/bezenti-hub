/**
 * Spec 5 ticket 09: the Owner and four roles of two Organizations call every Vault door (WS
 * handlers call these services one to one; HTTP over HTTP). No answer holds a value but the
 * Owner's reveal, nor a name its caller may not see; a new Vault or secret door not called fails.
 */
// @effect-diagnostics globalJsonInEffect:off -- answers are searched as text.
import {
  MAIN_VAULT_ID,
  ProjectId,
  SpaceId,
  ThreadId,
  UserId,
  type VaultId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { HTTP_ENDPOINT_RULES, MCP_TOOL_RULES } from "../auth/DoorRules.ts";
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
};

const RE_VAULTS = /vault|secret/iu;

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
  // Revealable, as every secret was before sealing: the Owner's reveal is one of the doors.
  const put = (vaultId: VaultId, name: string, value: string) =>
    vaults
      .putEntry({ vaultId, name, value: Redacted.make(value), allowReveal: true })
      .pipe(as(ownerId));

  // Full Vaults: the Main vault (one kept, one linked and copied into Acme's), Acme's and Globex's
  // own, one of the Owner's allowed to Acme and one allowed to Grace alone.
  yield* put(MAIN_VAULT_ID, "OWNER_PRIVATE", MAIN_PRIVATE);
  const linked = yield* put(MAIN_VAULT_ID, "GITHUB_TOKEN", MAIN_LINKED);
  const acme = yield* vaults.create({ name: "Acme secrets", spaceId: acmeId }).pipe(as(ownerId));
  yield* vaults.linkEntry({ vaultId: acme.id, sourceEntryId: linked.entry.id }).pipe(as(ownerId));
  yield* vaults
    .copyEntry({ vaultId: acme.id, sourceEntryId: linked.entry.id, name: "GITHUB_TOKEN_COPY" })
    .pipe(as(ownerId));
  yield* put(acme.id, "ACME_API_KEY", ACME_OWN);
  const globex = yield* vaults
    .create({ name: "Globex secrets", spaceId: globexId })
    .pipe(as(ownerId));
  yield* put(globex.id, "GLOBEX_DB_URL", GLOBEX_OWN);
  const shared = yield* vaults.create({ name: "Shared", spaceId: null }).pipe(as(ownerId));
  yield* put(shared.id, "SHARED_KEY", SHARED);
  yield* vaults
    .allow({ vaultId: shared.id, subject: { kind: "space", spaceId: acmeId }, allowed: true })
    .pipe(as(ownerId));
  const graces = yield* vaults.create({ name: "Grace's", spaceId: null }).pipe(as(ownerId));
  yield* put(graces.id, "GRACE_KEY", GRACES);
  yield* vaults
    .allow({
      vaultId: graces.id,
      subject: { kind: "user", userId: UserId.make("grace") },
      allowed: true,
    })
    .pipe(as(ownerId));
  yield* vaults
    .setSpaceDefaults({ spaceId: acmeId, vaultIds: [acme.id, shared.id] })
    .pipe(as(ownerId));
  yield* vaults.setSpaceDefaults({ spaceId: globexId, vaultIds: [globex.id] }).pipe(as(ownerId));

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
    vaultIds: [MAIN_VAULT_ID, acme.id, globex.id, shared.id, graces.id],
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
  "no Vault door answers a value, refusals included, but the Owner's reveal; nor a name its caller may not see",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const swept = new Set<string>();
      const answers: Array<{ readonly who: string; readonly door: string; readonly text: string }> =
        [];
      for (const who of t.people) {
        const call = Effect.fn(function* <A, E>(door: string, effect: Effect.Effect<A, E, never>) {
          swept.add(door);
          answers.push({ who: who.name, door, text: yield* shown(effect.pipe(t.as(who.id))) });
        });
        const v = t.vaults;
        // Reads.
        yield* call("ws:vaults.list", v.list);
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
          yield* call("ws:vaults.threadEnvironment", t.effective.threadEnvironment({ threadId }));
        }
        // Writes, each carrying a value or reaching one: allowed or refused, neither answers it.
        const mine = `${who.name.toUpperCase()}_WROTE`;
        yield* call(
          "ws:vaults.entries.put",
          v.putEntry({ vaultId: t.acmeVault, name: mine, value: Redacted.make(WRITTEN) }),
        );
        yield* call(
          "ws:vaults.entries.put",
          v.putEntry({ vaultId: MAIN_VAULT_ID, name: mine, value: Redacted.make(WRITTEN) }),
        );
        yield* call(
          "ws:vaults.entries.link",
          v.linkEntry({ vaultId: t.acmeVault, sourceEntryId: t.mainEntry, name: `${mine}_LINK` }),
        );
        yield* call(
          "ws:vaults.entries.copy",
          v.copyEntry({ vaultId: t.acmeVault, sourceEntryId: t.mainEntry, name: `${mine}_COPY` }),
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
        // An original with links: the refusal lists the links, never the value.
        yield* call(
          "ws:vaults.entries.delete",
          v.deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: t.mainEntry }),
        );
        const made = yield* v
          .create({ name: `${who.name} scratch`, spaceId: t.acmeId })
          .pipe(t.as(who.id), Effect.option);
        yield* call(
          "ws:vaults.create",
          v.create({ name: `${who.name} scratch 2`, spaceId: t.globexId }),
        );
        const scratch = made._tag === "Some" ? made.value.id : t.acmeVault;
        yield* call("ws:vaults.update", v.update({ vaultId: scratch, description: "x" }));
        yield* call(
          "ws:vaults.allow",
          v.allow({
            vaultId: t.vaultIds[3]!,
            subject: { kind: "space", spaceId: t.acmeId },
            allowed: true,
          }),
        );
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
        if (made._tag === "Some") yield* call("ws:vaults.delete", v.remove({ vaultId: scratch }));
        else yield* call("ws:vaults.delete", v.remove({ vaultId: t.acmeVault }));

        // HTTP: the reveal, refused without a strong factor; the key's status; the audit log.
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
            assert.notEqual(refused.status, 200, `${who.name} revealed without a strong factor`);
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
      assert.include(textOf("grace", "ws:vaults.threadEnvironment"), '"GRACE_KEY"');
      assert.include(textOf("grace", "ws:vaults.threadEnvironment"), '"GITHUB_TOKEN"');
      assert.include(textOf("linus", "ws:vaults.entries.list"), '"ACME_API_KEY"');
      assert.include(textOf("otto", "ws:vaults.entries.list"), '"GLOBEX_DB_URL"');
      assert.include(textOf("owner", "ws:vaults.entries.list"), '"OWNER_PRIVATE"');
      assert.include(
        textOf("agent of thread:globex-gina", "mcp:list_secret_names"),
        "GLOBEX_DB_URL",
      );
      assert.include(textOf("ada", "ws:vaults.entries.put"), '"ADA_WROTE"');

      // No answer holds a value.
      const leaks = answers.filter(({ text }) => VALUES.some((value) => text.includes(value)));
      assert.deepEqual(
        leaks.map(({ who, door }) => `${who} ${door}`),
        [],
      );
      // No answer names a secret its caller may not see.
      const sees = (who: string): ReadonlyArray<string> => {
        const person = t.people.find((p) => p.name === who);
        if (who.startsWith("agent of thread:acme")) return [...ACME_NAMES, "GRACE_KEY"];
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

      // The Owner's reveal, with a strong factor: the one door that answers a value.
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
      assert.equal(revealed.status, 200);
      assert.include(JSON.stringify(revealed.body), ACME_OWN);

      // Every door about Vaults or secrets is called here, or in the file named for it.
      const doors = [
        ...[...WsRpcGroup.requests.keys()].map((tag) => `ws:${tag}`),
        ...Object.keys(HTTP_ENDPOINT_RULES).map((name) => `http:${name}`),
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
