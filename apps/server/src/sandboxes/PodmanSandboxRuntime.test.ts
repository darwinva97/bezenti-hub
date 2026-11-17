// @effect-diagnostics nodeBuiltinImport:off -- a stand-in Hub on loopback and checks run in containers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { startFakeGateway } from "../ai/AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "../ai/cliproxyRelease.ts";
import * as ServerConfig from "../config.ts";
import * as PodmanSandboxRuntime from "./PodmanSandboxRuntime.ts";
import {
  ensureDevImage,
  makeTestRun,
  podmanLimitSupportHere,
  podmanResult,
  removeTestRunContainers,
  rootlessPodmanAvailable,
} from "./PodmanSandboxRuntime.testkit.ts";
import { devCodeMounts, hubHostAllowsPodman } from "./sandboxRuntimeFromConfig.ts";
import { isSandboxHubPath } from "./SandboxHubSocket.ts";
import type { SandboxLimits } from "./sandboxLimits.ts";
import { SandboxHubAddress, SandboxRuntime } from "./SandboxRuntime.ts";

describe("what a Sandbox reaches of its Hub", () => {
  it("is the Environment connection, the Hub's git, its MCP endpoint and AI gateway, nothing else", () => {
    for (const allowed of [
      "/api/environment/connect",
      "/api/git/project-1/info/refs",
      "/api/git/thread/t-1/git-upload-pack",
      "/mcp",
      "/api/ai/anthropic/v1/messages",
    ]) {
      assert.isTrue(isSandboxHubPath(allowed), allowed);
    }
    for (const refused of [
      "/",
      "/api/auth/session",
      "/api/environments/join/start",
      "/api/gitx",
      "/api/environment/connectx",
      "/ws",
      "/mcpx",
      "/mcp/anything",
      // CLIProxyAPI's own paths are not the Hub's: a Sandbox never reaches them by any name.
      "/api/aix",
      "/api/ai",
      "/v8/management/config",
      "/v1/chat/completions",
    ]) {
      assert.isFalse(isSandboxHubPath(refused), refused);
    }
  });
});

describe("which Hubs run Podman Sandboxes", () => {
  it("only one listening on loopback alone, since a container reaches the host's other addresses", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
      assert.isTrue(hubHostAllowsPodman(host), host);
    }
    for (const host of [undefined, "0.0.0.0", "::", "192.168.1.2", "100.64.0.7"]) {
      assert.isFalse(hubHostAllowsPodman(host), String(host));
    }
  });
});

/**
 * Stands in for `t3 serve`: answers on port 4567 with the name its home was given, so a check
 * from another Sandbox can tell whose port it reached.
 */
const STUB_SERVER = [
  "node",
  "-e",
  `const name = require("node:fs").readFileSync("/home/sandbox/whoami", "utf8");
   require("node:net").createServer((socket) => socket.end(name)).listen(4567, "0.0.0.0");
   setInterval(() => {}, 1 << 30);`,
  "--",
];

/**
 * Runs `script` with Node in the container and returns what it printed. Asynchronous: the stand-in
 * Hub and the Hub socket answer from this test's process.
 */
const execNode = (container: string, script: string) =>
  Effect.callback<string>((resume) => {
    NodeChildProcess.execFile(
      "podman",
      [...PodmanSandboxRuntime.podmanGlobalArgs(), "exec", container, "node", "-e", script],
      { timeout: 90_000 },
      (error, stdout, stderr) =>
        resume(
          error === null
            ? Effect.succeed(stdout.trim())
            : Effect.die(new Error(`podman exec failed: ${stdout} ${stderr}`)),
        ),
    );
  });

/** From inside a container: what each `host:port` answered, or the error connecting to it. */
const probeScript = (targets: ReadonlyArray<string>) => `
const net = require("node:net");
const probe = (target) => new Promise((resolve) => {
  const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
  const socket = net.connect({ host, port, timeout: 3000 });
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("end", () => resolve("answered:" + data));
  socket.on("connect", () => setTimeout(() => { socket.destroy(); resolve("connected:" + data); }, 1000));
  socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.on("error", (error) => resolve("error:" + error.code));
});
Promise.all(${JSON.stringify(targets)}.map(probe)).then((results) => console.log(JSON.stringify(results)));
`;

