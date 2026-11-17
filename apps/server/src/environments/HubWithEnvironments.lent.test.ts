/**
 * «Hub con Environments», Grants tickets 08 to 10: the Owner's personal machine lent to Acme and
 * Globex. Its host keeps serving the Owner natively and runs one Sandbox per Grant (process
 * runtime here), each the borrowing Space's Environment with a credential for that Space alone.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import { addMember, joinOrganization, passkeyReauth } from "../auth/UserAuth.testkit.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { boundSpaceOf } from "../sandboxes/sandboxSpace.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { listEnvironments } from "./environments.testkit.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claudeAgent");

/** The provider, with no recorded turns: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: INSTANCE,
    driver: CLAUDE,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

const LIMITS = {
  kind: "environment",
  cpus: 1,
  memoryBytes: 1024 ** 3,
  pids: 256,
  diskBytes: 2 * 1024 ** 3,
} as const;

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** What the Hub's git route answers `credential` for the Project's repository. */
const gitStatus = (hub: Hub, projectId: ProjectId, credential: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.get(
          `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/info/refs?service=git-upload-pack`,
        ).pipe(HttpClientRequest.bearerToken(credential)),
      ),
    ),
    Effect.map((response) => response.status),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  );

/** Why the Hub refuses `credential` at connect, or what it connects as. */
const checkOf = (hub: Hub, credential: string) =>
  hub
    .service(EnvironmentRegistry.EnvironmentRegistry)
    .checkCredential(credential)
    .pipe(
      Effect.orDie,
      Effect.map((check) => (check._tag === "refused" ? check.reason : check.environmentId)),
    );

/** What `/self/report` answers `credential`: its status. */
const selfReportStatus = (hub: Hub, credential: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      HttpClientRequest.post(`${hub.server.url}/api/environments/self/report`).pipe(
        HttpClientRequest.bearerToken(credential),
        HttpClientRequest.bodyJson({
          sandboxHost: {
            ready: true,
            reason: null,
            limitSupport: { cpus: false, memory: false, pids: false, note: null },
            reachablePorts: [],
            hostCpus: 1,
            hostMemoryBytes: 1,
            hostFreeBytes: null,
            hostTotalBytes: null,
          },
          sandboxes: [],
          credentialsFor: [],
        }),
        Effect.flatMap((request) => client.execute(request)),
      ),
    ),
    Effect.map((response) => response.status),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  );

/**
 * Acme (Grace works there) and Globex (Hedy works there), each with a Project; the Owner runs
 * both and lends them their personal machine, which starts active (with a passkey).
 */
const lentToAcmeAndGlobex = Effect.fn(function* () {
  const hub = yield* makeHub();
  const owner = yield* ownerIdOf(hub);
  const spaces = hub.service(SpaceDirectory.SpaceDirectory);
  const organization = (name: string) =>
    spaces.createOrganization(owner, name).pipe(
      Effect.orDie,
      Effect.map((made) => made.id),
    );
  const acme = yield* organization("Acme");
  const globex = yield* organization("Globex");
  for (const spaceId of [acme, globex]) {
    yield* hub.server.sql`
      INSERT OR IGNORE INTO space_memberships (space_id, user_id, role, created_at)
      VALUES (${spaceId}, ${owner}, 'admin', '2026-01-01T00:00:00.000Z')
    `;
  }
  const grace = UserId.make("member-1");
  const hedy = UserId.make("member-2");
  const graceCookie = yield* addMember(hub.server, { id: grace, displayName: "Grace" });
  const hedyCookie = yield* addMember(hub.server, { id: hedy, displayName: "Hedy" });
  yield* joinOrganization(hub.server, acme, grace, "member");
  yield* joinOrganization(hub.server, globex, hedy, "member");
  yield* spaces.changed;
  const acmeProject = ProjectId.make("project:acme");
  const globexProject = ProjectId.make("project:globex");
  yield* seedProject(hub.server, {
    projectId: acmeProject,
    title: "Acme",
    defaultModelSelection: null,
    spaceId: acme,
  });
  yield* seedProject(hub.server, {
    projectId: globexProject,
    title: "Globex",
    defaultModelSelection: null,
    spaceId: globex,
  });
  const host = yield* hub.lendingHost({ name: "Owner VPS", adapters: idleAdapters });
  const lend = Effect.fn(function* (spaceId: SpaceId) {
    const given = yield* hub.server.request("/api/grants/give", {
      cookie: hub.owner,
      body: {
        resource: { kind: "environment", environmentId: host.native.environmentId },
        spaceId,
        limits: LIMITS,
        reauth: yield* passkeyReauth(hub.server, hub.authenticator),
      },
    });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.equal(given.body.state, "active");
    return given.body.id as string;
  });
  const acmeGrant = yield* lend(acme);
  const globexGrant = yield* lend(globex);
  // One round: the host learns of both and starts their Sandboxes, each with its own credential.
  yield* host.round;
  yield* host.nextLaunch;
  yield* host.nextLaunch;
  const launchFor = (spaceId: SpaceId) => {
    const launch = host.launches.find((entry) => entry.joined.spaceId === spaceId);
    assert.isDefined(launch);
    return launch;
  };
  return {
    hub,
    owner,
    acme,
    globex,
    grace,
    hedy,
    graceCookie,
    hedyCookie,
    acmeProject,
    globexProject,
    host,
    acmeGrant,
    globexGrant,
    acmeLaunch: launchFor(acme),
    globexLaunch: launchFor(globex),
  };
});

