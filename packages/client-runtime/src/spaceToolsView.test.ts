import { describe, expect, it } from "@effect/vitest";

import { emptyMcpForm, mcpConfigOf, mcpFormOf, parsePairs } from "./spaceToolsView.ts";

describe("spaceToolsView", () => {
  it("reads headers and variables as lines, and says how when a line is malformed", () => {
    expect(parsePairs("X-Team: ${TEAM}\n\nAccept: json", ":")).toEqual({
      pairs: { "X-Team": "${TEAM}", Accept: "json" },
    });
    expect(parsePairs("GITHUB_TOKEN=${GITHUB_TOKEN}", "=")).toEqual({
      pairs: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
    expect(parsePairs("no separator", "=")).toEqual({ error: "Write each line as NAME=value." });
  });

  it("round-trips a server's settings through the form", () => {
    const config = {
      transport: "stdio" as const,
      command: "github-mcp",
      args: ["--read-only", "--toolsets=repos"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    };
    expect(mcpConfigOf(mcpFormOf(config))).toEqual({ config });
    expect(
      mcpConfigOf({ ...emptyMcpForm, transport: "http", url: " https://a.test/mcp " }),
    ).toEqual({ config: { transport: "http", url: "https://a.test/mcp", headers: {} } });
  });
});
