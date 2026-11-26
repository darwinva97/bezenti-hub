import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { selectSessionMcpServers } from "./AcpSessionRuntime.ts";

const hubStdio: EffectAcpSchema.McpServer = { name: "t3-code", command: "t3", args: [], env: [] };
const hubHttp: EffectAcpSchema.McpServer = {
  type: "http",
  name: "t3-code",
  url: "http://127.0.0.1/mcp",
  headers: [],
};
const spaceStdio: EffectAcpSchema.McpServer = {
  name: "github",
  command: "github-mcp",
  args: [],
  env: [{ name: "GITHUB_TOKEN", value: "from-the-vault" }],
};
const spaceHttp: EffectAcpSchema.McpServer = {
  type: "http",
  name: "docs",
  url: "https://docs.example.test/mcp",
  headers: [],
};
const lists = { acp: [], http: [hubHttp], stdio: [hubStdio], space: [spaceStdio, spaceHttp] };

describe("selectSessionMcpServers", () => {
  it("adds a Space's servers beside the Hub's, http ones only to an agent that takes http", () => {
    assert.deepEqual(selectSessionMcpServers({ http: true }, lists), [
      spaceStdio,
      spaceHttp,
      hubHttp,
    ]);
    assert.deepEqual(selectSessionMcpServers({}, lists), [spaceStdio, hubStdio]);
    assert.deepEqual(selectSessionMcpServers(undefined, { ...lists, space: [] }), [hubStdio]);
  });
});
