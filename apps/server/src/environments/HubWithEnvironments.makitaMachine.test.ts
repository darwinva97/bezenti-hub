/**
 * Makita ticket 15, «Where it works»: a Makita Thread placed on the machine its configuration
 * chose, only while that machine is dedicated to the Thread's Space; never a personal machine,
 * another Space's, or the Sandbox in its place.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { listEnvironments } from "./environments.testkit.ts";
import { makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");

/** The provider, with no recorded turns: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

describe("Hub con Environments: a Makita configuration's dedicated machine", () => {
  it.live(
    "places its Threads there only while it is dedicated to their Space, as a Member of it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const directory = hub.service(SpaceDirectory.SpaceDirectory);
        const [owner] = yield* hub.server.sql<{ readonly userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        assert.isDefined(owner);
        const ownerId = UserId.make(owner.userId);
        const acme = (yield* directory.createOrganization(ownerId, "Acme").pipe(Effect.orDie)).id;
        const globex = (yield* directory.createOrganization(ownerId, "Globex").pipe(Effect.orDie))
          .id;
        const grace = UserId.make("member-1");
        const linus = UserId.make("guest-1");
        const hedy = UserId.make("member-2");
        yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        yield* addMember(hub.server, { id: linus, displayName: "Linus" });
        yield* addMember(hub.server, { id: hedy, displayName: "Hedy" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, acme, linus, "guest");
        yield* joinOrganization(hub.server, globex, hedy, "member");
        yield* directory.changed;
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
        const vps = (yield* hub.joinDedicated({
          name: "Acme VPS",
          spaceId: acme,
          adapters: idleAdapters,
        })).environmentId;
        // The Owner's personal machine, never connected: it is not anyone's Space's.
        const laptop = (yield* hub.join({ name: "Laptop", adapters: idleAdapters, connect: false }))
          .environmentId;
        assert.equal(
          (yield* listEnvironments(hub.server, hub.owner)).find((entry) => entry.id === vps)
            ?.status,
          "online",
        );

        assert.deepEqual(yield* registry.dedicatedMachines(acme), [{ id: vps, name: "Acme VPS" }]);
        assert.deepEqual(yield* registry.dedicatedMachines(globex), []);

        const onMachine = (userId: UserId, projectId: ProjectId, machine: EnvironmentId) =>
          registry.chooseForThread({
            userId,
            requested: undefined,
            projectId,
            providerInstanceId: INSTANCE,
            spaceWorkOnly: true,
            spaceWorkOn: machine,
          });
        const refusal = (userId: UserId, projectId: ProjectId, machine: EnvironmentId) =>
          onMachine(userId, projectId, machine).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
            ),
          );

        assert.equal(yield* onMachine(grace, acmeProject, vps), vps);
        // Another Space's Thread, a personal machine or one the Hub does not know: refused with
        // the reason, and nothing falls back to the Sandbox.
        const notDedicated = yield* onMachine(hedy, globexProject, vps).pipe(Effect.flip);
        assert.equal(
          EnvironmentRegistry.environmentRefusalMessage(notDedicated),
          "This machine is no longer dedicated to this Space.",
        );
        assert.equal(yield* refusal(ownerId, acmeProject, laptop), "not-dedicated");
        assert.equal(
          yield* refusal(grace, acmeProject, EnvironmentId.make("no-such-machine")),
          "not-dedicated",
        );
        // Dedicated to Acme, but a Guest there still may not use it.
        assert.equal(yield* refusal(linus, acmeProject, vps), "not-usable");
      }).pipe(Effect.scoped),
  );
});

// Runs with the server wiring of the registry (server.ts).
