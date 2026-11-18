/**
 * Owned-resources 11: every door onto machines, called by the Owner, Ana (no Organization) and
 * the Admin, Member and Guest of Acme and Globex. Nobody lists another User's personal machine or
 * another Organization's dedicated one (the Owner sees all), and no write on a machine its caller
 * may not manage changes it. A new such door with no call here or in the file named for it fails.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SpaceId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { HTTP_ENDPOINT_RULES, MCP_TOOL_RULES, RAW_ROUTE_RULES } from "../auth/DoorRules.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import { createOrganization } from "./HubWithEnvironments.scenarios.testkit.ts";
import { makeHub } from "./HubWithEnvironments.testkit.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

/** Machine doors tested in their own files. */
const SWEPT_ELSEWHERE: Record<string, string> = {
  "http:environments.approveJoin": "EnvironmentJoin.test.ts: who approves, for whom",
  "http:environments.denyJoin": "EnvironmentJoin.test.ts",
  "http:environments.confirmJoin": "EnvironmentJoin.test.ts: the machine's own request code",
  "http:environments.joinRequest": "EnvironmentJoin.test.ts",
  "http:environments.joinStatus": "EnvironmentJoin.test.ts",
  "http:environments.startJoin": "EnvironmentJoin.test.ts",
  "http:environments.grantJoin": "HubWithEnvironments.sshInstall.test.ts: the run's own grant",
  "http:environments.self": "HubWithEnvironments.dedicated.test.ts: the machine's credential",
  "http:environments.selfReport": "HubWithEnvironments.lent.test.ts: a Sandbox's is refused",
  "http:environments.leave": "HubWithEnvironments.test.ts: the machine's own credential",
  "http:environments.sshInstallStart": "HubWithEnvironments.sshInstall.test.ts: per role",
  "http:environments.sshInstallStatus": "HubWithEnvironments.sshInstall.test.ts: its starter only",
  "http:environments.sshInstallConfirm": "HubWithEnvironments.sshInstall.test.ts",
  "http:environments.sshInstallCancel": "HubWithEnvironments.sshInstall.test.ts",
  "http:environments.overview": "HubWithEnvironments.ownerOverview.test.ts: the Owner only",
  "http:sandboxImage.build": "HubWithEnvironments.sandboxImage.test.ts: the Owner only",
  "http:sandboxImage.status": "HubWithEnvironments.sandboxImage.test.ts",
  "http:sandboxImage.update": "HubWithEnvironments.sandboxImage.test.ts",
  "http:grants.give": "Grants.test.ts: per role, a strong factor",
  "http:grants.accept": "Grants.test.ts",
  "ws:grants.listGiven": "Grants.test.ts: the lender's own",
  "ws:grants.listReceived": "Grants.test.ts: the Space's",
  "ws:grants.targets": "Grants.test.ts",
  "ws:grants.reject": "Grants.test.ts",
  "ws:grants.cancel": "Grants.test.ts",
  "ws:grants.end": "Grants.test.ts and HubWithEnvironments.lent.test.ts",
  "ws:grants.setLimits": "Grants.test.ts",
  // Grants tickets 02, 06, 07 and 15: the Owner's reviews, lending links (a machine's applied over
  // HTTP with a strong factor) and a lent Vault group's use, per role.
  "ws:grants.migrationReviews": "Grants.test.ts: the Owner only",
  "ws:grants.dismissMigrationReview": "Grants.test.ts: the Owner only",
  "ws:grants.createOffer": "GrantOffers.test.ts: the lender's side only, per kind",
  "ws:grants.readOffer": "GrantOffers.test.ts: a signed-in User, invalid when dead",
  "ws:grants.claimOffer": "GrantOffers.test.ts: who decides; a machine's refused here",
  "http:grants.claimOffer": "GrantOffers.test.ts: who decides, a strong factor, its Sandbox",
  "ws:grants.vaultUsage": "Grants.test.ts and VaultDoors.test.ts: lender and borrowing Admins",
  "raw:environments/JoinedHub.ts": "a machine's own health check: no Hub data",
  "raw:environments/connectRoute.ts": "EnvironmentConnection.test.ts: the machine's credential",
  "raw:environments/gitRoute.ts": "HubWithEnvironments.lent.test.ts: its own Space's alone",
  "mcp:t3_environment_read": "mcp/toolkits/environment/handlers.test.ts",
  "mcp:t3_environment_preferences_update": "mcp/toolkits/environment/handlers.test.ts",
};

