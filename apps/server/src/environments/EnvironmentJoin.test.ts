import { assert, it } from "@effect/vitest";
import {
  type EnvironmentHostResources,
  type EnvironmentProviderSummary,
  HUB_MACHINE_ENVIRONMENT_ID,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { addMember, passkeyReauth } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  approveJoin,
  confirmJoin,
  hubWithOwner,
  joinMachine,
  joinStatus,
  listEnvironments,
  loopbackStateOf,
  memberWithPasskey,
  startJoin,
} from "./environments.testkit.ts";

const TURNED_OFF = "This account is turned off.";
const STRONG_FACTOR = "Confirm with your passkey, or with your password and a code from your app.";

const registeredCount = (server: Effect.Success<ReturnType<typeof hubWithOwner>>["server"]) =>
  Effect.map(
    server.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM environments WHERE kind = 'external'
    `,
    (rows) => rows[0]?.count ?? 0,
  );

it.effect("the Owner registers a machine with a passkey and it joins as their personal one", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner, "Laptop");
    assert.match(joined.credential, /^t3env\./);

    const environments = yield* listEnvironments(server, owner);
    assert.deepEqual(
      environments.map(({ name, kind, status }) => ({ name, kind, status })),
      [
        { name: "Hub machine", kind: "hub", status: "online" },
        // Never connected yet.
        { name: "Laptop", kind: "external", status: "offline" },
      ],
    );
    assert.equal(environments[0]!.id, HUB_MACHINE_ENVIRONMENT_ID);
    assert.equal(environments[1]!.hostname, "ada-laptop");
    // The list never carries the credential, nor does the Hub keep it.
    assert.notInclude(JSON.stringify(environments), joined.credential);
    const [stored] = yield* server.sql<{ readonly hash: string }>`
      SELECT credential_hash AS hash FROM environments WHERE environment_id = ${joined.environmentId}
    `;
    assert.notEqual(stored!.hash, joined.credential);
    assert.notInclude(stored!.hash, joined.credential.split(".")[2]!);

    const audit = yield* server.request("/api/installation/audit?action=environment.register", {
      cookie: owner,
    });
    const [entry] = audit.body.entries as ReadonlyArray<{
      target: { kind: string; id: string; name: string };
      detail: Record<string, unknown>;
    }>;
    assert.deepEqual(entry!.target, {
      kind: "environment",
      id: joined.environmentId,
      name: "Laptop",
    });
    const [ownerRow] = yield* server.sql<{ readonly id: string }>`
      SELECT user_id AS id FROM users WHERE is_owner = 1
    `;
    // The machine's owner is on record (owned-resources 07): here the Owner, as a User.
    assert.deepEqual(entry!.detail, {
      kind: "external",
      os: "linux",
      mode: "personal",
      via: "join",
      ownerKind: "user",
      ownerId: ownerRow!.id,
    });
  }),
);

it.effect("a disabled User approves no machine, whatever proof they bring", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const grace = yield* memberWithPasskey(server, owner, { displayName: "Grace Hopper" });
    const { requestId } = yield* startJoin(server);
    const reauth = yield* passkeyReauth(server, grace.authenticator);
    const disabled = yield* server.request(`/api/installation/users/${grace.userId}/status`, {
      cookie: owner,
      body: { status: "disabled" },
    });
    assert.equal(disabled.status, 200);
    const refused = yield* approveJoin(server, grace.cookie, requestId, { reauth });
    assert.notEqual(refused.status, 200);
    assert.notProperty(refused.body, "redirectTo");
    assert.equal((yield* joinStatus(server, requestId)).body.status, "pending");
    assert.equal(yield* registeredCount(server), 0);
  }),
);

it.effect("a Member with no permission approves their own machine, theirs alone", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const grace = yield* memberWithPasskey(server, owner, { displayName: "Grace Hopper" });
    const linus = yield* memberWithPasskey(server, owner, {
      displayName: "Linus",
      spaceId: grace.spaceId,
    });
    const external = (cookie: string) =>
      Effect.map(listEnvironments(server, cookie), (list) =>
        list
          .filter((environment) => environment.kind === "external")
          .map(({ id, ownerUserId }) => ({ id, ownerUserId })),
      );

    const { requestId } = yield* startJoin(server);
    const view = yield* server.request("/api/environments/join/request", {
      cookie: grace.cookie,
      body: { requestId },
    });
    assert.equal(view.body.viewerMayApprove, true);
    assert.equal(view.body.hostname, "ada-laptop");
    // Still a strong factor in the same request.
    assert.equal((yield* approveJoin(server, grace.cookie, requestId)).body.message, STRONG_FACTOR);
    const approved = yield* approveJoin(server, grace.cookie, requestId, {
      name: "Grace's laptop",
      reauth: yield* passkeyReauth(server, grace.authenticator),
    });
    assert.equal(approved.status, 200);
    // `t3 join` is told who approved, as whose machine, before anything is registered.
    const awaiting = yield* joinStatus(server, requestId);
    assert.deepEqual(awaiting.body, {
      status: "awaiting-confirmation",
      name: "Grace's laptop",
      approvedBy: { userId: grace.userId, displayName: "Grace Hopper", loginName: null },
    });
    assert.deepEqual(yield* external(owner), []);
    assert.equal((yield* confirmJoin(server, requestId, true)).status, 200);
    const status = yield* joinStatus(server, requestId);
    assert.equal(status.body.status, "approved");
    const environmentId = status.body.environmentId as string;

    const mine = [{ id: environmentId, ownerUserId: grace.userId }];
    assert.deepEqual(yield* external(grace.cookie), mine);
    // The Owner sees every machine; another Member does not see this one.
    assert.deepEqual(yield* external(owner), mine);
    assert.deepEqual(yield* external(linus.cookie), []);

    const audit = yield* server.request("/api/installation/audit?action=environment.register", {
      cookie: owner,
    });
    const [entry] = audit.body.entries as ReadonlyArray<{
      actor: { userId: string };
      target: { id: string };
      detail: Record<string, unknown>;
    }>;
    assert.equal(entry!.actor.userId, grace.userId);
    assert.equal(entry!.target.id, environmentId);
    assert.deepInclude(entry!.detail, { ownerKind: "user", ownerId: grace.userId });

    // Their own to rename and remove; nobody else's.
    const renamed = yield* server.request("/api/environments/rename", {
      cookie: grace.cookie,
      body: { environmentId, name: "Work laptop" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Work laptop");
    const linusRemoves = yield* server.request("/api/environments/remove", {
      cookie: linus.cookie,
      body: { environmentId },
    });
    assert.equal(linusRemoves.status, 404);
    const hubRename = yield* server.request("/api/environments/rename", {
      cookie: grace.cookie,
      body: { environmentId: HUB_MACHINE_ENVIRONMENT_ID, name: "Mine" },
    });
    assert.equal(hubRename.status, 403);
    const removed = yield* server.request("/api/environments/remove", {
      cookie: grace.cookie,
      body: { environmentId },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(yield* external(owner), []);
  }),
);

it.effect("removing the User removes their machines", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const grace = yield* memberWithPasskey(server, owner, { displayName: "Grace Hopper" });
    const joined = yield* joinMachine(server, grace.authenticator, grace.cookie);
    assert.include(
      (yield* listEnvironments(server, grace.cookie)).map((environment) => environment.id),
      joined.environmentId,
    );
    const removedUser = yield* server.request(`/api/installation/users/${grace.userId}/status`, {
      cookie: owner,
      body: { status: "removed" },
    });
    assert.equal(removedUser.status, 200);
    assert.notInclude(
      (yield* listEnvironments(server, owner)).map((environment) => environment.id),
      joined.environmentId,
    );
  }),
);

it.effect("a User turned off between the approval and the write registers nothing", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const grace = yield* memberWithPasskey(server, owner, { displayName: "Grace Hopper" });
    const { requestId } = yield* startJoin(server);
    const approved = yield* approveJoin(server, grace.cookie, requestId, {
      reauth: yield* passkeyReauth(server, grace.authenticator),
    });
    assert.equal(approved.status, 200);
    // Active when she approved, off by the write: the registry asks again in its transaction.
    const disabled = yield* server.request(`/api/installation/users/${grace.userId}/status`, {
      cookie: owner,
      body: { status: "disabled" },
    });
    assert.equal(disabled.status, 200);
    const confirmed = yield* confirmJoin(server, requestId, true);
    assert.equal(confirmed.status, 403);
    assert.equal(confirmed.body.message, TURNED_OFF);
    assert.equal(yield* registeredCount(server), 0);
    assert.equal((yield* joinStatus(server, requestId)).body.status, "denied");
  }),
);

it.effect(
  "an approval by someone the machine did not expect registers nothing until it confirms",
  () =>
    Effect.gen(function* () {
      const { server, owner, authenticator } = yield* hubWithOwner();
      const mallory = yield* memberWithPasskey(server, owner, { displayName: "Mallory" });
      // Grace's `t3 join`; Mallory got hold of its link and approves first.
      const { requestId } = yield* startJoin(server);
      const approved = yield* approveJoin(server, mallory.cookie, requestId, {
        reauth: yield* passkeyReauth(server, mallory.authenticator),
      });
      assert.equal(approved.status, 200);
      const awaiting = yield* joinStatus(server, requestId);
      assert.equal(awaiting.body.status, "awaiting-confirmation");
      assert.equal((awaiting.body.approvedBy as { displayName: string }).displayName, "Mallory");
      assert.equal(yield* registeredCount(server), 0);
      // Nobody else decides it any more.
      const ownerApproves = yield* approveJoin(server, owner, requestId, {
        reauth: yield* passkeyReauth(server, authenticator),
      });
      assert.equal(ownerApproves.status, 404);
      // Grace's machine refuses: nothing is registered, ever.
      const refused = yield* confirmJoin(server, requestId, false);
      assert.equal(refused.status, 200);
      assert.equal(refused.body.status, "denied");
      assert.equal((yield* joinStatus(server, requestId)).body.status, "denied");
      assert.equal((yield* confirmJoin(server, requestId, true)).status, 404);
      assert.equal(yield* registeredCount(server), 0);
      // Only the `t3 join` that started it confirms.
      const other = yield* startJoin(server);
      yield* approveJoin(server, mallory.cookie, other.requestId, {
        reauth: yield* passkeyReauth(server, mallory.authenticator),
      });
      const stranger = yield* confirmJoin(
        server,
        other.requestId,
        true,
        "another-code-verifier-that-is-long-enough-for-pkce-0123",
      );
      assert.equal(stranger.status, 401);
      assert.equal(yield* registeredCount(server), 0);
    }),
);

it.effect("only a request still pending is denied", () =>
  Effect.gen(function* () {
    const { server, owner, authenticator } = yield* hubWithOwner();
    const deny = (cookie: string, requestId: string) =>
      server.request("/api/environments/join/deny", { cookie, body: { requestId } });
    const { requestId } = yield* startJoin(server);

    // Approved and waiting for the machine: no longer anyone's to deny.
    yield* approveJoin(server, owner, requestId, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    assert.equal((yield* deny(owner, requestId)).status, 404);
    assert.equal((yield* joinStatus(server, requestId)).body.status, "awaiting-confirmation");
    const joined = yield* joinMachine(server, authenticator, owner);
    assert.equal((yield* deny(owner, joined.requestId)).status, 404);
  }),
);

it.effect("the Hub machine's load and providers are the Owner's to see", () =>
  Effect.gen(function* () {
    const { server } = yield* hubWithOwner();
    yield* addMember(server);
    const [ownerRow] = yield* server.sql<{ readonly id: string }>`
      SELECT user_id AS id FROM users WHERE is_owner = 1
    `;
    const registry = Context.get(server.services, EnvironmentRegistry.EnvironmentRegistry);
    const provider = {
      instanceId: "claudeAgent",
      provider: "claudeAgent",
      displayName: null,
      enabled: true,
      installed: true,
      version: "1.0.0",
      capabilities: { runtimeModes: [], conversationRollback: true, textGeneration: false },
    } as unknown as EnvironmentProviderSummary;
    const resources = {
      hostResources: {
        sampledAt: 0,
        cpuUtilization: 0.5,
        cpuCount: 8,
        availableMemoryBytes: 1,
        totalMemoryBytes: 2,
      },
      disk: null,
    } as unknown as EnvironmentHostResources;
    const hubRow = (userId: string) =>
      registry.list(UserId.make(userId)).pipe(
        Effect.map((list) => list.find((environment) => environment.kind === "hub")!),
        Effect.provideService(EnvironmentRegistry.HubMachineSnapshot, {
          providers: Effect.succeed([provider]),
          resources: Effect.succeed(resources),
        }),
      );
    const forOwner = yield* hubRow(ownerRow!.id);
    assert.deepEqual(forOwner.providers, [provider]);
    assert.deepEqual(forOwner.resources, resources);
    const forMember = yield* hubRow("member-1");
    assert.deepEqual(
      {
        providers: forMember.providers,
        resources: forMember.resources,
        runningThreadCount: forMember.runningThreadCount,
      },
      { providers: [], resources: null, runningThreadCount: 0 },
    );
  }),
);

it.effect("the Owner's approval needs a strong factor in the same request", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const { requestId } = yield* startJoin(server);
    // A stolen browser session alone, or a password without a code, adds no machine.
    for (const reauth of [undefined, { method: "password", password: "guess" }]) {
      const refused = yield* approveJoin(
        server,
        owner,
        requestId,
        reauth === undefined ? {} : { reauth },
      );
      assert.equal(refused.status, 403);
      assert.equal(refused.body.message, STRONG_FACTOR);
    }
    // Without the browser's own cookie nothing is approved.
    assert.equal((yield* approveJoin(server, "", requestId)).status, 401);
    assert.equal((yield* joinStatus(server, requestId)).body.status, "pending");
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub"],
    );
  }),
);

it.effect("only the `t3 join` that started a request learns its outcome, as often as it asks", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    // Another verifier learns nothing.
    const stranger = yield* joinStatus(
      server,
      joined.requestId,
      "another-code-verifier-that-is-long-enough-for-pkce-0123",
    );
    assert.equal(stranger.status, 401);
    // A lost answer is asked for again: the same machine, no second row or audit entry.
    const again = yield* joinStatus(server, joined.requestId);
    assert.deepEqual(again.body, {
      status: "approved",
      environmentId: joined.environmentId,
      hubEnvironmentId: joined.hubEnvironmentId,
      name: "Laptop",
    });
    const reapproved = yield* approveJoin(server, owner, joined.requestId, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    assert.equal(reapproved.status, 200);
    const [rows] = yield* server.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM environments WHERE kind = 'external'
    `;
    assert.equal(rows!.count, 1);
    const audit = yield* server.request("/api/installation/audit?action=environment.register", {
      cookie: owner,
    });
    assert.lengthOf(audit.body.entries as ReadonlyArray<unknown>, 1);
    // The credential never crossed the wire from the Hub.
    assert.notInclude(JSON.stringify(again.body), joined.credential);
  }),
);

