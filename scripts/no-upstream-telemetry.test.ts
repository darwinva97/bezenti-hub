// @effect-diagnostics nodeBuiltinImport:off - walks the source tree with node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

// ADR 0007: no client, server, build, or release step sends usage events or traces to
// pingdotgg's services. T3 Connect's relay (infra/relay) and the marketing site are gone.
const UPSTREAM_TELEMETRY =
  /ingest\.t3\.codes|T3CODE_POSTHOG_|api\.axiom\.co|X-Axiom-Dataset|from "expo-observe"|"expo-observe":|RELAY_CLIENT_OTLP|relay-client-tracing/i;
const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../..");
const SHIPPED_SOURCES = [
  "apps/server",
  "apps/web",
  "apps/desktop",
  "apps/mobile",
  "packages",
  "scripts",
  ".github",
];
// Dependencies, vendored repos, build output, and generated third-party schemas.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".repos",
  ".git",
  ".turbo",
  ".expo",
  "dist",
  "dist-electron",
  "build",
  "Pods",
]);
const THIS_FILE = NodeURL.fileURLToPath(import.meta.url);

// ADR 0007: links point at the Hub's own domain (T3CODE_PUBLIC_URL), never at pingdotgg's hosts.
const UPSTREAM_HOST = /(?:^|[^\w.-])(?:[\w-]+\.)*t3\.codes\b/i;
// The Owner-facing docs and the repo's own project file ship too.
const LINKED_SOURCES = [...SHIPPED_SOURCES, "docs/user", "t3.json", ".env.example", "README.md"];
// Lines that name a t3.codes host without linking to it, each with its reason.
const ALLOWED_UPSTREAM_HOST_LINES: ReadonlyArray<readonly [file: string, reason: string]> = [
  // The GNOME Shell extension's UUID is its install directory and identity; renaming it orphans
  // every installed copy. It is an identifier, never resolved as a host.
  ["apps/desktop/gnome-extension/metadata.json", '"uuid": "snap-shot@t3.codes"'],
  ["apps/desktop/gnome-extension/bundle.json", '"uuid": "snap-shot@t3.codes"'],
];

function* sourceFiles(directory: string): Generator<string> {
  if (NodeFS.statSync(directory).isFile()) {
    yield directory;
    return;
  }
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(path);
    } else if (entry.isFile() && !entry.name.endsWith(".graphql") && path !== THIS_FILE) {
      yield path;
    }
  }
}

describe("upstream telemetry", () => {
  it("is not reachable from any shipped app, package, script, or workflow", () => {
    const matches: Array<string> = [];
    for (const root of SHIPPED_SOURCES) {
      for (const file of sourceFiles(NodePath.join(REPO_ROOT, root))) {
        const text = NodeFS.readFileSync(file, "utf8");
        if (text.includes("\0")) continue;
        text.split("\n").forEach((line, index) => {
          if (UPSTREAM_TELEMETRY.test(line)) {
            matches.push(`${NodePath.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(matches).toEqual([]);
  });
});

describe("issue forms", () => {
  const templates = NodePath.join(REPO_ROOT, ".github/ISSUE_TEMPLATE");

  it("never send reporters to the upstream repository", () => {
    const matches: Array<string> = [];
    for (const file of sourceFiles(templates)) {
      const lines = NodeFS.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/pingdotgg\/t3code/i.test(line)) {
          matches.push(`${NodePath.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(matches).toEqual([]);
  });

  it("offer a feature request form in this repository", () => {
    const forms = NodeFS.readdirSync(templates).map((name) =>
      NodeFS.readFileSync(NodePath.join(templates, name), "utf8"),
    );
    expect(forms.some((form) => /^name: Feature request$/m.test(form))).toBe(true);
  });
});

describe("upstream hosts", () => {
  it("are never linked from a shipped app, package, script, workflow, or user doc", () => {
    const matches: Array<string> = [];
    for (const root of LINKED_SOURCES) {
      for (const file of sourceFiles(NodePath.join(REPO_ROOT, root))) {
        const text = NodeFS.readFileSync(file, "utf8");
        if (text.includes("\0")) continue;
        const relative = NodePath.relative(REPO_ROOT, file).replaceAll("\\", "/");
        text.split("\n").forEach((line, index) => {
          if (!UPSTREAM_HOST.test(line)) return;
          const allowed = ALLOWED_UPSTREAM_HOST_LINES.some(
            ([allowedFile, allowedText]) => allowedFile === relative && line.includes(allowedText),
          );
          if (!allowed) matches.push(`${relative}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(matches).toEqual([]);
  });
});
