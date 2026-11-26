import { describe, expect, it } from "@effect/vitest";

import { resolveSpaceMcps } from "./spaceMcps.ts";

const secretEnv = {
  fingerprint: "set-1",
  variables: [{ name: "GITHUB_TOKEN", value: "value-from-the-vault" }],
};

describe("resolveSpaceMcps", () => {
  it("fills references from the session's own variables, everywhere they appear", () => {
    const { ready, dropped } = resolveSpaceMcps(
      [
        {
          name: "github",
          config: {
            transport: "http",
            url: "https://mcp.example.test/mcp",
            headers: { "X-Team": "team-${GITHUB_TOKEN}" },
          },
        },
        {
          name: "local",
          config: {
            transport: "stdio",
            command: "github-mcp",
            args: ["--token=${GITHUB_TOKEN}"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
          },
        },
      ],
      secretEnv,
    );
    expect(dropped).toEqual([]);
    expect(ready).toEqual([
      {
        name: "github",
        config: {
          transport: "http",
          url: "https://mcp.example.test/mcp",
          headers: { "X-Team": "team-value-from-the-vault" },
        },
      },
      {
        name: "local",
        config: {
          transport: "stdio",
          command: "github-mcp",
          args: ["--token=value-from-the-vault"],
          env: { GITHUB_TOKEN: "value-from-the-vault", LOG_LEVEL: "info" },
        },
      },
    ]);
  });

  it("drops a server whose value the session lacks instead of starting it with an empty one", () => {
    const launch = {
      name: "github",
      config: {
        transport: "stdio" as const,
        command: "github-mcp",
        args: [],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
    };
    expect(resolveSpaceMcps([launch], undefined)).toEqual({ ready: [], dropped: ["github"] });
    expect(resolveSpaceMcps([launch], { fingerprint: "none" })).toEqual({
      ready: [],
      dropped: ["github"],
    });
  });
});
