// @effect-diagnostics nodeBuiltinImport:off - checks the build context's modes on disk.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEBIAN_PACKAGES } from "../preview/PreviewBrowserHost.ts";
import { cachedUntilAvailable, makeContextReadable, stagingEnvironment } from "./SandboxImage.ts";

it("installs every library T3's browser needs, as no one in a Sandbox can run its setup", () => {
  const containerfile = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../../sandbox-image/Containerfile"),
    "utf8",
  );
  const installed = new Set(containerfile.split(/[\s\\]+/u));
  const missing = DEBIAN_PACKAGES.filter((names) => !names.some((name) => installed.has(name)));
  assert.deepEqual(missing, []);
  assert.include(containerfile, "T3CODE_SERVER_BROWSER_SANDBOX=0");
});

it("stages with the registry's proxy, CA and package manager settings, never provider keys", () => {
  const staged = stagingEnvironment({
    HOME: "/home/ada",
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.corp:3128",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    npm_config_registry: "https://npm.corp/",
    PNPM_HOME: "/home/ada/.pnpm",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_secret",
    NODE_OPTIONS: "--inspect",
  });
  assert.equal(staged.HTTPS_PROXY, "http://proxy.corp:3128");
  assert.equal(staged.no_proxy, "localhost");
  assert.equal(staged.NODE_EXTRA_CA_CERTS, "/etc/corp-ca.pem");
  assert.equal(staged.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  assert.equal(staged.npm_config_registry, "https://npm.corp/");
  assert.equal(staged.PNPM_HOME, "/home/ada/.pnpm");
  assert.equal(staged.HOME, "/home/ada");
  assert.isUndefined(staged.ANTHROPIC_API_KEY);
  assert.isUndefined(staged.GITHUB_TOKEN);
  assert.isUndefined(staged.NODE_OPTIONS);
});

it.effect(
  "asks why it cannot build at most once per few seconds, and never again once it can",
  () =>
    Effect.gen(function* () {
      let checks = 0;
      let reason: string | null = "Rootless Podman is not available on the Hub.";
      const read = yield* cachedUntilAvailable(
        Effect.sync(() => {
          checks += 1;
          return reason;
        }),
        5_000,
      );
      // Polls that come together share one `podman info`.
      const answers = yield* Effect.all([read, read, read], { concurrency: "unbounded" });
      assert.deepEqual(answers, Array(3).fill("Rootless Podman is not available on the Hub."));
      assert.equal(checks, 1);
      // Podman set up meanwhile: seen once the answer is old enough.
      reason = null;
      assert.equal(yield* read, "Rootless Podman is not available on the Hub.");
      yield* TestClock.adjust("5 seconds");
      assert.isNull(yield* read);
      reason = "gone";
      yield* TestClock.adjust("1 hour");
      assert.isNull(yield* read);
      assert.equal(checks, 2);
    }),
);

it("makes the build context readable inside the image, whatever the umask it was made under", () => {
  const context = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-context-test-"));
  try {
    NodeFS.mkdirSync(NodePath.join(context, "extras/scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(context, "extras/scripts/agent.ts"), "");
    NodeFS.writeFileSync(NodePath.join(context, "extras/scripts/run"), "");
    // As made under umask 077.
    NodeFS.chmodSync(NodePath.join(context, "extras/scripts/agent.ts"), 0o600);
    NodeFS.chmodSync(NodePath.join(context, "extras/scripts/run"), 0o700);
    NodeFS.chmodSync(NodePath.join(context, "extras/scripts"), 0o700);
    NodeFS.chmodSync(NodePath.join(context, "extras"), 0o700);
    makeContextReadable(context);
    const modeOf = (path: string) => NodeFS.statSync(NodePath.join(context, path)).mode & 0o777;
    assert.equal(modeOf("extras"), 0o755);
    assert.equal(modeOf("extras/scripts"), 0o755);
    assert.equal(modeOf("extras/scripts/agent.ts"), 0o644);
    assert.equal(modeOf("extras/scripts/run"), 0o755);
    // The context itself stays the Hub's alone.
    assert.equal(modeOf("."), 0o700);
  } finally {
    NodeFS.rmSync(context, { recursive: true, force: true });
  }
});