const listedIds = (hub: Hub, cookie: string) =>
  listEnvironments(hub.server, cookie).pipe(Effect.map((listed) => listed.map(({ id }) => id)));

describe("Hub con Environments: a machine lent to Spaces", () => {
  it.live(
    "runs one Sandbox per borrowing Space, each reaching its own Space alone, while its owner keeps it",
    () =>
      Effect.gen(function* () {
        const t = yield* lentToAcmeAndGlobex();
        const { hub, host, acmeLaunch, globexLaunch } = t;
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const acmeSandbox = acmeLaunch.joined.environmentId;
        const globexSandbox = globexLaunch.joined.environmentId;
        assert.equal(acmeSandbox, `lent:${t.acmeGrant}`);
        assert.equal(globexSandbox, `lent:${t.globexGrant}`);
        // Two homes, one per Grant, under the host's own root; sandboxed servers, each for its Space.
        assert.notEqual(acmeLaunch.homePath, globexLaunch.homePath);
        assert.isTrue(acmeLaunch.joined.sandboxed);
        assert.isTrue(acmeLaunch.homePath.startsWith(host.rootDir));

        // The machine's own credential is the Owner's machine, never a Sandbox; each Sandbox's is
        // its own Sandbox, never the machine nor the other Sandbox.
        assert.equal(yield* checkOf(hub, host.native.credential), host.native.environmentId);
        assert.equal(yield* checkOf(hub, acmeLaunch.credential), acmeSandbox);
        assert.equal(yield* checkOf(hub, globexLaunch.credential), globexSandbox);
        assert.notInclude([host.native.credential, globexLaunch.credential], acmeLaunch.credential);
        // A Sandbox's credential does not ask as the machine.
        assert.equal(yield* selfReportStatus(hub, acmeLaunch.credential), 401);
        assert.equal(yield* selfReportStatus(hub, host.native.credential), 200);
        // Each reaches its own Space's repositories and no other's.
        assert.equal(yield* gitStatus(hub, t.acmeProject, acmeLaunch.credential), 200);
        assert.equal(yield* gitStatus(hub, t.globexProject, acmeLaunch.credential), 403);
        assert.equal(yield* gitStatus(hub, t.globexProject, globexLaunch.credential), 200);
        assert.equal(yield* gitStatus(hub, t.acmeProject, globexLaunch.credential), 403);

        // Each Space sees its own and not the other's; neither sees the Owner's machine.
        const graceSees = yield* listedIds(hub, t.graceCookie);
        assert.include(graceSees, acmeSandbox);
        assert.notInclude(graceSees, globexSandbox);
        assert.notInclude(graceSees, host.native.environmentId);
        const hedySees = yield* listedIds(hub, t.hedyCookie);
        assert.include(hedySees, globexSandbox);
        assert.notInclude(hedySees, acmeSandbox);
        // Listed as the Space's dedicated machine, with who lent it; online once connected.
        const listed = (yield* listEnvironments(hub.server, t.graceCookie)).find(
          (entry) => entry.id === acmeSandbox,
        );
        assert.equal(listed?.mode, "dedicated");
        assert.equal(listed?.spaceId, t.acme);
        assert.equal(listed?.status, "online");
        const lent = (
          listed as { readonly lent?: { grantId: string; lenderName: string | null } } | undefined
        )?.lent;
        assert.equal(lent?.grantId, t.acmeGrant);
        assert.isString(lent?.lenderName);

        // Only the Space's Threads go there, and only for whoever works in it.
        const choose = (userId: UserId, projectId: ProjectId, requested: EnvironmentId) =>
          registry
            .chooseForThread({ userId, requested, projectId, providerInstanceId: INSTANCE })
            .pipe(
              Effect.map(() => "placed"),
              Effect.catch((error) =>
                Effect.succeed(
                  error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
                ),
              ),
            );
        assert.equal(yield* choose(t.grace, t.acmeProject, acmeSandbox), "placed");
        assert.equal(yield* choose(t.hedy, t.globexProject, acmeSandbox), "not-usable");
        assert.equal(yield* choose(t.grace, t.acmeProject, globexSandbox), "not-usable");
        // The executor's own guard: a Sandbox serves its Space's Threads only.
        const bound = yield* boundSpaceOf(acmeSandbox).pipe(
          Effect.provideService(SqlClient.SqlClient, hub.server.sql),
          Effect.orDie,
        );
        assert.equal(bound, t.acme);
        // The Owner still uses their machine natively, in any of their Spaces.
        assert.equal(yield* choose(t.owner, t.acmeProject, host.native.environmentId), "placed");
        assert.equal(yield* choose(t.owner, t.globexProject, host.native.environmentId), "placed");
      }).pipe(Effect.scoped),
  );
});