it.effect("a browser on the machine returns to `t3 join`, and a refusal tells it so", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const approved = yield* startJoin(server, { loopback: true });
    const decided = yield* approveJoin(server, owner, approved.requestId, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    assert.equal(loopbackStateOf(decided.body.redirectTo), "state-0123456789abcdef");

    const denied = yield* startJoin(server);
    const refused = yield* server.request("/api/environments/join/deny", {
      cookie: owner,
      body: { requestId: denied.requestId },
    });
    assert.deepEqual(refused.body, { redirectTo: null });
    assert.equal((yield* joinStatus(server, denied.requestId)).body.status, "denied");
    assert.equal((yield* joinStatus(server, "no-such-request-0123")).body.status, "expired");
  }),
);

it.effect("a join request asks only for a loopback return and a well-formed hash", () =>
  Effect.gen(function* () {
    const { server } = yield* hubWithOwner();
    const started = yield* server.request("/api/environments/join/start", {
      body: {
        codeChallenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
        codeChallengeMethod: "S256",
        credentialHash: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
        name: "x",
        os: "linux",
        hostname: "x",
        redirectUri: "https://evil.example.com/callback",
        state: "state-0123456789abcdef",
      },
    });
    assert.equal(started.status, 400);
  }),
);

it.effect("a Member sees the Hub machine but not the Owner's personal machines", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const member = yield* addMember(server);
    assert.deepEqual(
      (yield* listEnvironments(server, member)).map((environment) => environment.kind),
      ["hub"],
    );
    // Naming it answers like a machine that does not exist.
    for (const path of ["rename", "remove"]) {
      const refused = yield* server.request(`/api/environments/${path}`, {
        cookie: member,
        body: { environmentId: joined.environmentId, name: "Mine now" },
      });
      assert.equal(refused.status, 404);
    }
  }),
);