/** The host's own addresses besides loopback, as a container might try them. */
const hostAddresses = () =>
  Object.values(NodeOS.networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry!.address);

/** A stand-in Hub on loopback: records each request it receives and answers with its path. */
const startFakeHub = Effect.acquireRelease(
  Effect.callback<{
    readonly url: string;
    readonly port: number;
    readonly requests: Array<{ path: string; headers: NodeHttp.IncomingHttpHeaders }>;
    readonly server: NodeHttp.Server;
  }>((resume) => {
    const requests: Array<{ path: string; headers: NodeHttp.IncomingHttpHeaders }> = [];
    const server = NodeHttp.createServer((request, response) => {
      requests.push({ path: request.url ?? "", headers: request.headers });
      response.end(`hub:${request.url}`);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as NodeNet.AddressInfo).port;
      resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, port, requests, server }));
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
);

const spec = (name: string) => ({
  sandboxId: `sandbox-${name}`,
  spaceId: SpaceId.make(name),
  environmentId: EnvironmentId.make(`sandbox:${name}`),
  name: `${name} Sandbox`,
  hubEnvironmentId: EnvironmentId.make("hub"),
  credential: Redacted.make(`t3env.hub.${name}-secret`),
});

describe("which limits rootless Podman enforces", () => {
  const limits = { cpus: 1.5, memoryBytes: 256 * 1024 ** 2, pids: 128, diskBytes: 1024 ** 3 };
  it("none under cgroupfs, as without the systemd user bus, and says so", () => {
    const support = PodmanSandboxRuntime.podmanLimitSupport({
      cgroupManager: "cgroupfs",
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "memory", "pids"],
    });
    assert.deepInclude(support, { cpus: false, memory: false, pids: false });
    assert.include(support.note ?? "", "not enforced on this host");
    // A memory or PIDs flag under cgroupfs makes `podman run` fail: none is passed.
    assert.deepEqual(PodmanSandboxRuntime.podmanLimitArgs(limits, support), []);
    assert.equal(
      PodmanSandboxRuntime.podmanLimitLabels(limits, support)["io.t3code.limits-enforced"],
      "none",
    );
  });
  it("those whose controllers are delegated under systemd, and names the others", () => {
    const support = PodmanSandboxRuntime.podmanLimitSupport({
      cgroupManager: "systemd",
      cgroupVersion: "v2",
      cgroupControllers: ["memory", "pids"],
    });
    assert.deepInclude(support, { cpus: false, memory: true, pids: true });
    assert.include(support.note ?? "", "no cpu controller delegated");
    assert.deepEqual(PodmanSandboxRuntime.podmanLimitArgs(limits, support), [
      "--memory=268435456b",
      "--memory-swap=268435456b",
      "--pids-limit=128",
    ]);
  });
  it("every one with all three delegated, saying nothing", () => {
    const support = PodmanSandboxRuntime.podmanLimitSupport({
      cgroupManager: "systemd",
      cgroupVersion: "v2",
      cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
    });
    assert.deepEqual(support, { cpus: true, memory: true, pids: true, note: null });
    assert.include(PodmanSandboxRuntime.podmanLimitArgs(limits, support), "--cpus=1.5");
    assert.deepEqual(
      PodmanSandboxRuntime.podmanLimitArgs(
        { cpus: null, memoryBytes: null, pids: null, diskBytes: null },
        support,
      ),
      [],
    );
  });
  it("none on cgroups v1", () => {
    const support = PodmanSandboxRuntime.podmanLimitSupport({
      cgroupManager: "systemd",
      cgroupVersion: "v1",
      cgroupControllers: ["cpu", "memory", "pids"],
    });
    assert.deepInclude(support, { cpus: false, memory: false, pids: false });
  });
});

