// @effect-diagnostics nodeBuiltinImport:off -- reads the Hub's files and its machine's addresses.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * «Hub con Environments», spec 3 ticket 10: «Add a machine over SSH». The Hub's own SSH client
 * against a real SSH server in the test's process (SshTestMachine), which plays the machine: the
 * Owner confirms its host key, the Hub runs the four steps there, the machine redeems the run's
 * one-use grant as `t3 join --grant-on-stdin` does and its service asks the Hub how it is used.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type EnvironmentId,
  type SshInstallRun,
  SshInstallStartRequest,
  type SpaceId,
  UserId,
} from "@t3tools/contracts";
import { formatEnvironmentCredential } from "@t3tools/shared/environmentJoin";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { listEnvironments, memberWithPasskey } from "./environments.testkit.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";
import * as SshInstall from "./sshInstall/SshInstall.ts";
import { STEP_BUSY_MARKER } from "./sshInstall/sshInstallScripts.ts";
import {
  makeTestMachine,
  type StepHandler,
  type StepRequest,
  type TestMachine,
} from "./sshInstall/SshTestMachine.testkit.ts";

const POLICY: SshInstall.SshInstallPolicy["Service"] = {
  runner: {
    archiveVersion: "0.1.7",
    releaseBaseUrl: "https://releases.example.com/t3",
    nodeScriptPath: null,
    nodeEngineRange: null,
  },
  version: "0.1.7",
  stepTimeoutMs: { check: 20_000, install: 20_000, register: 20_000, service: 20_000 },
  reachTimeoutMs: 10_000,
  reachPollMs: 25,
  hostKeyTtlMs: 120_000,
  grantTtlMs: 60_000,
  // Its SSH servers listen on this machine's loopback.
  allowHubHost: true,
  agentSocket: null,
};

const sha256 = (value: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => Buffer.from(bytes).toString("base64url"));

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** Acme with an Admin, a Member and a Guest, each with a session of their own. */
const acmeWithPeople = Effect.fn(function* (hub: Hub) {
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(yield* ownerIdOf(hub), "Acme")
    .pipe(Effect.orDie);
  const people = {
    admin: { id: UserId.make("admin-1"), displayName: "Ada" },
    member: { id: UserId.make("member-1"), displayName: "Grace" },
    guest: { id: UserId.make("guest-1"), displayName: "Linus" },
  } as const;
  const cookies = {} as Record<keyof typeof people, string>;
  for (const role of ["admin", "member", "guest"] as const) {
    cookies[role] = yield* addMember(hub.server, people[role]);
    yield* joinOrganization(hub.server, created.id, people[role].id, role);
  }
  yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
  return { acme: created.id, cookies };
});

/**
 * A machine that does what each step asks: `register` redeems the grant from its standard input
 * (as `t3 join --grant-on-stdin`), `service` asks the Hub how it is used with that credential (as
 * a dedicated machine's server does first). `overrides` replace a step.
 */
const healthyMachine = (hub: Hub, overrides: Partial<Record<string, StepHandler>> = {}) => {
  const hubId = hub.service(EnvironmentRegistry.EnvironmentRegistry).hubId;
  const state = { credential: undefined as string | undefined };
  const handler: StepHandler = (request) => {
    const override = overrides[request.step];
    if (override !== undefined) return override(request);
    switch (request.step) {
      case "check":
        return written(request, "System: Linux x86_64\nRootless Podman is ready.\n", 0);
      case "install":
        return written(request, "T3 Code: 0.1.7\n", 0);
      case "register":
        return redeem(hub, hubId, state, request);
      case "service":
        return askSelf(hub, state.credential).pipe(Effect.as(0));
      default:
        return Effect.succeed(0);
    }
  };
  return { handler, state };
};

/** Writes `text` to the step's output and exits with `code`. */
const written = (request: StepRequest, text: string, code: number) =>
  Effect.sync(() => {
    request.write(text);
    return code;
  });

const redeem = Effect.fn(function* (
  hub: Hub,
  hubId: string,
  state: { credential: string | undefined },
  request: StepRequest,
) {
  const credential = formatEnvironmentCredential(
    hubId,
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  );
  const answer = yield* hub.server.request("/api/environments/join/grant", {
    body: {
      grant: request.stdin.trim(),
      credentialHash: yield* Effect.promise(() => sha256(credential)),
      os: "linux",
      hostname: "vps-1",
    },
  });
  if (answer.status !== 200) {
    request.write(`The Hub did not register the machine (HTTP ${answer.status}).\n`);
    return 1;
  }
  state.credential = credential;
  request.write(`Joined as ${String(answer.body.name)}.\n`);
  return 0;
});