it.effect("renaming and removing are audited, and the Hub machine stays", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const renamed = yield* server.request("/api/environments/rename", {
      cookie: owner,
      body: { environmentId: joined.environmentId, name: "Work laptop" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Work laptop");

    const hubRemoval = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: HUB_MACHINE_ENVIRONMENT_ID },
    });
    assert.equal(hubRemoval.status, 403);

    const removed = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: joined.environmentId },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (removed.body.environments as ReadonlyArray<{ kind: string }>).map((entry) => entry.kind),
      ["hub"],
    );
    // A removed machine's credential no longer even unregisters it.
    const left = yield* server.request("/api/environments/leave", {
      authorization: `Bearer ${joined.credential}`,
      body: {},
    });
    assert.equal(left.status, 401);

    const audit = yield* server.request("/api/installation/audit", { cookie: owner });
    const entries = (
      audit.body.entries as ReadonlyArray<{ action: string; detail: Record<string, unknown> }>
    ).filter((entry) => entry.action.startsWith("environment."));
    assert.deepEqual(
      entries.map(({ action, detail }) => ({ action, detail })),
      [
        { action: "environment.remove", detail: { via: "settings" } },
        { action: "environment.rename", detail: { from: "Laptop", to: "Work laptop" } },
        {
          action: "environment.register",
          detail: {
            kind: "external",
            os: "linux",
            mode: "personal",
            via: "join",
            ownerKind: "user",
            ownerId: (yield* server.sql<{ readonly id: string }>`
              SELECT user_id AS id FROM users WHERE is_owner = 1
            `)[0]!.id,
          },
        },
      ],
    );
  }),
);

it.effect("`t3 leave` unregisters the machine with its own credential", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const overPlainHttp = yield* server.request("/api/environments/leave", {
      authorization: `Bearer ${joined.credential}`,
      peer: "203.0.113.7",
      body: {},
    });
    assert.equal(overPlainHttp.status, 400);
    // The scheme is case-insensitive, as for every other bearer the Hub takes.
    const left = yield* server.request("/api/environments/leave", {
      authorization: `bearer ${joined.credential}`,
      body: {},
    });
    assert.equal(left.status, 200);
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub"],
    );
  }),
);