describe.skipIf(!rootlessPodmanAvailable)("the Podman Sandbox runtime", () => {
  const run = makeTestRun();
  let image = "";
  beforeAll(() => {
    image = ensureDevImage();
  });
  afterAll(() => removeTestRunContainers(run));

  /** A runtime over a fresh root, with two Sandboxes of two Spaces created and started. */
  const twoSandboxes = (
    options: {
      readonly network?: string;
      readonly codeMounts?: ReadonlyArray<string>;
      /** Create the homes but start nothing. */
      readonly createOnly?: boolean;
      /** What each starts with. */
      readonly limits?: SandboxLimits;
    } = {},
  ) =>
    Effect.gen(function* () {
      const hub = yield* startFakeHub;
      const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-podman-sandboxes-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(rootDir, { recursive: true, force: true })),
      );
      const scope = yield* Effect.scope;
      const runtime = yield* Layer.build(
        PodmanSandboxRuntime.layer({
          image,
          serverCommand: STUB_SERVER,
          rootDir,
          namePrefix: run.namePrefix,
          labels: run.labels,
          ...(options.network === undefined ? {} : { network: options.network }),
          ...(options.codeMounts === undefined ? {} : { codeMounts: options.codeMounts }),
        }).pipe(
          Layer.provide(
            Layer.succeed(
              SandboxHubAddress,
              SandboxHubAddress.of({ loopbackUrl: Effect.succeed(hub.url) }),
            ),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-podman-hub-" })),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(
        Effect.map((context) => Context.get(context, SandboxRuntime)),
        Effect.provideService(Scope.Scope, scope),
      );
      for (const name of ["acme", "globex"]) {
        yield* runtime.create(spec(name));
        NodeFS.writeFileSync(NodePath.join(rootDir, `sandbox-${name}`, "whoami"), name);
        if (options.createOnly !== true) {
          yield* runtime.start(
            `sandbox-${name}`,
            options.limits === undefined ? undefined : { limits: options.limits },
          );
        }
      }
      return {
        hub,
        runtime,
        rootDir,
        acme: `${run.namePrefix}sandbox-acme`,
        globex: `${run.namePrefix}sandbox-globex`,
        homeOf: (name: string) => NodePath.join(rootDir, `sandbox-${name}`),
      };
    });

  it.live("a Sandbox mounts only its home and its Hub socket, and cannot read another's home", () =>
    Effect.gen(function* () {
      const { acme, globex, homeOf } = yield* twoSandboxes();
      const mounts = JSON.parse(
        podmanResult(["container", "inspect", "--format", "{{json .Mounts}}", globex]).stdout,
      ) as Array<{ Source: string; Destination: string }>;
      assert.deepEqual(mounts.map((mount) => mount.Destination).toSorted(), [
        PodmanSandboxRuntime.SANDBOX_CONTAINER_HOME,
        `${PodmanSandboxRuntime.SANDBOX_CONTAINER_HOME}/userdata/joined-hub.json`,
        `${PodmanSandboxRuntime.SANDBOX_CONTAINER_HOME}/userdata/secrets/environment-credential.bin`,
        PodmanSandboxRuntime.SANDBOX_CONTAINER_HUB_DIR,
      ]);
      assert.include(
        mounts.map((mount) => mount.Source),
        homeOf("globex"),
      );

      yield* execNode(
        acme,
        `require("node:fs").writeFileSync("/home/sandbox/acme-only", "secret")`,
      );
      const seen = JSON.parse(
        yield* execNode(
          globex,
          `const fs = require("node:fs");
             console.log(JSON.stringify({
               home: fs.readdirSync("/home/sandbox"),
               acmeHome: fs.existsSync(${JSON.stringify(homeOf("acme"))}),
               credential: fs.readdirSync("/home/sandbox", { recursive: true }).filter((p) => p.includes("environment-credential")),
               mountinfo: fs.readFileSync("/proc/self/mountinfo", "utf8"),
             }));`,
        ),
      ) as { home: string[]; acmeHome: boolean; credential: string[]; mountinfo: string };
      assert.notInclude(seen.home, "acme-only");
      assert.isFalse(seen.acmeHome);
      assert.notInclude(seen.mountinfo, homeOf("acme"));
      assert.lengthOf(seen.credential, 1);
      // Its own credential only: the one Globex's home was created with.
      const credential = yield* execNode(
        globex,
        `const fs = require("node:fs"); console.log(fs.readFileSync("/home/sandbox/" + ${JSON.stringify(seen.credential[0])}, "utf8"))`,
      );
      assert.equal(credential, "t3env.hub.globex-secret");
    }).pipe(Effect.scoped),
  );

  it.live("runs an unprivileged user and sees only its own processes", () =>
    Effect.gen(function* () {
      const { acme, globex } = yield* twoSandboxes();
      assert.equal(
        podmanResult([
          "exec",
          "--detach",
          acme,
          "node",
          "-e",
          "setInterval(() => {}, 1 << 30)",
          "acme-marker",
        ]).exitCode,
        0,
      );
      const seen = JSON.parse(
        yield* execNode(
          globex,
          `const fs = require("node:fs");
             const commands = fs.readdirSync("/proc").filter((entry) => /^\\d+$/.test(entry)).map((pid) => {
               try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").join(" "); } catch { return ""; }
             });
             const status = fs.readFileSync("/proc/self/status", "utf8");
             console.log(JSON.stringify({ commands, uid: process.getuid(), capEff: /CapEff:\\s*(\\w+)/.exec(status)[1] }));`,
        ),
      ) as { commands: string[]; uid: number; capEff: string };
      assert.notEqual(seen.uid, 0);
      assert.match(seen.capEff, /^0+$/u);
      assert.isFalse(seen.commands.some((command) => command.includes("acme-marker")));
      // Its init, its forward and server, and this check: nothing of the host's or Acme's.
      assert.isBelow(seen.commands.filter((command) => command !== "").length, 8);
    }).pipe(Effect.scoped),
  );

  it.live(
    "reaches the internet but not another Sandbox's ports nor anything on the Hub's loopback",
    () =>
      Effect.gen(function* () {
        const { acme, globex, hub } = yield* twoSandboxes();
        // Each answers on its own port 4567 with its name; from Globex, Acme's is nowhere.
        assert.equal(
          JSON.parse(yield* execNode(acme, probeScript(["127.0.0.1:4567"])))[0],
          "answered:acme",
        );
        const targets = [
          `10.0.2.2:${hub.port}`,
          `127.0.0.1:${hub.port}`,
          "10.0.2.2:4567",
          ...hostAddresses().flatMap((address) => [`${address}:${hub.port}`, `${address}:4567`]),
        ];
        const results = JSON.parse(yield* execNode(globex, probeScript(targets))) as string[];
        for (const [index, result] of results.entries()) {
          assert.isFalse(
            result.startsWith("answered") || result.startsWith("connected"),
            `${targets[index]}: ${result}`,
          );
        }
        assert.equal(hub.requests.length, 0);
        const internet = yield* execNode(
          globex,
          `fetch("https://example.com", { signal: AbortSignal.timeout(20000) }).then((r) => console.log(r.status), (e) => console.log("failed " + e.cause?.code))`,
        );
        assert.equal(internet, "200");
      }).pipe(Effect.scoped),
  );

  it.live("cannot reach the Hub's AI gateway, which listens on the Hub's loopback only", () =>
    Effect.gen(function* () {
      const { globex } = yield* twoSandboxes();
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-podman-ai-gateway-"));
      const os = HostProcess.Platform.defaultValue();
      const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
      assert.isDefined(platform);
      const port = yield* startFakeGateway({ dir, os, platform: platform! });
      const targets = [
        `127.0.0.1:${port}`,
        `10.0.2.2:${port}`,
        `host.containers.internal:${port}`,
        ...hostAddresses().map((address) => `${address}:${port}`),
      ];
      const results = JSON.parse(yield* execNode(globex, probeScript(targets))) as string[];
      for (const [index, result] of results.entries()) {
        assert.isFalse(
          result.startsWith("answered") || result.startsWith("connected"),
          `${targets[index]}: ${result}`,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reaches its Hub only through its socket, for the Environment connection and git", () =>
    Effect.gen(function* () {
      const { globex, hub } = yield* twoSandboxes();
      const fetched = JSON.parse(
        yield* execNode(
          globex,
          `const net = require("node:net");
             const raw = (path) => new Promise((resolve) => {
               const socket = net.connect(${PodmanSandboxRuntime.SANDBOX_CONTAINER_HUB_PORT}, "127.0.0.1");
               let data = "";
               socket.on("data", (chunk) => { data += chunk; });
               socket.on("end", () => resolve(data.split("\\r\\n")[0] + " " + data.slice(data.indexOf("\\r\\n\\r\\n") + 4)));
               socket.on("error", (error) => resolve("error " + error.code));
               socket.write("GET " + path + " HTTP/1.1\\r\\nHost: x\\r\\nX-Forwarded-For: 8.8.8.8\\r\\nConnection: close\\r\\n\\r\\n");
             });
             Promise.all([
               raw("/api/git/project-1/info/refs?service=git-upload-pack"),
               raw("/api/auth/session"),
               raw("/api/git/%2e%2e/auth/session"),
             ]).then((results) => console.log(JSON.stringify(results)));`,
        ),
      ) as string[];
      assert.match(
        fetched[0]!,
        /^HTTP\/1.1 200 .*hub:\/api\/git\/project-1\/info\/refs\?service=git-upload-pack$/u,
      );
      assert.match(fetched[1]!, /^HTTP\/1.1 404 /u);
      assert.match(fetched[2]!, /^HTTP\/1.1 404 /u);
      assert.deepEqual(
        hub.requests.map((request) => request.path),
        ["/api/git/project-1/info/refs?service=git-upload-pack"],
      );
      assert.isUndefined(hub.requests[0]!.headers["x-forwarded-for"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "stop and start keep its home; a container that dies is reported; delete removes both",
    () =>
      Effect.gen(function* () {
        const { runtime, acme, globex, homeOf } = yield* twoSandboxes();
        yield* execNode(globex, `require("node:fs").writeFileSync("/home/sandbox/kept", "yes")`);
        yield* runtime.stop("sandbox-globex");
        assert.equal((yield* runtime.inspect("sandbox-globex")).state._tag, "stopped");
        assert.notEqual(podmanResult(["container", "exists", globex]).exitCode, 0);
        yield* runtime.start("sandbox-globex");
        assert.equal((yield* runtime.inspect("sandbox-globex")).state._tag, "running");
        assert.equal(
          yield* execNode(
            globex,
            `console.log(require("node:fs").readFileSync("/home/sandbox/kept", "utf8"))`,
          ),
          "yes",
        );

        const exits = yield* runtime.exits.pipe(Stream.take(1), Stream.runHead, Effect.forkScoped);
        // Subscribed before the kill: the forked fiber runs up to its first wait.
        yield* Effect.yieldNow;
        assert.equal(podmanResult(["kill", acme]).exitCode, 0);
        const exited = yield* Fiber.join(exits);
        assert.equal(Option.getOrThrow(exited).sandboxId, "sandbox-acme");
        assert.equal((yield* runtime.inspect("sandbox-acme")).state._tag, "stopped");

        yield* runtime.delete("sandbox-globex");
        assert.equal((yield* runtime.inspect("sandbox-globex")).state._tag, "missing");
        assert.isFalse(NodeFS.existsSync(homeOf("globex")));
        assert.notEqual(podmanResult(["container", "exists", globex]).exitCode, 0);
      }).pipe(Effect.scoped),
  );

  it.live("the Hub's containers stop with it", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { acme } = yield* twoSandboxes().pipe(Effect.provideService(Scope.Scope, scope));
      assert.equal(podmanResult(["container", "exists", acme]).exitCode, 0);
      yield* Scope.close(scope, Exit.void);
      assert.notEqual(podmanResult(["container", "exists", acme]).exitCode, 0);
    }),
  );

  it.live(
    "a dev Hub's Sandbox sees the server's code, never the Hub's home, other homes or .env",
    () =>
      Effect.gen(function* () {
        // A checkout with what a dev Hub mounts, and secrets beside it.
        const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-podman-checkout-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(checkout, { recursive: true, force: true })),
        );
        for (const file of [
          "apps/server/src/bin.ts",
          "packages/shared/index.ts",
          "node_modules/effect/index.js",
          "apps/web/secret.txt",
          ".env",
        ]) {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(checkout, file)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(checkout, file), "x");
        }
        const { globex, homeOf, rootDir } = yield* twoSandboxes({
          codeMounts: devCodeMounts(checkout),
        });
        const seen = JSON.parse(
          yield* execNode(
            globex,
            `const fs = require("node:fs");
           console.log(JSON.stringify(${JSON.stringify([
             `${checkout}/apps/server/src/bin.ts`,
             `${checkout}/node_modules/effect/index.js`,
             `${checkout}/.env`,
             `${checkout}/apps/web/secret.txt`,
             rootDir,
             homeOf("acme"),
           ])}.map((p) => fs.existsSync(p))));`,
          ),
        ) as boolean[];
        assert.deepEqual(seen, [true, true, false, false, false, false]);
      }).pipe(Effect.scoped),
  );

  it.live("refuses a code mount holding a .env file or the Sandboxes", () =>
    Effect.gen(function* () {
      const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-podman-checkout-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(checkout, { recursive: true, force: true })),
      );
      NodeFS.mkdirSync(NodePath.join(checkout, "apps/server"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(checkout, "apps/server/.env.local"), "SECRET=1");
      const refused = yield* twoSandboxes({
        codeMounts: [NodePath.join(checkout, "apps/server")],
      }).pipe(Effect.flip);
      assert.include(refused.message, ".env.local");
      const wide = yield* twoSandboxes({ codeMounts: [NodeOS.tmpdir()] }).pipe(Effect.flip);
      assert.include(wide.message, "holds");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a link or a FIFO the Sandbox left in its home is never followed or opened by the Hub",
    () =>
      Effect.gen(function* () {
        const { runtime, homeOf } = yield* twoSandboxes({ createOnly: true });
        const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-podman-outside-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(outside, { recursive: true, force: true })),
        );
        // As the Sandbox could, while it ran: its state directory a link out, a FIFO for a secret.
        NodeFS.rmSync(NodePath.join(homeOf("acme"), "userdata"), { recursive: true, force: true });
        NodeFS.symlinkSync(outside, NodePath.join(homeOf("acme"), "userdata"));
        NodeChildProcess.execFileSync("mkfifo", [
          NodePath.join(homeOf("globex"), "userdata", "secrets", "environment-credential.bin"),
        ]);
        for (const name of ["acme", "globex"]) {
          // A new credential, as after a lost one, and a start: refused at once, nothing followed.
          yield* runtime.create({
            ...spec(name),
            credential: Redacted.make(`t3env.hub.${name}-new`),
          });
          const refused = yield* runtime.start(`sandbox-${name}`).pipe(Effect.flip);
          assert.include(refused.message, "a link or a special file");
        }
        assert.deepEqual(NodeFS.readdirSync(outside), []);
      }).pipe(Effect.scoped),
  );

  it.live("a Sandbox started again right after its container died keeps its new container", () =>
    Effect.gen(function* () {
      const { runtime, acme } = yield* twoSandboxes();
      const exits = yield* runtime.exits.pipe(Stream.take(1), Stream.runHead, Effect.forkScoped);
      // Subscribed before the kill: the forked fiber runs up to its first wait.
      yield* Effect.yieldNow;
      assert.equal(podmanResult(["kill", acme]).exitCode, 0);
      yield* Fiber.join(exits);
      yield* runtime.start("sandbox-acme");
      // The old container's cleanup must not take the new one: it runs for these two seconds.
      assert.equal(yield* execNode(acme, `setTimeout(() => console.log("alive"), 2000)`), "alive");
      assert.equal((yield* runtime.inspect("sandbox-acme")).state._tag, "running");
    }).pipe(Effect.scoped),
  );

  it.live("stopping removes the container it started, by id, never another one by its name", () =>
    Effect.gen(function* () {
      const { runtime, acme } = yield* twoSandboxes();
      // Its container under another name, and someone else's under its name.
      assert.equal(podmanResult(["rename", acme, `${acme}-moved`]).exitCode, 0);
      assert.equal(
        podmanResult([
          "create",
          "--name",
          acme,
          "--label",
          `io.t3code.test=${run.runId}`,
          image,
          "true",
        ]).exitCode,
        0,
      );
      yield* runtime.stop("sandbox-acme");
      assert.notEqual(podmanResult(["container", "exists", `${acme}-moved`]).exitCode, 0);
      assert.equal(podmanResult(["container", "exists", acme]).exitCode, 0);
    }).pipe(Effect.scoped),
  );

  const LIMITS = { cpus: 1, memoryBytes: 128 * 1024 ** 2, pids: 64, diskBytes: null };
  /** This run's container left under the Sandbox's name by the test before, which it named so. */
  const removeNameClash = () => podmanResult(["rm", "--force", `${run.namePrefix}sandbox-acme`]);

  it.live("a container records the limits it started with, and gets those the host enforces", () =>
    Effect.gen(function* () {
      removeNameClash();
      const { runtime, acme } = yield* twoSandboxes({ limits: LIMITS });
      assert.deepEqual(yield* runtime.limitSupport, podmanLimitSupportHere);
      const inspect = (format: string) =>
        podmanResult(["container", "inspect", "--format", format, acme]).stdout.trim();
      const labels = JSON.parse(inspect("{{json .Config.Labels}}")) as Record<string, string>;
      assert.equal(labels["io.t3code.limit.memory-bytes"], String(LIMITS.memoryBytes));
      assert.equal(labels["io.t3code.limit.pids"], String(LIMITS.pids));
      assert.equal(labels["io.t3code.limit.cpus"], "1");
      // Only what the host enforces reaches the container's own cgroup settings.
      assert.equal(
        inspect("{{.HostConfig.Memory}}"),
        podmanLimitSupportHere.memory ? String(LIMITS.memoryBytes) : "0",
      );
      // What it uses is read from its processes, whatever its cgroup.
      const use = yield* runtime.resourceUse("sandbox-acme");
      assert.isAbove(use?.memoryBytes ?? 0, 0);
      assert.isNull(yield* runtime.resourceUse("sandbox-nobody"));
    }).pipe(Effect.scoped),
  );

  it.live("measures a home with what the Sandbox made unreadable to the Hub's user", () =>
    Effect.gen(function* () {
      const { runtime, homeOf } = yield* twoSandboxes({ createOnly: true });
      const hidden = NodePath.join(homeOf("acme"), "hidden");
      NodeFS.mkdirSync(hidden);
      NodeFS.writeFileSync(NodePath.join(hidden, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 1));
      NodeFS.chmodSync(hidden, 0o000);
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(hidden, 0o700)));
      const measured = yield* runtime.measureHome("sandbox-acme");
      assert.equal(measured._tag, "measured", JSON.stringify(measured));
      assert.isAtLeast(measured._tag === "measured" ? measured.bytes : 0, 3 * 1024 * 1024);
    }).pipe(Effect.scoped),
  );

  // Needs a systemd user session giving each container its cgroup, with memory and pids delegated.
  it.live.skipIf(!podmanLimitSupportHere.memory || !podmanLimitSupportHere.pids)(
    `the memory and PIDs limits apply (skipped where they are not enforced: ${podmanLimitSupportHere.note ?? "enforced"})`,
    () =>
      Effect.gen(function* () {
        removeNameClash();
        const { acme } = yield* twoSandboxes({ limits: LIMITS });
        // Over its memory: the allocating process is killed, the container goes on.
        const allocated = podmanResult(
          [
            "exec",
            acme,
            "node",
            "-e",
            "const a = []; for (;;) a.push(Buffer.alloc(16 * 1024 * 1024, 1));",
          ],
          60_000,
        );
        assert.equal(allocated.exitCode, 137, allocated.stderr);
        // Past its PIDs: no more processes start.
        const spawned = podmanResult(
          [
            "exec",
            acme,
            "node",
            "-e",
            `const cp = require("node:child_process"); let made = 0;
             try { for (let i = 0; i < 200; i += 1) { cp.spawn("sleep", ["30"]); made += 1; } } catch {}
             setTimeout(() => console.log(made), 500);`,
          ],
          60_000,
        );
        assert.isBelow(Number.parseInt(spawned.stdout.trim(), 10) || 0, 200, spawned.stderr);
        assert.equal(
          podmanResult(["exec", acme, "cat", "/sys/fs/cgroup/memory.max"]).stdout.trim(),
          String(LIMITS.memoryBytes),
        );
      }).pipe(Effect.scoped),
  );

  // Grants ticket 08: a personal machine lent to two Spaces runs their Sandboxes under its own
  // root (`<base dir>-lent-sandboxes`), beside its owner's data and any Hub Sandboxes on it.
  it.live(
    "lent Sandboxes read neither each other's home nor their host owner's data, and clash with no Hub Sandbox",
    () =>
      Effect.gen(function* () {
        removeNameClash();
        const hub = yield* startFakeHub;
        const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lent-machine-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(base, { recursive: true, force: true })),
        );
        // The owner's own server's data, as `t3 serve` keeps it on that machine.
        const ownerData = NodePath.join(base, "t3");
        NodeFS.mkdirSync(NodePath.join(ownerData, "userdata"), { recursive: true });
        const ownerFile = NodePath.join(ownerData, "userdata", "state.sqlite");
        NodeFS.writeFileSync(ownerFile, "owner-only");
        const scope = yield* Effect.scope;
        const runtimeAt = (rootDir: string) =>
          Layer.build(
            PodmanSandboxRuntime.layer({
              image,
              serverCommand: STUB_SERVER,
              rootDir,
              namePrefix: run.namePrefix,
              labels: run.labels,
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  SandboxHubAddress,
                  SandboxHubAddress.of({ loopbackUrl: Effect.succeed(hub.url) }),
                ),
              ),
              Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-podman-hub-" })),
              Layer.provide(NodeServices.layer),
            ),
          ).pipe(
            Effect.map((context) => Context.get(context, SandboxRuntime)),
            Effect.provideService(Scope.Scope, scope),
          );
        const lentRoot = NodePath.join(base, "t3-lent-sandboxes");
        const lent = yield* runtimeAt(lentRoot);
        const hubs = yield* runtimeAt(NodePath.join(base, "t3-sandboxes"));
        const lentSpec = (grant: string, space: string) => ({
          ...spec(space),
          sandboxId: `lent-${grant}`,
          environmentId: EnvironmentId.make(`lent:${grant}`),
        });
        for (const [grant, space] of [
          ["g1", "acme"],
          ["g2", "globex"],
        ] as const) {
          yield* lent.create(lentSpec(grant, space));
          NodeFS.writeFileSync(NodePath.join(lentRoot, `lent-${grant}`, "whoami"), space);
          yield* lent.start(`lent-${grant}`);
        }
        // A Hub Sandbox for Acme on the same machine, as when the Hub runs there too.
        yield* hubs.create(spec("acme"));
        NodeFS.writeFileSync(NodePath.join(base, "t3-sandboxes", "sandbox-acme", "whoami"), "hub");
        yield* hubs.start("sandbox-acme");
        const running = podmanResult([
          "ps",
          "--filter",
          `label=io.t3code.test=${run.runId}`,
          "--format",
          "{{.Names}}",
        ]).stdout;
        for (const name of ["lent-g1", "lent-g2", "sandbox-acme"]) {
          assert.include(running, `${run.namePrefix}${name}`);
        }

        yield* execNode(
          `${run.namePrefix}lent-g1`,
          `require("node:fs").writeFileSync("/home/sandbox/acme-only", "secret")`,
        );
        const seen = JSON.parse(
          yield* execNode(
            `${run.namePrefix}lent-g2`,
            `const fs = require("node:fs");
             console.log(JSON.stringify({
               home: fs.readdirSync("/home/sandbox"),
               otherHome: fs.existsSync(${JSON.stringify(NodePath.join(lentRoot, "lent-g1"))}),
               ownerData: fs.existsSync(${JSON.stringify(ownerData)}),
               ownerFile: fs.existsSync(${JSON.stringify(ownerFile)}),
               hubSandbox: fs.existsSync(${JSON.stringify(NodePath.join(base, "t3-sandboxes"))}),
             }));`,
          ),
        ) as {
          home: string[];
          otherHome: boolean;
          ownerData: boolean;
          ownerFile: boolean;
          hubSandbox: boolean;
        };
        assert.notInclude(seen.home, "acme-only");
        assert.deepEqual(
          { ...seen, home: undefined },
          {
            home: undefined,
            otherHome: false,
            ownerData: false,
            ownerFile: false,
            hubSandbox: false,
          },
        );
        // Deleting a lent Sandbox removes its home and container only.
        yield* lent.delete("lent-g1");
        assert.isFalse(NodeFS.existsSync(NodePath.join(lentRoot, "lent-g1")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(lentRoot, "lent-g2")));
        assert.isTrue(NodeFS.existsSync(ownerFile));
        const after = podmanResult([
          "ps",
          "--filter",
          `label=io.t3code.test=${run.runId}`,
          "--format",
          "{{.Names}}",
        ]).stdout;
        assert.notInclude(after, `${run.namePrefix}lent-g1`);
        assert.include(after, `${run.namePrefix}sandbox-acme`);
      }).pipe(Effect.scoped),
  );
});
