import { expect, it } from "@effect/vitest";

import {
  packagesWithInstallScripts,
  planSandboxCliBumps,
  rewriteSandboxCliTable,
} from "./bump-sandbox-clis.ts";

it("bumps only to a newer plain release", () => {
  expect(
    planSandboxCliBumps(
      {
        "@anthropic-ai/claude-code": "2.1.319",
        "@openai/codex": "0.167.0",
        "opencode-ai": "1.19.5",
        "@xai-official/grok": "1.0.77",
        "@earendil-works/pi-coding-agent": "1.5.0",
      },
      {
        "@anthropic-ai/claude-code": "2.1.332",
        "@openai/codex": "0.167.0",
        "opencode-ai": "1.19.4",
        "@xai-official/grok": "1.1.0-beta.1",
        "@earendil-works/pi-coding-agent": null,
      },
    ),
  ).toEqual([{ name: "@anthropic-ai/claude-code", from: "2.1.319", to: "2.1.332" }]);
});

it("rewrites only the bumped row's version and keeps the table aligned", () => {
  const table = [
    "| Piece                 | Version   | Installed as                            |",
    "| --------------------- | --------- | --------------------------------------- |",
    "| Node                  | 26.12.1   | nodejs.org tarball, SHASUMS256          |",
    "| Claude Code, `claude` | 2.1.319   | `@anthropic-ai/claude-code` (npm)       |",
    "| OpenCode, `opencode`  | 1.19.5    | `opencode-ai` (npm)                     |",
  ].join("\n");

  expect(
    rewriteSandboxCliTable(table, [
      { name: "@anthropic-ai/claude-code", from: "2.1.319", to: "2.1.332" },
      { name: "opencode-ai", from: "1.19.5", to: "1.20.10" },
    ]),
  ).toBe(
    [
      "| Piece                 | Version   | Installed as                            |",
      "| --------------------- | --------- | --------------------------------------- |",
      "| Node                  | 26.12.1   | nodejs.org tarball, SHASUMS256          |",
      "| Claude Code, `claude` | 2.1.332   | `@anthropic-ai/claude-code` (npm)       |",
      "| OpenCode, `opencode`  | 1.20.10   | `opencode-ai` (npm)                     |",
    ].join("\n"),
  );
});

it("names the locked packages that run an install script", () => {
  expect(
    packagesWithInstallScripts({
      packages: {
        "": {},
        "node_modules/opencode-ai": { hasInstallScript: true },
        "node_modules/@google/genai": { hasInstallScript: true },
        "node_modules/@openai/codex": {},
        "node_modules/a/node_modules/protobufjs": { hasInstallScript: true },
      },
    }),
  ).toEqual(["@google/genai", "opencode-ai", "protobufjs"]);
});
