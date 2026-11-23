// @effect-diagnostics nodeBuiltinImport:off -- reads the checkout's path and runs checks in containers.
/**
 * The real base image, built from this checkout with Podman (slow: minutes on a first build, its
 * layers then cached). Runs with rootless Podman and `T3CODE_TEST_SANDBOX_IMAGE_BUILD=1`; skipped otherwise.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";
import { sandboxEnvironmentIdOf, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { listEnvironments } from "../environments/environments.testkit.ts";
import { makeHub, type Hub } from "../environments/HubWithEnvironments.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as PodmanSandboxRuntime from "./PodmanSandboxRuntime.ts";
import {
  makeTestRun,
  podmanResult,
  removeTestRunContainers,
  rootlessPodmanAvailable,
} from "./PodmanSandboxRuntime.testkit.ts";
import { buildSandboxImage } from "./SandboxImage.ts";
import * as Sandboxes from "./Sandboxes.ts";
import { sandboxIdOf } from "./SandboxRuntime.ts";

/** Its own tag, kept between runs so the next build reuses its layers. */
const IMAGE = "localhost/t3code-sandbox-test:latest";
const CHECKOUT = NodePath.resolve(new URL("../../../../", import.meta.url).pathname);
const BUILD_TIMEOUT_MS = 40 * 60 * 1000;

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** Runs a shell command in the container, as its user, and returns what it printed. */
const execIn = (container: string, script: string) => {
  const result = podmanResult(["exec", container, "sh", "-c", script], 120_000);
  assert.equal(result.exitCode, 0, `${script}: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};

/**
 * Another build of the image under the same tag, as the next `t3 sandbox image build` makes: a
 * layer more and a new version.
 */
const rebuildAs = (version: string) => {
  const context = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-image-next-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(context, "Containerfile"),
      `FROM ${IMAGE}\nRUN echo ${version} > /etc/t3-image-next\n`,
    );
    NodeChildProcess.execFileSync(
      "podman",
      [
        ...PodmanSandboxRuntime.podmanGlobalArgs(),
        "build",
        "--quiet",
        "--tag",
        IMAGE,
        "--label",
        `${PodmanSandboxRuntime.SANDBOX_IMAGE_VERSION_LABEL}=${version}`,
        context,
      ],
      { stdio: "ignore", timeout: 300_000 },
    );
  } finally {
    NodeFS.rmSync(context, { recursive: true, force: true });
  }
};

describe.skipIf(!rootlessPodmanAvailable || process.env.T3CODE_TEST_SANDBOX_IMAGE_BUILD !== "1")(
  "the Sandbox base image, built for real",
  () => {
    const run = makeTestRun();
    afterAll(() => {
      removeTestRunContainers(run);
      // The next run's build reuses the layers; only this run's extra build goes.
      podmanResult(["image", "rm", IMAGE]);
    });

    it.live(
      "builds from this checkout; a Sandbox runs its own `t3 serve` from it, and its provider logins outlive the next image",
      () =>
        Effect.gen(function* () {
          const lines: Array<string> = [];
          const built = yield* buildSandboxImage({
            image: IMAGE,
            checkout: CHECKOUT,
            onLine: (line) => lines.push(line),
          }).pipe(Effect.tapError(() => Effect.logError(lines.slice(-60).join("\n"))));
          assert.match(built.version ?? "", /^\d+\.\d+\.\d+.*-\d{14}$/u);
          // The toolchain every Space gets.
          const tools = podmanResult(
            [
              "run",
              "--rm",
              "--entrypoint",
              "sh",
              IMAGE,
              "-c",
              "node --version && git --version && rg --version && claude --version && codex --version && opencode --version && pi --version && grok --version && t3 --version",
            ],
            300_000,
          );
          assert.equal(tools.exitCode, 0, tools.stderr);
          assert.include(tools.stdout, "v26.");
          assert.include(tools.stdout, "(Claude Code)");
          assert.include(tools.stdout, "codex-cli");
          // The document skills' tools, and Claude Code's managed copy of the skills.
          const office = podmanResult(
            [
              "run",
              "--rm",
              "--entrypoint",
              "sh",
              IMAGE,
              "-c",
              "soffice --version && pandoc --version && pdftoppm -v && qpdf --version && tesseract --list-langs && markitdown --help && ls /etc/claude-code/.claude/skills/",
            ],
            300_000,
          );
          assert.equal(office.exitCode, 0, office.stderr);
          assert.include(office.stdout, "LibreOffice");
          assert.include(office.stdout, "spa");
          for (const skill of ["docx", "pdf", "pptx", "xlsx"]) assert.include(office.stdout, skill);

          // A Hub whose Sandboxes run the image's own server: no checkout mounted.
          const hub = yield* makeHub({
            sandboxRuntime: (rootDir) =>
              PodmanSandboxRuntime.layer({
                image: IMAGE,
                rootDir,
                namePrefix: run.namePrefix,
                labels: run.labels,
              }),
          });
          const acme = (yield* hub
            .service(SpaceDirectory.SpaceDirectory)
            .createOrganization(yield* ownerIdOf(hub), "Acme")
            .pipe(Effect.orDie)).id;
          const sandboxes = hub.service(Sandboxes.Sandboxes);
          yield* sandboxes
            .ensureRunning({ spaceId: acme, actorUserId: undefined })
            .pipe(Effect.orDie);
          const listed = yield* listEnvironments(hub.server, hub.owner);
          assert.equal(
            listed.find((entry) => entry.id === sandboxEnvironmentIdOf(acme))?.status,
            "online",
          );
          const container = `${run.namePrefix}${sandboxIdOf(acme)}`;
          const mounts = JSON.parse(
            podmanResult(["container", "inspect", "--format", "{{json .Mounts}}", container])
              .stdout,
          ) as Array<{ Destination: string }>;
          assert.lengthOf(mounts, 4, JSON.stringify(mounts));
          assert.include(
            podmanResult(["container", "inspect", "--format", "{{.ImageName}}", container]).stdout,
            "t3code-sandbox-test",
          );
          const [recorded] = (yield* sandboxes.listImages.pipe(Effect.orDie)).filter(
            (row) => row.spaceId === acme,
          );
          assert.equal(recorded?.imageVersion, built.version);

          // Codex, OpenCode, Pi and Grok find the skills in the home, and a skill turns a document the
          // agent wrote with the preinstalled libraries into a PDF, as a non-root user.
          assert.equal(
            execIn(container, "readlink ~/.agents/skills/docx ~/.grok/skills/pptx"),
            "/opt/t3/skills/docx\n/opt/t3/skills/pptx",
          );
          assert.include(
            execIn(
              container,
              [
                'cd "$(mktemp -d)"',
                `node -e 'const d = require("docx"); d.Packer.toBuffer(new d.Document({ sections: [{ children: [new d.Paragraph("Hola desde el Sandbox")] }] })).then((b) => require("fs").writeFileSync("hola.docx", b))'`,
                "python /opt/t3/skills/docx/scripts/office/soffice.py --headless --convert-to pdf hola.docx > /dev/null",
                "pdftotext hola.pdf -",
              ].join(" && "),
            ),
            "Hola desde el Sandbox",
          );

          // Provider logins live in the Sandbox's home, as each CLI keeps them.
          execIn(
            container,
            "mkdir -p ~/.codex ~/.claude && printf codex-login > ~/.codex/auth.json && printf claude-login > ~/.claude/.credentials.json",
          );
          yield* sandboxes.stop({ spaceId: acme, actor: { source: "system" } }).pipe(Effect.orDie);
          rebuildAs("0.0.0-20990101000000");
          yield* sandboxes
            .ensureRunning({ spaceId: acme, actorUserId: undefined })
            .pipe(Effect.orDie);
          const [after] = (yield* sandboxes.listImages.pipe(Effect.orDie)).filter(
            (row) => row.spaceId === acme,
          );
          assert.equal(after?.imageVersion, "0.0.0-20990101000000");
          assert.equal(execIn(container, "cat /etc/t3-image-next"), "0.0.0-20990101000000");
          assert.equal(
            execIn(container, "cat ~/.codex/auth.json ~/.claude/.credentials.json"),
            "codex-loginclaude-login",
          );
        }).pipe(Effect.scoped),
      BUILD_TIMEOUT_MS,
    );
  },
);