const askSelf = (hub: Hub, credential: string | undefined) =>
  hub.server.request("/api/environments/self", {
    body: {},
    authorization: `Bearer ${credential ?? "none"}`,
  });

const startBody = (
  machine: TestMachine,
  spaceId: SpaceId,
  overrides: Record<string, unknown> = {},
) => ({
  host: "127.0.0.1",
  port: machine.port,
  username: machine.username,
  auth: {
    kind: "key",
    privateKey: machine.privateKey,
    ...(machine.passphrase === undefined ? {} : { passphrase: machine.passphrase }),
  },
  spaceId,
  name: "Acme VPS",
  hubUrl: "http://127.0.0.1:3773",
  keepForUpdates: false,
  ...overrides,
});

const decodeStartRequest = Schema.decodeUnknownSync(SshInstallStartRequest);

const runOf = (body: unknown) => body as unknown as SshInstallRun;

/** Starts a run as the Owner and confirms the host key it shows; the run once it has ended. */
const installOver = Effect.fn(function* (
  hub: Hub,
  machine: TestMachine,
  spaceId: SpaceId,
  overrides: Record<string, unknown> = {},
) {
  const started = yield* hub.server.request("/api/environments/ssh/start", {
    cookie: hub.owner,
    body: startBody(machine, spaceId, overrides),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const run = runOf(started.body);
  assert.equal(run.state, "awaiting-host-key", JSON.stringify(run));
  const confirmed = yield* hub.server.request("/api/environments/ssh/confirm", {
    cookie: hub.owner,
    body: { runId: run.runId, fingerprint: run.hostKey?.fingerprint },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
});

const auditOf = Effect.fn(function* (hub: Hub, environmentId: string) {
  return yield* hub.server.sql<{ readonly action: string; readonly detail: string }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE target_id = ${environmentId} ORDER BY rowid
  `;
});

const keyFragments = (privateKey: string) =>
  privateKey.split("\n").filter((line) => line.length >= 16 && !line.startsWith("-----"));

/** The text of every file under `directory` (its database, logs, anything written). */
const filesUnder = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodeFS.readFileSync(NodePath.join(entry.parentPath, entry.name), "latin1"));

describe("Hub con Environments: add a machine over SSH", () => {
  it.live(
    "installs and registers it dedicated, via ssh, only once the Owner confirms its host key",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub).handler);

        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        });
        assert.equal(started.status, 200, JSON.stringify(started.body));
        const run = runOf(started.body);
        // The host key is shown, and nothing was signed into or run before it is confirmed.
        assert.equal(run.state, "awaiting-host-key");
        assert.deepEqual(run.hostKey, {
          algorithm: "ssh-ed25519",
          fingerprint: machine.fingerprint,
        });
        assert.notInclude(machine.authentications, "publickey");
        assert.deepEqual(machine.steps, []);
        // Another key than the one shown starts nothing.
        const wrong = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: "SHA256:not-the-one-shown" },
        });
        assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
        assert.deepEqual(machine.steps, []);

        const confirmed = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: machine.fingerprint },
        });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        const done = yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        assert.deepEqual(
          done.steps.map((step) => [step.id, step.state]),
          [
            ["check", "succeeded"],
            ["install", "succeeded"],
            ["register", "succeeded"],
            ["service", "succeeded"],
          ],
        );
        assert.include(done.steps[0]?.output ?? [], "Rootless Podman is ready.");
        assert.include(done.steps[3]?.output ?? [], "The machine reached the Hub.");
        assert.deepEqual(
          machine.steps.map((step) => step.step),
          ["check", "install", "register", "service"],
        );
        // T3 of the Hub's version from its release source; the grant only on standard input.
        assert.include(machine.steps[1]?.stdin ?? "", "T3_ARCHIVE_VERSION='0.1.7'");
        const grant = machine.steps[2]?.stdin.trim() ?? "";
        assert.isAbove(grant.length, 30);
        assert.notInclude(machine.steps[2]?.script ?? "", grant);
        assert.notInclude(JSON.stringify(done), grant);

        const environmentId = done.environmentId;
        assert.isNotNull(environmentId);
        const listed = (yield* listEnvironments(hub.server, hub.owner)).find(
          (environment) => environment.id === environmentId,
        );
        assert.deepInclude(listed, { name: "Acme VPS", mode: "dedicated", spaceId: acme });

        // Audited as registered dedicated via ssh, with the host; never the key.
        const audit = yield* auditOf(hub, environmentId!);
        assert.deepEqual(
          audit.map((row) => [row.action, JSON.parse(row.detail)]),
          [
            [
              "environment.register",
              {
                kind: "external",
                os: "linux",
                mode: "dedicated",
                via: "ssh",
                host: "127.0.0.1",
                spaceId: acme,
                ownerKind: "organization",
                ownerId: acme,
              },
            ],
          ],
        );
        const allAudit = yield* hub.server.sql<{ readonly row: string }>`
          SELECT detail_json || target_name AS row FROM audit_log
        `;
        for (const fragment of keyFragments(machine.privateKey)) {
          assert.notInclude(JSON.stringify(allAudit), fragment);
        }
        // The key was not kept, and the grant is spent.
        const kept = yield* hub
          .service(ServerSecretStore.ServerSecretStore)
          .get(SshInstall.keptKeySecretName(environmentId!));
        assert.isTrue(Option.isNone(kept));
        const replay = yield* hub.server.request("/api/environments/join/grant", {
          body: {
            grant,
            credentialHash: yield* Effect.promise(() => sha256("another")),
            os: "linux",
            hostname: "evil",
          },
        });
        assert.equal(replay.status, 401, JSON.stringify(replay.body));
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a Member and a Guest on every door, and shows a run to nobody but who started it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme, cookies } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine();
        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        });
        const run = runOf(started.body);
        for (const role of ["member", "guest"] as const) {
          const refused = yield* hub.server.request("/api/environments/ssh/start", {
            cookie: cookies[role],
            body: startBody(machine, acme),
          });
          assert.equal(refused.status, 403, `${role}: ${JSON.stringify(refused.body)}`);
        }
        // The Owner's run answers like a missing one to anyone else, an Admin included.
        for (const role of ["admin", "member", "guest"] as const) {
          const doors = [
            [
              "/api/environments/ssh/confirm",
              { runId: run.runId, fingerprint: machine.fingerprint },
            ],
            ["/api/environments/ssh/status", { runId: run.runId }],
            ["/api/environments/ssh/cancel", { runId: run.runId }],
          ] as const;
          for (const [path, body] of doors) {
            const refused = yield* hub.server.request(path, { cookie: cookies[role], body });
            assert.include([403, 404], refused.status, `${role} ${path}`);
            assert.notInclude(JSON.stringify(refused.body), machine.fingerprint);
          }
        }
        // Nothing they sent moved the Owner's run, or reached the machine.
        const status = yield* hub.server.request("/api/environments/ssh/status", {
          cookie: hub.owner,
          body: { runId: run.runId },
        });
        assert.equal(runOf(status.body).state, "awaiting-host-key");
        assert.deepEqual(machine.steps, []);
      }).pipe(Effect.scoped),
  );

  it.live(
    "an Admin installs a machine for the Organization they run, confirming its host key as the Owner does, never for another",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const globex = (yield* hub
          .service(SpaceDirectory.SpaceDirectory)
          .createOrganization(yield* ownerIdOf(hub), "Globex")
          .pipe(Effect.orDie)).id;
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada Admin",
          spaceId: acme,
          role: "admin",
        });
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub).handler);

        // Not for Globex, which she does not run: nothing is opened.
        const toGlobex = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: ada.cookie,
          body: startBody(machine, globex),
        });
        assert.equal(toGlobex.status, 403, JSON.stringify(toGlobex.body));
        assert.deepEqual(machine.steps, []);

        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: ada.cookie,
          body: startBody(machine, acme),
        });
        assert.equal(started.status, 200, JSON.stringify(started.body));
        const run = runOf(started.body);
        assert.equal(run.state, "awaiting-host-key");
        assert.deepEqual(machine.steps, []);
        // Another key than the one shown starts nothing, for her as for the Owner.
        const wrong = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: ada.cookie,
          body: { runId: run.runId, fingerprint: "SHA256:not-the-one-shown" },
        });
        assert.equal(wrong.status, 409);
        assert.deepEqual(machine.steps, []);
        // Her run is hers: the Owner does not see or move it.
        const ownersLook = yield* hub.server.request("/api/environments/ssh/status", {
          cookie: hub.owner,
          body: { runId: run.runId },
        });
        assert.equal(ownersLook.status, 404);

        const confirmed = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: ada.cookie,
          body: { runId: run.runId, fingerprint: machine.fingerprint },
        });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        const done = yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        const environmentId = done.environmentId;
        assert.isNotNull(environmentId);
        const listed = (yield* listEnvironments(hub.server, ada.cookie)).find(
          (environment) => environment.id === environmentId,
        );
        assert.deepInclude(listed, { mode: "dedicated", spaceId: acme, ownerUserId: null });
        const [registered] = yield* hub.server.sql<{
          readonly actor: string;
          readonly detail: string;
        }>`
          SELECT actor_user_id AS actor, detail_json AS detail FROM audit_log
          WHERE target_id = ${environmentId} AND action = 'environment.register'
        `;
        assert.equal(registered?.actor, ada.userId);
        assert.deepInclude(JSON.parse(registered?.detail ?? "{}"), {
          ownerKind: "organization",
          ownerId: acme,
          via: "ssh",
        });
      }).pipe(Effect.scoped),
  );

  it.live("stops at a failing step with its output, and leaves no machine registered", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: { ...POLICY, reachTimeoutMs: 300 } });
      const { acme } = yield* acmeWithPeople(hub);
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly overrides: (machine: TestMachine) => Partial<Record<string, StepHandler>>;
        readonly failedAt: string;
        readonly error: RegExp;
        readonly output?: string;
        readonly undone: boolean;
        /** Whether it says what it left on the machine: anything from the install step on. */
        readonly leftover: boolean;
      }> = [
        {
          name: "no Podman and no sudo",
          overrides: () => ({
            check: (request) =>
              written(request, "Podman is not installed, and deploy cannot use sudo.\n", 12),
          }),
          failedAt: "check",
          error: /Podman is missing/u,
          output: "Podman is not installed, and deploy cannot use sudo.",
          undone: false,
          leftover: false,
        },
        {
          name: "a failed install",
          overrides: () => ({
            install: (request) =>
              written(request, "curl: (22) The requested URL returned error: 404\n", 1),
          }),
          failedAt: "install",
          error: /Install T3 Code failed \(exit code 1\)/u,
          output: "curl: (22) The requested URL returned error: 404",
          undone: false,
          leftover: true,
        },
        {
          // Joined already (to this Hub or another): what is there is not this run's to undo.
          name: "a machine that refuses to join",
          overrides: () => ({
            register: (request) =>
              written(request, "This machine is already joined to https://other.example.\n", 1),
          }),
          failedAt: "register",
          error: /Register the machine failed/u,
          output: "This machine is already joined to https://other.example.",
          undone: false,
          leftover: true,
        },
        {
          name: "a lost connection",
          overrides: (machine) => ({
            install: () => Effect.sync(() => machine.drop()).pipe(Effect.andThen(Effect.never)),
          }),
          failedAt: "install",
          error: /connection was lost/u,
          undone: false,
          leftover: true,
        },
        {
          name: "a service that never reaches the Hub",
          overrides: () => ({ service: () => Effect.succeed(0) }),
          failedAt: "service",
          error: /did not reach the Hub in time/u,
          undone: true,
          leftover: true,
        },
      ];
      for (const testCase of cases) {
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub, testCase.overrides(machine)).handler);
        const done = yield* installOver(hub, machine, acme);
        assert.equal(done.state, "failed", `${testCase.name}: ${JSON.stringify(done)}`);
        assert.match(done.error ?? "", testCase.error, testCase.name);
        const failed = done.steps.find((step) => step.state === "failed");
        assert.equal(failed?.id, testCase.failedAt, testCase.name);
        if (testCase.output !== undefined) {
          assert.include(failed?.output ?? [], testCase.output, testCase.name);
        }
        // The steps after it never ran.
        const after = done.steps.slice(done.steps.findIndex((step) => step.state === "failed") + 1);
        assert.isTrue(
          after.every((step) => step.state === "cancelled"),
          testCase.name,
        );
        assert.isNull(done.environmentId, testCase.name);
        assert.equal(
          machine.steps.some((step) => step.step === "undo"),
          testCase.undone,
          testCase.name,
        );
        assert.equal(
          (failed?.output ?? []).some((line) =>
            line.includes("Left on the machine: ~/.t3/ssh-install"),
          ),
          testCase.leftover,
          `${testCase.name}: ${JSON.stringify(failed?.output)}`,
        );
      }
      // No machine of any of them is live, and the one that had registered was removed, audited.
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
      const removed = yield* hub.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'environment.remove'
      `;
      assert.deepEqual(
        removed.map((row) => JSON.parse(row.detail)),
        [{ via: "ssh" }],
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels like a failure: the grant ends and a machine it registered is removed", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const confirmAndCancelAt = Effect.fn(function* (step: string) {
        const reached = yield* Deferred.make<void>();
        const machine = yield* makeTestMachine();
        // Holds the step until the cancel; at `service` the machine is registered already.
        const { handler } = healthyMachine(hub, {
          [step]: (request) =>
            written(request, "Working...\n", 0).pipe(
              Effect.andThen(Deferred.succeed(reached, undefined)),
              Effect.andThen(Effect.never),
            ),
        });
        machine.setHandler(handler);
        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        });
        const run = runOf(started.body);
        yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: machine.fingerprint },
        });
        yield* Deferred.await(reached);
        const cancelled = yield* hub.server.request("/api/environments/ssh/cancel", {
          cookie: hub.owner,
          body: { runId: run.runId },
        });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        return { run: yield* service.awaitFinished(run.runId), machine };
      });

      const atInstall = yield* confirmAndCancelAt("install");
      assert.equal(atInstall.run.state, "cancelled");
      assert.equal(atInstall.run.steps[1]?.state, "cancelled");
      assert.isNull(atInstall.run.environmentId);

      const atService = yield* confirmAndCancelAt("service");
      assert.equal(atService.run.state, "cancelled", JSON.stringify(atService.run));
      assert.isNull(atService.run.environmentId);
      assert.isTrue(atService.machine.steps.some((step) => step.step === "undo"));
      const grant = atService.machine.steps.find((step) => step.step === "register")?.stdin;
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
      // Its grant is spent with it.
      const late = yield* hub.server.request("/api/environments/join/grant", {
        body: {
          grant: grant?.trim(),
          credentialHash: yield* Effect.promise(() => sha256("late")),
          os: "linux",
          hostname: "vps-1",
        },
      });
      assert.equal(late.status, 401);

      // Waiting for its host key, a cancel just forgets it.
      const machine = yield* makeTestMachine();
      const waiting = runOf(
        (yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        })).body,
      );
      const cancelled = yield* hub.server.request("/api/environments/ssh/cancel", {
        cookie: hub.owner,
        body: { runId: waiting.runId },
      });
      assert.equal(runOf(cancelled.body).state, "cancelled");
      const confirmLate = yield* hub.server.request("/api/environments/ssh/confirm", {
        cookie: hub.owner,
        body: { runId: waiting.runId, fingerprint: machine.fingerprint },
      });
      assert.equal(confirmLate.status, 409);
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a host key other than the confirmed or stored one, without signing in", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      // Installed once: its host key is stored with it.
      const firstScope = yield* Scope.make();
      const first = yield* makeTestMachine().pipe(Scope.provide(firstScope));
      first.setHandler(healthyMachine(hub).handler);
      const installed = yield* installOver(hub, first, acme);
      assert.equal(installed.state, "succeeded", JSON.stringify(installed));
      const clientKey = { privateKey: first.privateKey };
      yield* Scope.close(firstScope, Exit.void);

      // The same address now shows another key: refused before any sign-in.
      const impostor = yield* makeTestMachine({ port: first.port, clientKey });
      const again = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(impostor, acme),
      });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      const refused = runOf(again.body);
      assert.equal(refused.state, "failed");
      assert.match(refused.error ?? "", /host key changed/u);
      assert.include(refused.error ?? "", first.fingerprint);
      assert.notInclude(impostor.authentications, "publickey");
      assert.deepEqual(impostor.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a machine it installed already, before signing in", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      machine.setHandler(healthyMachine(hub).handler);
      const installed = yield* installOver(hub, machine, acme);
      assert.equal(installed.state, "succeeded", JSON.stringify(installed));
      const signIns = machine.authentications.length;

      const again = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(machine, acme, { name: "Acme VPS 2" }),
      });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      const refused = runOf(again.body);
      assert.equal(refused.state, "failed", JSON.stringify(refused));
      assert.match(refused.error ?? "", /already installed as Acme VPS/u);
      assert.deepEqual(
        refused.steps.map((step) => step.state),
        ["cancelled", "cancelled", "cancelled", "cancelled"],
      );
      // Nothing signed in or ran there: the machine that is there stays as it is.
      assert.equal(machine.authentications.slice(signIns).includes("publickey"), false);
      assert.deepEqual(
        machine.steps.map((step) => step.step),
        ["check", "install", "register", "service"],
      );
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name.startsWith("Acme VPS")).map((e) => e.id),
        [installed.environmentId as string],
      );
    }).pipe(Effect.scoped),
  );

  it.live("never puts the key or passphrase in its spans, logs or the Hub's files", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const passphrase = "tracer horse battery";
      const machine = yield* makeTestMachine({ passphrase });
      // A machine that echoes them, and a step that fails: errors are recorded too.
      machine.setHandler(
        healthyMachine(hub, {
          check: (request) =>
            written(request, `${machine.privateKey}\npassphrase: ${passphrase}\n`, 0),
          service: (request) => written(request, `${passphrase}\n`, 3),
        }).handler,
      );
      const recorded: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            recorded.push(
              JSON.stringify({ name: span.name, attributes: [...span.attributes.entries()] }),
              Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
            );
          };
          const event = span.event.bind(span);
          span.event = (name, startTime, attributes) => {
            event(name, startTime, attributes);
            recorded.push(JSON.stringify({ event: name, attributes }));
          };
          return span;
        },
      });
      const logger = Logger.make((entry) => {
        recorded.push(JSON.stringify(entry.message), Cause.pretty(entry.cause));
      });
      const service = hub.service(SshInstall.SshInstall);
      const ownerId = yield* ownerIdOf(hub);
      const done = yield* Effect.gen(function* () {
        const started = yield* service.start(ownerId, decodeStartRequest(startBody(machine, acme)));
        yield* service.confirm(ownerId, {
          runId: started.runId,
          fingerprint: started.hostKey?.fingerprint ?? "",
        });
        return yield* service.awaitFinished(started.runId);
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      assert.equal(done.state, "failed", JSON.stringify(done));
      assert.isAbove(recorded.length, 10);
      const everything = [
        recorded.join("\n"),
        JSON.stringify(done),
        // Its database, logs and any file it wrote: nothing of the key was kept.
        ...filesUnder(hub.service(ServerConfig.ServerConfig).baseDir),
      ];
      for (const text of everything) {
        for (const fragment of keyFragments(machine.privateKey)) assert.notInclude(text, fragment);
        assert.notInclude(text, passphrase);
      }
    }).pipe(Effect.scoped),
  );

  it.live("never opens SSH to the Hub's own machine, unless set up for development", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: { ...POLICY, allowHubHost: false } });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      const own = Object.values(NodeOS.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .map((entry) => entry.address)
        .filter((address) => !address.startsWith("fe80"));
      for (const host of ["127.0.0.1", "localhost", "127.1.2.3", "::1", ...own]) {
        const refused = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme, { host }),
        });
        assert.equal(refused.status, 400, `${host}: ${JSON.stringify(refused.body)}`);
        assert.include(JSON.stringify(refused.body), "the Hub's own machine", host);
      }
      assert.deepEqual(machine.authentications, []);
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("signs in only to the key it confirmed, even if the machine changes it meanwhile", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const shownScope = yield* Scope.make();
      const shown = yield* makeTestMachine().pipe(Scope.provide(shownScope));
      const started = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(shown, acme),
      });
      const run = runOf(started.body);
      const clientKey = { privateKey: shown.privateKey };
      yield* Scope.close(shownScope, Exit.void);
      const swapped = yield* makeTestMachine({ port: shown.port, clientKey });
      yield* hub.server.request("/api/environments/ssh/confirm", {
        cookie: hub.owner,
        body: { runId: run.runId, fingerprint: shown.fingerprint },
      });
      const done = yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
      assert.equal(done.state, "failed");
      assert.match(done.error ?? "", /host key is not the one confirmed/u);
      assert.notInclude(swapped.authentications, "publickey");
      assert.deepEqual(swapped.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the key and passphrase out of its output, unless asked keeps them in the secret store",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine({ passphrase: "correct horse battery" });
        machine.setHandler(
          healthyMachine(hub, {
            // A machine that echoes them anyway.
            check: (request) =>
              written(request, `${machine.privateKey}\npassphrase: correct horse battery\n`, 0),
          }).handler,
        );
        const done = yield* installOver(hub, machine, acme, { keepForUpdates: true });
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        assert.isTrue(done.keyKept);
        const shown = JSON.stringify(done);
        for (const fragment of keyFragments(machine.privateKey)) assert.notInclude(shown, fragment);
        assert.notInclude(shown, "correct horse battery");
        assert.include(done.steps[0]?.output ?? [], "passphrase: [redacted]");

        const environmentId = done.environmentId as EnvironmentId;
        const secrets = hub.service(ServerSecretStore.ServerSecretStore);
        const kept = yield* secrets.get(SshInstall.keptKeySecretName(environmentId));
        assert.isTrue(Option.isSome(kept));
        assert.include(new TextDecoder().decode(Option.getOrThrow(kept)), "correct horse battery");

        // Removing the machine forgets its key and its host record.
        const forgotten = yield* hub.service(SshInstall.SshInstall).forgotten;
        const removed = yield* hub.server.request("/api/environments/remove", {
          cookie: hub.owner,
          body: { environmentId },
        });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        const keptFile = NodePath.join(
          hub.service(ServerConfig.ServerConfig).secretsDir,
          `${SshInstall.keptKeySecretName(environmentId)}.bin`,
        );
        assert.equal(yield* PubSub.take(forgotten), environmentId);
        assert.isFalse(NodeFS.existsSync(keptFile));
        const hosts = yield* hub.server.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM environment_ssh_hosts
        `;
        assert.equal(hosts[0]?.count, 0);
      }).pipe(Effect.scoped),
  );

  it.live("refuses a second run to the same machine, and addresses it never opens", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      const first = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(machine, acme),
      });
      assert.equal(first.status, 200);
      for (const host of ["127.0.0.1", "localhost"]) {
        const second = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme, { host }),
        });
        assert.equal(second.status, 409, `${host}: ${JSON.stringify(second.body)}`);
      }
      const refusals: ReadonlyArray<Record<string, unknown>> = [
        { host: "169.254.169.254" },
        { host: "-oProxyCommand=touch /tmp/x" },
        { username: "root" },
        { username: "-oProxyCommand=x" },
        { hubUrl: "http://hub.example.com" },
        { auth: { kind: "key", privateKey: "not a key" } },
        // The Hub's process has no SSH agent here (its policy says so).
        { auth: { kind: "agent" } },
        { spaceId: "no-such-space" },
        // Refused by the schema itself: the answer must not echo the key either.
        { port: 0 },
        { port: "22; touch /tmp/x" },
      ];
      for (const overrides of refusals) {
        const refused = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme, overrides),
        });
        assert.equal(
          refused.status,
          400,
          `${JSON.stringify(overrides)}: ${JSON.stringify(refused.body)}`,
        );
        for (const fragment of keyFragments(machine.privateKey)) {
          assert.notInclude(JSON.stringify(refused.body), fragment);
        }
      }
      // A grant only crosses HTTPS or this machine's loopback.
      const remote = yield* hub.server.request("/api/environments/join/grant", {
        peer: "203.0.113.9",
        body: { grant: "x".repeat(43), credentialHash: "y".repeat(43), os: "linux", hostname: "h" },
      });
      assert.equal(remote.status, 400);
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("releases a run whose start stops before the host key is shown", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const ownerId = yield* ownerIdOf(hub);
      // A port that takes the connection and never says anything.
      const sockets = new Set<NodeNet.Socket>();
      const connected = yield* Deferred.make<void>();
      const silent = NodeNet.createServer((socket) => {
        sockets.add(socket);
        Deferred.doneUnsafe(connected, Effect.void);
      });
      yield* Effect.callback<void>((resume) => {
        silent.listen(0, "127.0.0.1", () => resume(Effect.void));
      });
      const port = (silent.address() as NodeNet.AddressInfo).port;
      const machine = yield* makeTestMachine();
      const request = decodeStartRequest({ ...startBody(machine, acme), port });
      const starting = yield* service.start(ownerId, request).pipe(Effect.forkChild);
      // The Hub is waiting for its host key there.
      yield* Deferred.await(connected);
      yield* Fiber.interrupt(starting);
      yield* Effect.callback<void>((resume) => {
        silent.close(() => resume(Effect.void));
        for (const socket of sockets) socket.destroy();
      });
      // Nothing holds that address: the next run is not refused as under way.
      const again = yield* service.start(ownerId, request).pipe(Effect.result);
      assert.equal(again._tag, "Success", JSON.stringify(again));
      if (again._tag === "Success") assert.equal(again.success.state, "failed");
    }).pipe(Effect.scoped),
  );

  it.live("cancels a run confirmed a moment before, and ends it only once", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const ownerId = yield* ownerIdOf(hub);
      for (const concurrently of [false, true]) {
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub).handler);
        const started = yield* service.start(ownerId, decodeStartRequest(startBody(machine, acme)));
        const confirm = service.confirm(ownerId, {
          runId: started.runId,
          fingerprint: started.hostKey?.fingerprint ?? "",
        });
        const cancel = service.cancel(ownerId, started.runId);
        if (concurrently) {
          yield* Effect.all([Effect.result(confirm), cancel], { concurrency: "unbounded" });
        } else {
          yield* confirm;
          yield* cancel;
        }
        const done = yield* service.awaitFinished(started.runId);
        assert.equal(done.state, "cancelled", JSON.stringify(done));
        assert.equal(done.error, "Cancelled by the Owner.");
        assert.isNull(done.environmentId);
        assert.notInclude(
          machine.steps.map((step) => step.step),
          "register",
        );
        // Later answers do not change how it ended.
        yield* service.cancel(ownerId, started.runId);
        const after = yield* service.status(ownerId, started.runId);
        assert.equal(after.state, "cancelled");
        assert.equal(after.finishedAt, done.finishedAt);
      }
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.live("forgets a host key not confirmed in time, with every step not run", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: { ...POLICY, hostKeyTtlMs: 200 } });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const machine = yield* makeTestMachine();
      const started = yield* service.start(
        yield* ownerIdOf(hub),
        decodeStartRequest(startBody(machine, acme)),
      );
      const done = yield* service.awaitFinished(started.runId);
      assert.equal(done.state, "cancelled");
      assert.match(done.error ?? "", /not confirmed in time/u);
      assert.deepEqual(
        done.steps.map((step) => step.state),
        ["cancelled", "cancelled", "cancelled", "cancelled"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("stops a step that takes too long on the machine too", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({
        sshInstallPolicy: { ...POLICY, stepTimeoutMs: { ...POLICY.stepTimeoutMs, install: 400 } },
      });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      machine.setHandler(healthyMachine(hub, { install: () => Effect.never }).handler);
      const done = yield* installOver(hub, machine, acme);
      assert.equal(done.state, "failed", JSON.stringify(done));
      assert.match(done.error ?? "", /took too long/u);
      // The step runs in a process group of its own there, which the Hub stops.
      assert.include(machine.steps[1]?.script ?? "", "setsid");
      assert.deepEqual(
        machine.steps.map((step) => step.step),
        ["check", "install", "stop"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("scrubs a line before it cuts it, so no piece of the key is left at the cut", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      const keyLine = keyFragments(machine.privateKey)[0]!;
      machine.setHandler(
        healthyMachine(hub, {
          check: (request) => written(request, `${"y".repeat(1985)}${keyLine}\n`, 0),
        }).handler,
      );
      const done = yield* installOver(hub, machine, acme);
      assert.equal(done.state, "succeeded", JSON.stringify(done));
      const shown = JSON.stringify(done);
      assert.notInclude(shown, keyLine.slice(0, 15));
    }).pipe(Effect.scoped),
  );

  it.live("cancelled between two steps, undoes on the machine what it registered there", () =>
    Effect.gen(function* () {
      const between = yield* Deferred.make<void>();
      const hub = yield* makeHub({
        sshInstallPolicy: {
          ...POLICY,
          // Holds the run just after `register` succeeded, before `service` begins.
          afterStep: (_runId, step) =>
            step === "register"
              ? Deferred.succeed(between, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        },
      });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const ownerId = yield* ownerIdOf(hub);
      const machine = yield* makeTestMachine();
      machine.setHandler(healthyMachine(hub).handler);
      const started = yield* service.start(ownerId, decodeStartRequest(startBody(machine, acme)));
      yield* service.confirm(ownerId, {
        runId: started.runId,
        fingerprint: started.hostKey?.fingerprint ?? "",
      });
      yield* Deferred.await(between);
      yield* service.cancel(ownerId, started.runId);
      const done = yield* service.awaitFinished(started.runId);
      assert.equal(done.state, "cancelled", JSON.stringify(done));
      assert.deepEqual(
        done.steps.map((step) => step.state),
        ["succeeded", "succeeded", "succeeded", "cancelled"],
      );
      // The machine left the Hub on its side too, and the Owner is told what stays there.
      assert.include(
        machine.steps.map((step) => step.step),
        "undo",
      );
      const output = done.steps[3]?.output ?? [];
      assert.include(output, "The Hub removed the machine it had registered.");
      assert.isTrue(output.some((line) => line.startsWith("Left on the machine:")));
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.live("takes a step as busy only from the wrapper's own refusal, which leaves nothing", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const cases = [
        {
          // What only the step wrapper prints when another step holds the machine.
          text: `Another installation is still running on this machine (${STEP_BUSY_MARKER}).\n`,
          error: /Another installation is still running/u,
          leftover: false,
        },
        // The install itself exiting 75 is a failed install like any other.
        {
          text: "curl: something\n",
          error: /Install T3 Code failed \(exit code 75\)/u,
          leftover: true,
        },
      ];
      for (const testCase of cases) {
        const machine = yield* makeTestMachine();
        machine.setHandler(
          healthyMachine(hub, { install: (request) => written(request, testCase.text, 75) })
            .handler,
        );
        const done = yield* installOver(hub, machine, acme);
        assert.equal(done.state, "failed");
        assert.match(done.error ?? "", testCase.error);
        assert.equal(
          (done.steps[1]?.output ?? []).some((line) => line.startsWith("Left on the machine:")),
          testCase.leftover,
          JSON.stringify(done.steps[1]),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(process.getuid?.() === 0)(
    "tells the Owner when a removed machine's kept key could not be deleted",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub).handler);
        const done = yield* installOver(hub, machine, acme, { keepForUpdates: true });
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        // Its kept key cannot be deleted now.
        const secretsDir = hub.service(ServerConfig.ServerConfig).secretsDir;
        NodeFS.chmodSync(secretsDir, 0o500);
        const removed = yield* hub.server
          .request("/api/environments/remove", {
            cookie: hub.owner,
            body: { environmentId: done.environmentId },
          })
          .pipe(Effect.ensuring(Effect.sync(() => NodeFS.chmodSync(secretsDir, 0o700))));
        assert.equal(removed.status, 409, JSON.stringify(removed.body));
        assert.include(JSON.stringify(removed.body), "could not delete its kept SSH key");
        // The machine itself is removed all the same.
        const listed = yield* listEnvironments(hub.server, hub.owner);
        assert.deepEqual(
          listed.filter((environment) => environment.name === "Acme VPS"),
          [],
        );
      }).pipe(Effect.scoped),
  );
});
