// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import {
  CommandId,
  sandboxEnvironmentIdOf,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PodmanSandboxRuntime from "../sandboxes/PodmanSandboxRuntime.ts";
import {
  ensureDevImage,
  makeTestRun,
  podmanResult,
  removeTestRunContainers,
  rootlessPodmanAvailable,
} from "../sandboxes/PodmanSandboxRuntime.testkit.ts";
import { devCodeMounts } from "../sandboxes/sandboxRuntimeFromConfig.ts";
import * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import {
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  git,
  awaitUploaded,
  readText,
  checkoutOn,
  exists,
  startSandbox,
  createOrganization,
} from "./HubWithEnvironments.scenarios.testkit.ts";

describe("Hub con Environments: checkouts from the Hub repository", () => {
  /** Where the Hub keeps the Project's branches that machines clone. */
  const BRANCHES = "refs/t3/project/heads/";
  const commitAs = ["-c", "user.email=hub@example.com", "-c", "user.name=Hub", "commit", "-q"];
  const refsIn = (repository: string, prefix: string) =>
    git(repository, ["--git-dir", repository, "for-each-ref", "--format=%(refname)", prefix]).pipe(
      Effect.map((output) => output.stdout.split("\n").filter((line) => line.length > 0)),
    );
  const bareRevOf = (repository: string, rev: string) =>
    git(repository, ["--git-dir", repository, "rev-parse", "--verify", "--quiet", rev]).pipe(
      Effect.map((output) => output.stdout.trim()),
    );
  const revOf = (cwd: string, rev: string) =>
    git(cwd, ["rev-parse", "--verify", "--quiet", rev]).pipe(
      Effect.map((output) => output.stdout.trim()),
    );
  /** The Project's repository on the Hub, as a machine with `credential` reaches it. */
  const repositoryAs = (
    hub: Hub,
    credential: string,
    key: HubRepository.HubRepositoryKey,
    cwd: string,
  ) => {
    const remote = HubRepository.withEnvironmentCredential(
      HubRepository.hubRepositoryUrl(hub.server.url, key),
      credential,
    );
    return {
      git: (...args: ReadonlyArray<string>) =>
        git(cwd, [args[0]!, remote.url, ...args.slice(1)], { env: remote.env ?? {} }),
      /** As a new checkout asks, with the header that has the Hub bring its branches in first. */
      checkout: (...args: ReadonlyArray<string>) =>
        git(
          cwd,
          ["-c", "http.extraHeader=X-T3-Checkout: 1", args[0]!, remote.url, ...args.slice(1)],
          { env: remote.env ?? {} },
        ),
      advertised: HttpClient.HttpClient.pipe(
        Effect.flatMap((client) =>
          client.execute(
            HttpClientRequest.get(`${remote.url}/info/refs?service=git-upload-pack`).pipe(
              HttpClientRequest.bearerToken(credential),
            ),
          ),
        ),
        Effect.map((response) => response.status),
        Effect.provide(FetchHttpClient.layer),
        Effect.orDie,
      ),
    };
  };

  it.live(
    "a machine without the checkout clones it from the Hub: its HEAD, `origin`'s tracking refs",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
        const desktop = yield* hub.join({
          name: "Desktop",
          adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
        });
        let hubCheckout = "";
        const result = yield* replayOn(hub, laptop, loaded, {
          afterSeed: (root) =>
            Effect.gen(function* () {
              hubCheckout = root;
              // A private remote: no machine has its credentials, and the Hub's URL holds a token.
              yield* git(root, [
                "remote",
                "set-url",
                "origin",
                "https://t3:s3cret-token@git.example.invalid/acme/web.git",
              ]);
              // What the Hub last fetched of it: `main` one commit behind the Hub's. `main` has
              // no upstream; `feature/login` tracks its own.
              yield* git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
              yield* git(root, ["branch", "feature/login"]);
              yield* git(root, ["update-ref", "refs/remotes/origin/feature/login", "HEAD"]);
              yield* git(root, ["config", "branch.feature/login.remote", "origin"]);
              yield* git(root, [
                "config",
                "branch.feature/login.merge",
                "refs/heads/feature/login",
              ]);
              yield* git(root, [...commitAs, "--allow-empty", "-m", "Main moves on"]);
            }),
        });
        loaded.variant.assertOutput(result, loaded.transcript);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        const projectId = result.projections.get(threadId)!.thread.projectId;
        const checkout = yield* checkoutOn(hub, laptop, projectId);

        // The Hub's branches and the one it is on; `origin` is the Project's remote without the
        // Hub's password, with its tracking refs and the branch's upstream.
        assert.equal(yield* revOf(checkout, "refs/heads/main"), yield* revOf(hubCheckout, "main"));
        assert.equal(
          yield* revOf(checkout, "refs/heads/feature/login"),
          yield* revOf(hubCheckout, "feature/login"),
        );
        assert.equal(
          (yield* git(checkout, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
          "main",
        );
        assert.equal(
          (yield* git(checkout, ["remote", "get-url", "origin"])).stdout.trim(),
          "https://t3@git.example.invalid/acme/web.git",
        );
        assert.equal(
          yield* revOf(checkout, "refs/remotes/origin/main"),
          yield* revOf(hubCheckout, "refs/remotes/origin/main"),
        );
        // Each branch tracks what it tracks on the Hub, and nothing else.
        assert.notEqual(
          (yield* git(checkout, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).exitCode,
          0,
        );
        assert.equal(
          (yield* git(checkout, [
            "rev-parse",
            "--abbrev-ref",
            "feature/login@{upstream}",
          ])).stdout.trim(),
          "origin/feature/login",
        );
        const config = yield* readText(`${checkout}/.git/config`);
        assert.notInclude(config, "s3cret");
        assert.notInclude(config, "/api/git/");
        assert.deepEqual(yield* refsIn(`${checkout}/.git`, "refs/t3/checkout/"), []);
        assert.equal((yield* readText(`${checkout}/README.md`)).trim(), "# Remote project");

        // The Hub keeps them under a namespace of its own; nothing of the Thread's is a branch.
        const repository = yield* hub
          .service(HubRepository.HubRepositories)
          .ensure({ projectId })
          .pipe(Effect.orDie);
        assert.includeMembers(yield* refsIn(repository, "refs/t3/project/"), [
          `${BRANCHES}main`,
          `${BRANCHES}feature/login`,
          "refs/t3/project/remotes/origin/main",
        ]);
        assert.deepEqual(yield* refsIn(repository, "refs/heads/"), []);
        const mirroredMain = yield* bareRevOf(repository, `${BRANCHES}main`);

        // A machine's own branches never reach the Hub, its uploads included.
        yield* awaitUploaded(hub, threadId, 1);
        yield* git(checkout, [...commitAs, "--allow-empty", "-m", "Laptop work"]);
        yield* git(checkout, ["branch", "laptop/spike"]);
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        const ready = projection.checkpoints.find((checkpoint) => checkpoint.status === "ready");
        assert.isDefined(ready);
        const executorOf = (environment: TestEnvironment) =>
          hub
            .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
            .get(environment.environmentId)
            .pipe(Effect.orDie);
        yield* (yield* executorOf(laptop)).workspace.hubRepository
          .push({ cwd: checkout, projectId, checkpointRefs: [ready.ref] })
          .pipe(Effect.orDie);
        assert.notInclude(yield* refsIn(repository, "refs/t3/project/"), `${BRANCHES}laptop/spike`);
        assert.equal(yield* bareRevOf(repository, `${BRANCHES}main`), mirroredMain);

        // The Hub's checkout is rebased and drops a branch. A routine fetch mirrors nothing...
        yield* git(hubCheckout, [...commitAs, "--amend", "--allow-empty", "-m", "Main rewritten"]);
        yield* git(hubCheckout, ["branch", "-D", "feature/login"]);
        const laptopRemote = repositoryAs(hub, laptop.credential, { projectId }, checkout);
        assert.equal((yield* laptopRemote.git("ls-remote")).exitCode, 0);
        assert.equal(yield* bareRevOf(repository, `${BRANCHES}main`), mirroredMain);
        // ...a new checkout gets the Hub's as they are now.
        const fetched = yield* (yield* executorOf(desktop)).workspace.move
          .fetch({ projectId, refs: [] })
          .pipe(Effect.orDie);
        assert.equal(
          yield* revOf(fetched.checkout, "refs/heads/main"),
          yield* revOf(hubCheckout, "main"),
        );
        assert.equal(yield* revOf(fetched.checkout, "refs/heads/feature/login"), "");
        assert.equal(yield* revOf(fetched.checkout, "refs/heads/laptop/spike"), "");
        assert.notInclude(
          yield* refsIn(repository, "refs/t3/project/"),
          `${BRANCHES}feature/login`,
        );
        // Nothing of the Hub's was written into its own checkout of the Project.
        assert.deepEqual(yield* refsIn(`${hubCheckout}/.git`, "refs/t3/"), []);
      }).pipe(Effect.scoped),
  );

  it.live("a Sandbox Thread works on a Project whose `origin` is a path on the Hub", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub({ sandboxAdapters: loaded.adapters });
      const acme = yield* createOrganization(hub, "Acme");
      const created = loaded.materialized.commands.find(
        (command) => command.type === "thread.create",
      );
      assert.isDefined(created);
      yield* seedProject(hub.server, {
        projectId: created.projectId,
        title: "Acme web",
        defaultModelSelection: loaded.variant.modelSelection,
        spaceId: acme,
      });
      yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
        userId: yield* ownerIdOf(hub),
        requested: sandboxEnvironmentIdOf(acme),
        projectId: created.projectId,
        providerInstanceId: loaded.variant.modelSelection.instanceId,
      });
      yield* startSandbox(hub, acme);
      const sandbox = yield* hub.sandboxOf(acme);
      // A folder only the Hub's disk has: the process runtime shares the disk, so it is one that
      // the Sandbox cannot open, as in a container.
      const hubOnly = `/nonexistent-hub-disk/projects/acme-web`;
      const result = yield* replayOn(hub, sandbox, loaded, {
        spaceId: acme,
        afterSeed: (root) =>
          git(root, ["remote", "set-url", "origin", hubOnly]).pipe(Effect.asVoid),
      });
      loaded.variant.assertOutput(result, loaded.transcript);
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      const checkout = yield* checkoutOn(hub, sandbox, created.projectId);
      assert.isTrue(checkout.startsWith(`${hub.sandboxRoot}/sandbox-${acme}/`), checkout);
      assert.equal((yield* git(checkout, ["remote", "get-url", "origin"])).stdout.trim(), hubOnly);
      assert.equal((yield* readText(`${checkout}/README.md`)).trim(), "# Remote project");
      yield* awaitUploaded(hub, threadId, 1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "every machine that may work in the Project reads its branches; no other, and no Thread's refs",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada",
          spaceId: acme,
          role: "admin",
        });
        const grace = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Grace Hopper",
          spaceId: acme,
        });
        const linus = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Linus",
          spaceId: acme,
        });
        const machineOf = (user: typeof grace, name: string) =>
          hub.join({
            as: { cookie: user.cookie, authenticator: user.authenticator },
            name,
            adapters: idleAdapters(instanceId),
          });
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const adas = yield* machineOf(ada, "Ada's machine");
        const graces = yield* machineOf(grace, "Grace's machine");
        const linuses = yield* machineOf(linus, "Linus's machine");
        // Linus is a Guest of Acme once his machine is his.
        yield* hub.server.sql`
          UPDATE space_memberships SET role = 'guest'
          WHERE space_id = ${acme} AND user_id = ${linus.userId}
        `;
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const projectId = ProjectId.make("project:acme");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const globexProject = ProjectId.make("project:globex");
        yield* seedProject(hub.server, {
          projectId: globexProject,
          title: "Globex",
          defaultModelSelection: null,
          spaceId: globex,
        });
        yield* startSandbox(hub, acme);
        yield* startSandbox(hub, globex);
        const acmeSandbox = yield* hub.sandboxOf(acme);
        const globexSandbox = yield* hub.sandboxOf(globex);

        // A Thread of the Owner's on the Laptop, with refs in the Hub repository.
        const threadId = ThreadId.make("thread:on-laptop");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:thread-on-laptop"),
          threadId,
          projectId,
          title: "On the Laptop",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: laptop.environmentId,
        });
        const headRef = `${HubRepository.threadRefPrefixes(threadId)[0]}head`;
        yield* git(workspaceRoot, ["update-ref", headRef, "HEAD"]);
        const on = (machine: { readonly credential: string }, key = { projectId }) =>
          repositoryAs(hub, machine.credential, key, workspaceRoot);
        const succeeded = (output: { readonly exitCode: number; readonly stderr: string }) =>
          assert.equal(output.exitCode, 0, output.stderr);
        succeeded(yield* on(laptop).git("push", `+${headRef}:${headRef}`));

        // Owner, Admin, Member and the Space's Sandbox read the Project's branches, and only
        // those: the Thread's refs stay its machine's. So does a Guest's own machine: a Guest
        // starts Threads in the Space (spec 1), and runs them on that machine alone.
        const main = (yield* git(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
        for (const machine of [adas, graces, linuses, acmeSandbox]) {
          // As a new checkout asks: the Hub brings its checkout's branches in first.
          const listed = yield* on(machine).checkout("ls-remote");
          succeeded(listed);
          const refs = listed.stdout.trim().split("\n");
          assert.include(refs, `${main}\t${BRANCHES}main`);
          for (const line of refs) assert.match(line, /\trefs\/t3\/project\//u);
        }
        assert.include((yield* on(laptop).git("ls-remote")).stdout, `${BRANCHES}main`);
        assert.include((yield* on(laptop).git("ls-remote")).stdout, headRef);

        // Only the Hub writes them: no machine creates, moves, rewrites or deletes one.
        const fresh = `${workspaceRoot}-graces`;
        yield* git(workspaceRoot, ["clone", "-q", workspaceRoot, fresh]);
        yield* git(fresh, [...commitAs, "--allow-empty", "-m", "Grace's work"]);
        const fromFresh = (machine: { readonly credential: string }) =>
          repositoryAs(hub, machine.credential, { projectId }, fresh);
        for (const machine of [laptop, adas, graces, linuses, acmeSandbox]) {
          for (const refspec of [
            `HEAD:${BRANCHES}work`,
            `HEAD:${BRANCHES}main`,
            `+HEAD:${BRANCHES}main`,
            `:${BRANCHES}main`,
            "HEAD:refs/t3/project/remotes/origin/main",
            "HEAD:refs/t3/project/tags/v1",
          ]) {
            assert.notEqual((yield* fromFresh(machine).git("push", refspec)).exitCode, 0, refspec);
          }
        }
        // Still the Hub's copy, unchanged.
        assert.deepEqual((yield* on(acmeSandbox).git("ls-remote")).stdout.trim().split("\n"), [
          `${main}	refs/t3/project/checkout/HEAD`,
          `${main}	${BRANCHES}main`,
        ]);
        assert.notEqual((yield* fromFresh(acmeSandbox).git("push", `HEAD:${headRef}`)).exitCode, 0);

        // The Sandbox of another Space neither reads nor writes them.
        assert.equal(yield* on(globexSandbox).advertised, 403);
        assert.notEqual(
          (yield* fromFresh(globexSandbox).git("push", `HEAD:${BRANCHES}elsewhere`)).exitCode,
          0,
        );
        // Nor a Member's or a Guest's machine those of a Space they are not in.
        for (const machine of [graces, linuses]) {
          assert.equal(yield* on(machine, { projectId: globexProject }).advertised, 403);
        }
        // A Guest's machine no longer reads them once the Guest left the Space.
        yield* hub.server.sql`
          DELETE FROM space_memberships WHERE space_id = ${acme} AND user_id = ${linus.userId}
        `;
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        assert.equal(yield* on(linuses).advertised, 403);
        assert.equal(yield* on(globexSandbox, { projectId: globexProject }).advertised, 200);
      }).pipe(Effect.scoped),
  );

  it.live("with no branches on the Hub, a machine clones the Project's own remote", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:fresh");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Fresh",
        defaultModelSelection: null,
      });
      // The Project's remote has the history; the Hub's checkout has no branch yet.
      const remote = `${workspaceRoot}-remote.git`;
      yield* git(workspaceRoot, ["clone", "-q", "--bare", workspaceRoot, remote]);
      yield* git(workspaceRoot, ["remote", "set-url", "origin", remote]);
      yield* git(workspaceRoot, ["checkout", "-q", "--orphan", "unborn"]);
      yield* git(workspaceRoot, ["branch", "-D", "main"]);
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      const fetched = yield* executor.workspace.move
        .fetch({ projectId, refs: [] })
        .pipe(Effect.orDie);
      assert.equal(
        yield* revOf(fetched.checkout, "refs/remotes/origin/main"),
        yield* bareRevOf(remote, "refs/heads/main"),
      );
      assert.equal(
        (yield* git(fetched.checkout, ["remote", "get-url", "origin"])).stdout.trim(),
        remote,
      );
    }).pipe(Effect.scoped),
  );

  it.live("a root today's rule does not trust gives no branches: the machine clones `origin`", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
      const projectId = ProjectId.make("project:graces-folder");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Grace's folder",
        defaultModelSelection: null,
      });
      // Recorded by a Member outside the Hub's Projects folder, as before today's rule.
      yield* hub.server.sql`
        UPDATE projection_projects SET owner_user_id = 'member-1' WHERE project_id = ${projectId}
      `;
      const repository = yield* hub
        .service(HubRepository.HubRepositories)
        .ensure({ projectId })
        .pipe(Effect.orDie);
      const listed = yield* repositoryAs(
        hub,
        laptop.credential,
        { projectId },
        workspaceRoot,
      ).checkout("ls-remote");
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.notInclude(listed.stdout, "refs/t3/project/");
      assert.deepEqual(yield* refsIn(repository, "refs/t3/project/"), []);
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      const fetched = yield* executor.workspace.move
        .fetch({ projectId, refs: [] })
        .pipe(Effect.orDie);
      // Cloned from the Project's own remote (here the folder itself), as before.
      assert.equal(
        yield* revOf(fetched.checkout, "refs/remotes/origin/main"),
        yield* revOf(workspaceRoot, "main"),
      );
      assert.deepEqual(yield* refsIn(repository, "refs/t3/project/"), []);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Hub that cannot serve the checkout fails the clone, never falling back to `origin`",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const projectId = ProjectId.make("project:broken");
        yield* seedProject(hub.server, {
          projectId,
          title: "Broken",
          defaultModelSelection: null,
        });
        // The Hub's repository of the Project is unreadable; its `origin` (the folder) is not.
        const repository = yield* hub
          .service(HubRepository.HubRepositories)
          .ensure({ projectId })
          .pipe(Effect.orDie);
        yield* Effect.promise(() => NodeFSP.writeFile(`${repository}/HEAD`, "not a ref\n"));
        yield* Effect.promise(() => NodeFSP.rm(`${repository}/objects`, { recursive: true }));
        const executor = yield* hub
          .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
          .get(laptop.environmentId)
          .pipe(Effect.orDie);
        const failed = yield* executor.workspace.move
          .fetch({ projectId, refs: [] })
          .pipe(Effect.flip);
        assert.include(failed.message, "from the Hub");
        const checkout = yield* checkoutOn(hub, laptop, projectId);
        assert.isFalse(yield* exists(checkout));
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Project in a folder of its repository is cloned whole, its folder where it works",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const projectId = ProjectId.make("project:web");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Web",
          defaultModelSelection: null,
          subfolder: "packages/web",
        });
        const top = workspaceRoot.slice(0, -"/packages/web".length);
        const executor = yield* hub
          .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
          .get(laptop.environmentId)
          .pipe(Effect.orDie);
        const fetched = yield* executor.workspace.move
          .fetch({ projectId, refs: [] })
          .pipe(Effect.orDie);
        // The checkout is the Project's folder, inside the whole repository made from the Hub.
        assert.isTrue(fetched.checkout.endsWith("/packages/web"), fetched.checkout);
        assert.equal((yield* readText(`${fetched.checkout}/README.md`)).trim(), "# Subfolder");
        assert.equal(
          (yield* git(fetched.checkout, ["rev-parse", "--show-toplevel"])).stdout.trim(),
          fetched.checkout.slice(0, -"/packages/web".length),
        );
        assert.equal(yield* revOf(fetched.checkout, "refs/heads/main"), yield* revOf(top, "main"));
        const repository = yield* hub
          .service(HubRepository.HubRepositories)
          .ensure({ projectId })
          .pipe(Effect.orDie);
        assert.include(yield* refsIn(repository, "refs/t3/project/"), `${BRANCHES}main`);
      }).pipe(Effect.scoped),
  );

  it.live("a repository that holds another Project, of another Space, is never copied", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      // One monorepo of the Owner's: `packages/web` is Acme's Project, `packages/billing` Globex's.
      const web = ProjectId.make("project:web");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId: web,
        title: "Web",
        defaultModelSelection: null,
        spaceId: acme,
        subfolder: "packages/web",
      });
      const top = workspaceRoot.slice(0, -"/packages/web".length);
      yield* Effect.promise(() => NodeFSP.mkdir(`${top}/packages/billing`, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(`${top}/packages/billing/SECRET.md`, "Globex billing\n"),
      );
      yield* git(top, ["add", "."]);
      yield* git(top, [...commitAs, "-m", "Billing"]);
      yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:billing"),
        title: "Billing",
        defaultModelSelection: null,
        spaceId: globex,
        workspaceRoot: `${top}/packages/billing`,
      });
      const repository = yield* hub
        .service(HubRepository.HubRepositories)
        .ensure({ projectId: web })
        .pipe(Effect.orDie);
      // As a new checkout asks: nothing of the monorepo is copied for Acme's machines.
      const listed = yield* repositoryAs(hub, laptop.credential, { projectId: web }, top).checkout(
        "ls-remote",
      );
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.notInclude(listed.stdout, "refs/t3/project/");
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      yield* executor.workspace.move.fetch({ projectId: web, refs: [] }).pipe(Effect.orDie);
      assert.deepEqual(yield* refsIn(repository, "refs/t3/project/"), []);
    }).pipe(Effect.scoped),
  );

  it.live("a Hub whose checkout git cannot read, or that is gone, opens sessions as before", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:unreadable");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Unreadable",
        defaultModelSelection: null,
      });
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      const fetchOnLaptop = executor.workspace.move.fetch({ projectId, refs: [] });
      // The Laptop has its checkout; then the Hub's git fails there (exit 128)...
      yield* fetchOnLaptop.pipe(Effect.orDie);
      yield* Effect.promise(() => NodeFSP.writeFile(`${workspaceRoot}/.git/HEAD`, "not a ref\n"));
      assert.equal((yield* git(workspaceRoot, ["rev-parse", "HEAD"])).exitCode, 128);
      yield* fetchOnLaptop.pipe(Effect.orDie);
      // ...or the Hub's checkout is gone altogether: git cannot even start there.
      yield* Effect.promise(() => NodeFSP.rm(workspaceRoot, { recursive: true, force: true }));
      yield* fetchOnLaptop.pipe(Effect.orDie);
    }).pipe(Effect.scoped),
  );

  it.live("a Hub checkout on a detached HEAD gives new checkouts that commit, detached", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:detached");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Detached",
        defaultModelSelection: null,
      });
      yield* git(workspaceRoot, ["checkout", "-q", "--detach"]);
      yield* git(workspaceRoot, [...commitAs, "--allow-empty", "-m", "On no branch"]);
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      const fetched = yield* executor.workspace.move
        .fetch({ projectId, refs: [] })
        .pipe(Effect.orDie);
      assert.equal(yield* revOf(fetched.checkout, "HEAD"), yield* revOf(workspaceRoot, "HEAD"));
      assert.notEqual((yield* git(fetched.checkout, ["symbolic-ref", "-q", "HEAD"])).exitCode, 0);
      assert.equal(
        yield* revOf(fetched.checkout, "refs/heads/main"),
        yield* revOf(workspaceRoot, "main"),
      );
    }).pipe(Effect.scoped),
  );

  describe.skipIf(!rootlessPodmanAvailable)("in Podman", () => {
    const run = makeTestRun();
    let image = "";
    beforeAll(() => {
      image = ensureDevImage();
    });
    afterAll(() => removeTestRunContainers(run));

    it.live("a Podman Sandbox clones a Project whose `origin` is a Hub path from the Hub", () =>
      Effect.gen(function* () {
        const entry = new URL("../bin.ts", import.meta.url).pathname;
        const checkout = new URL("../../../../", import.meta.url).pathname.replace(/\/$/u, "");
        const hub = yield* makeHub({
          sandboxRuntime: (rootDir) =>
            PodmanSandboxRuntime.layer({
              image,
              serverCommand: ["node", entry],
              codeMounts: devCodeMounts(checkout),
              rootDir,
              namePrefix: run.namePrefix,
              labels: run.labels,
            }),
        });
        const acme = yield* createOrganization(hub, "Acme");
        const projectId = ProjectId.make("project:acme");
        // Its `origin` is the Hub's own folder, which no container sees.
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* git(workspaceRoot, ["branch", "feature/login"]);
        yield* hub
          .service(EnvironmentRegistry.EnvironmentRegistry)
          .chooseForThread({
            userId: yield* ownerIdOf(hub),
            requested: sandboxEnvironmentIdOf(acme),
            projectId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          })
          .pipe(Effect.ignore);
        yield* startSandbox(hub, acme);
        const executor = yield* hub
          .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
          .get(sandboxEnvironmentIdOf(acme))
          .pipe(Effect.orDie);
        // A Thread arriving there makes the checkout, as a session's open does.
        const fetched = yield* executor.workspace.move
          .fetch({ projectId, refs: [] })
          .pipe(Effect.orDie);
        const container = `${run.namePrefix}${SandboxRuntime.sandboxIdOf(acme)}`;
        const inContainer = (...args: ReadonlyArray<string>) =>
          podmanResult(["exec", container, "git", "-C", fetched.checkout, ...args]);
        const head = inContainer("rev-parse", "HEAD", "feature/login");
        assert.equal(head.exitCode, 0, head.stderr);
        const main = (yield* git(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
        assert.equal(head.stdout.trim(), `${main}\n${main}`);
        const origin = inContainer("remote", "get-url", "origin");
        assert.equal(origin.stdout.trim(), workspaceRoot);
        // The Hub's URL and credential stay out of the checkout's config.
        const config = inContainer("config", "--local", "--list").stdout;
        assert.notInclude(config, "/api/git/");
        assert.notInclude(config, "credential");
      }).pipe(Effect.scoped),
    );
  });
});