const RE_MACHINE_DOORS =
  /^(http:environments\.|http:sandboxImage\.|http:grants\.|ws:grants\.|raw:environments\/|mcp:t3_environment_)/u;

describe("Hub con Environments: the machine doors (owned-resources 11)", () => {
  it.live(
    "nobody lists or changes another User's personal machine or another Organization's dedicated one",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const withPasskey = (displayName: string, spaceId: SpaceId, role: "admin" | "member") =>
          memberWithPasskey(hub.server, hub.owner, { displayName, spaceId, role });
        const acmeAdmin = yield* withPasskey("Ada", acme, "admin");
        const acmeMember = yield* withPasskey("Grace", acme, "member");
        const globexAdmin = yield* withPasskey("Gwen", globex, "admin");
        const globexMember = yield* withPasskey("Gus", globex, "member");
        // Ana joined once, then left: a User with no Organization, with a passkey.
        const ana = yield* withPasskey("Ana", acme, "member");
        yield* hub.server.sql`
          DELETE FROM space_memberships WHERE space_id = ${acme} AND user_id = ${ana.userId}
        `;
        const guest = (id: string, spaceId: SpaceId) =>
          addMember(hub.server, { id, displayName: id }).pipe(
            Effect.tap(() => joinOrganization(hub.server, spaceId, id, "guest")),
          );
        const acmeGuest = yield* guest("linus", acme);
        const globexGuest = yield* guest("gil", globex);

        // Machines: the Owner's and Ana's personal ones, one dedicated to each Organization.
        const ownerLaptop = yield* hub.join({ name: "Owner Laptop", adapters: idleAdapters });
        const anaLaptop = yield* hub.join({
          name: "Ana Laptop",
          adapters: idleAdapters,
          as: { cookie: ana.cookie, authenticator: ana.authenticator },
        });
        const acmeVps = yield* hub.join({
          name: "Acme VPS",
          adapters: idleAdapters,
          connect: false,
          as: { cookie: acmeAdmin.cookie, authenticator: acmeAdmin.authenticator },
        });
        const globexVps = yield* hub.join({
          name: "Globex VPS",
          adapters: idleAdapters,
          connect: false,
          as: { cookie: globexAdmin.cookie, authenticator: globexAdmin.authenticator },
        });
        const dedicate = (environmentId: EnvironmentId, spaceId: SpaceId) => hub.server.sql`
          UPDATE environments SET mode = 'dedicated', space_id = ${spaceId}, owner_user_id = NULL
          WHERE environment_id = ${environmentId}
        `;
        yield* dedicate(acmeVps.environmentId, acme);
        yield* dedicate(globexVps.environmentId, globex);
        const machines = [
          { id: ownerLaptop.environmentId, name: "Owner Laptop" },
          { id: anaLaptop.environmentId, name: "Ana Laptop" },
          { id: acmeVps.environmentId, name: "Acme VPS" },
          { id: globexVps.environmentId, name: "Globex VPS" },
        ];
        const names = machines.map((machine) => machine.name);
        const cast = [
          { name: "owner", cookie: hub.owner, sees: names, manages: names },
          { name: "ana", cookie: ana.cookie, sees: ["Ana Laptop"], manages: ["Ana Laptop"] },
          {
            name: "acme admin",
            cookie: acmeAdmin.cookie,
            sees: ["Acme VPS"],
            manages: ["Acme VPS"],
          },
          { name: "acme member", cookie: acmeMember.cookie, sees: ["Acme VPS"], manages: [] },
          { name: "acme guest", cookie: acmeGuest, sees: ["Acme VPS"], manages: [] },
          {
            name: "globex admin",
            cookie: globexAdmin.cookie,
            sees: ["Globex VPS"],
            manages: ["Globex VPS"],
          },
          { name: "globex member", cookie: globexMember.cookie, sees: ["Globex VPS"], manages: [] },
          { name: "globex guest", cookie: globexGuest, sees: ["Globex VPS"], manages: [] },
        ];
        const rows = () =>
          hub.server.sql<{
            readonly id: string;
            readonly name: string;
            readonly mode: string;
            readonly spaceId: string | null;
            readonly owner: string | null;
            readonly revoked: string | null;
          }>`
            SELECT environment_id AS id, name, mode, space_id AS "spaceId",
              owner_user_id AS owner, revoked_at AS revoked
            FROM environments ORDER BY environment_id
          `.pipe(Effect.map((list) => list.map((row) => ({ ...row }))));
        const swept = new Set<string>();
        const answers: Array<{
          readonly who: string;
          readonly door: string;
          readonly text: string;
        }> = [];
        for (const who of cast) {
          const call = Effect.fn(function* (door: string, path: string, body?: unknown) {
            swept.add(door);
            const answer = yield* hub.server.request(path, {
              cookie: who.cookie,
              ...(body === undefined ? {} : { body }),
            });
            answers.push({ who: who.name, door, text: JSON.stringify(answer.body) });
            return answer;
          });
          const listed = yield* call("http:environments.list", "/api/environments");
          assert.equal(listed.status, 200, `${who.name} lists`);
          yield* call("http:environments.sandboxes", "/api/environments/sandboxes");
          // The Owner may change every machine: its writes are tested where each one lives.
          if (who.name === "owner") continue;
          const before = yield* rows();
          for (const machine of machines) {
            if (who.manages.includes(machine.name)) continue;
            const id = machine.id;
            yield* call("http:environments.rename", "/api/environments/rename", {
              environmentId: id,
              name: `${machine.name} by ${who.name}`,
            });
            yield* call("http:environments.changeMode", "/api/environments/mode", {
              environmentId: id,
              mode: "dedicated",
              spaceId: globex,
            });
            yield* call("http:environments.changeMode", "/api/environments/mode", {
              environmentId: id,
              mode: "personal",
            });
            yield* call("http:environments.start", "/api/environments/start", {
              environmentId: id,
            });
            yield* call("http:environments.sandboxAction", "/api/environments/sandboxes/action", {
              environmentId: id,
              action: "stop",
            });
            yield* call("http:environments.sandboxLimits", "/api/environments/sandboxes/limits", {
              environmentId: id,
              limits: { cpus: 1, memoryBytes: null, pids: null, diskBytes: null },
            });
            yield* call("http:environments.remove", "/api/environments/remove", {
              environmentId: id,
            });
          }
          assert.deepEqual(yield* rows(), before, `${who.name} changed a machine not theirs`);
        }

        // Each caller lists what they may see, and no answer names a machine they may not.
        for (const who of cast) {
          const listed = answers.find(
            (answer) => answer.who === who.name && answer.door === "http:environments.list",
          );
          for (const name of who.sees) {
            assert.include(listed?.text ?? "", `"${name}"`, `${who.name} lists ${name}`);
          }
        }
        const named = answers.flatMap(({ who, door, text }) => {
          const caller = cast.find((entry) => entry.name === who)!;
          return names
            .filter((name) => !caller.sees.includes(name))
            .filter((name) => text.includes(`"${name}`))
            .map((name) => `${who} ${door} ${name}`);
        });
        assert.deepEqual(named, []);

        // Every machine door is called here, or in the file named for it.
        const doors = [
          ...[...WsRpcGroup.requests.keys()].map((tag) => `ws:${tag}`),
          ...Object.keys(HTTP_ENDPOINT_RULES).map((name) => `http:${name}`),
          ...Object.keys(RAW_ROUTE_RULES).map((name) => `raw:${name}`),
          ...Object.keys(MCP_TOOL_RULES).map((name) => `mcp:${name}`),
        ].filter((door) => RE_MACHINE_DOORS.test(door));
        assert.deepEqual(
          doors
            .filter(
              (door) =>
                !swept.has(door) &&
                !Object.keys(SWEPT_ELSEWHERE).some(
                  (elsewhere) => door === elsewhere || door.startsWith(`${elsewhere}:`),
                ),
            )
            .toSorted(),
          [],
        );
      }).pipe(Effect.scoped),
  );
});
