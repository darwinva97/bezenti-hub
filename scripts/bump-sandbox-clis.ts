#!/usr/bin/env node
// Bumps the Sandbox image's CLIs (apps/server/sandbox-image/clis) to their latest npm releases,
// regenerates the lockfile and the version table in docs/internals/sandboxes.md, and prints a
// summary for the pull request. A rebuilt image is the only way a Sandbox gets a newer CLI.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface SandboxCliBump {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

function isNewerRelease(candidate: string, current: string): boolean {
  const next = RELEASE.exec(candidate);
  const now = RELEASE.exec(current);
  if (!next || !now) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(next[index]) - Number(now[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Only plain releases newer than the pin: a prerelease or a pulled `latest` never moves it back. */
export function planSandboxCliBumps(
  pinned: Readonly<Record<string, string>>,
  latest: Readonly<Record<string, string | null>>,
): ReadonlyArray<SandboxCliBump> {
  return Object.entries(pinned).flatMap(([name, from]) => {
    const to = latest[name];
    return to && isNewerRelease(to, from) ? [{ name, from, to }] : [];
  });
}

/** Rewrites the version cell of each bumped package's row, keeping the column width. */
export function rewriteSandboxCliTable(
  markdown: string,
  bumps: ReadonlyArray<SandboxCliBump>,
): string {
  return markdown
    .split("\n")
    .map((line) => {
      const bump = bumps.find((candidate) => line.includes(`| \`${candidate.name}\` (npm)`));
      if (!bump) return line;
      return line.replace(/\| ([^|]*?)( *)(?=\|)/g, (cell, content: string, padding: string) => {
        if (content !== bump.from) return cell;
        const width = content.length + padding.length;
        return `| ${bump.to.padEnd(width)}`;
      });
    })
    .join("\n");
}

const CliManifest = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
);
const CliLockfile = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.Struct({ hasInstallScript: Schema.optional(Schema.Boolean) }),
    ),
  }),
);

export function packagesWithInstallScripts(
  lockfile: typeof CliLockfile.Type,
): ReadonlyArray<string> {
  return Object.entries(lockfile.packages)
    .filter(([, entry]) => entry.hasInstallScript === true)
    .map(([key]) => key.replace(/^.*node_modules\//, ""))
    .toSorted();
}

const decodeCliManifest = Schema.decodeEffect(CliManifest);
const decodeCliLockfile = Schema.decodeEffect(CliLockfile);

class NpmInstallFailedError extends Schema.TaggedError<NpmInstallFailedError>()(
  "NpmInstallFailedError",
  { exitCode: Schema.Int },
) {
  override get message(): string {
    return `npm install --package-lock-only exited with code ${this.exitCode}.`;
  }
}

const bumpSandboxClis = Effect.fn("bumpSandboxClis")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const clis = path.join(root, "apps/server/sandbox-image/clis");
  const manifestPath = path.join(clis, "package.json");
  const lockPath = path.join(clis, "package-lock.json");
  const docsPath = path.join(root, "docs/internals/sandboxes.md");
  const readLock = fs.readFileString(lockPath).pipe(Effect.flatMap(decodeCliLockfile));

  const manifestText = yield* fs.readFileString(manifestPath);
  const { dependencies } = yield* decodeCliManifest(manifestText);
  // The spawner ignores exit codes: a failed lookup prints nothing and stays unknown.
  const latest: Record<string, string | null> = {};
  for (const name of Object.keys(dependencies)) {
    const output = yield* spawner.string(
      ChildProcess.make("npm", ["view", `${name}@latest`, "version"]),
    );
    latest[name] = output.trim() || null;
    if (latest[name] === null)
      yield* Console.error(`Could not read the latest version of ${name}.`);
  }

  const bumps = planSandboxCliBumps(dependencies, latest);
  if (bumps.length === 0) {
    yield* Console.log("The Sandbox image's CLIs are on their latest releases.");
    return;
  }

  const scriptsBefore = packagesWithInstallScripts(yield* readLock);
  yield* fs.writeFileString(
    manifestPath,
    bumps.reduce(
      (text, bump) =>
        text.replace(`"${bump.name}": "${bump.from}"`, `"${bump.name}": "${bump.to}"`),
      manifestText,
    ),
  );
  // The image installs with --ignore-scripts and rebuilds only allowScripts; the lock must too.
  const install = yield* spawner.spawn(
    ChildProcess.make(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: clis, stdout: "inherit", stderr: "inherit" },
    ),
  );
  const exitCode = Number(yield* install.exitCode);
  if (exitCode !== 0) return yield* new NpmInstallFailedError({ exitCode });
  const scriptsAfter = packagesWithInstallScripts(yield* readLock);
  yield* fs.writeFileString(
    docsPath,
    rewriteSandboxCliTable(yield* fs.readFileString(docsPath), bumps),
  );

  yield* Console.log(
    bumps.map((bump) => `- \`${bump.name}\`: ${bump.from} → ${bump.to}`).join("\n"),
  );
  const added = scriptsAfter.filter((name) => !scriptsBefore.includes(name));
  if (added.length > 0) {
    yield* Console.log(
      `\nNew packages with an install script, review them and clis/package.json's allowScripts: ${added.join(", ")}`,
    );
  }
}, Effect.scoped);

if (import.meta.main) {
  bumpSandboxClis().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
