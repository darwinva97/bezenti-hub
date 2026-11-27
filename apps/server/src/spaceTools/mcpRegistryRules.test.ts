import { describe, expect, it } from "vitest";

import { MCP_REGISTRY_MAX_RESULTS, registryResults } from "./mcpRegistryRules.ts";

const entry = (server: Record<string, unknown>) => ({
  server: { version: "1.0.0", ...server },
  _meta: {},
});

describe("registryResults", () => {
  it("turns a remote into an http draft whose secret header is a Vault reference", () => {
    const [result] = registryResults({
      servers: [
        entry({
          name: "io.github.github/github-mcp-server",
          title: "GitHub",
          description: "Repos, issues and pull requests.",
          version: "2.3.0",
          websiteUrl: "https://github.com/github/github-mcp-server",
          remotes: [
            {
              type: "streamable-http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: [{ name: "Authorization", isSecret: true }],
            },
          ],
          packages: [
            {
              registryType: "oci",
              identifier: "ghcr.io/github/github-mcp-server",
              transport: { type: "stdio" },
            },
          ],
        }),
      ],
    })!;
    expect(result).toEqual({
      source: {
        registry: "mcp-registry",
        id: "io.github.github/github-mcp-server",
        version: "2.3.0",
      },
      title: "GitHub",
      description: "Repos, issues and pull requests.",
      websiteUrl: "https://github.com/github/github-mcp-server",
      name: "github-mcp-server",
      config: {
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_MCP_SERVER_TOKEN}" },
      },
      secrets: ["GITHUB_MCP_SERVER_TOKEN"],
    });
  });

  it("spells out the full command of a package, with secrets as references", () => {
    const results = registryResults({
      servers: [
        entry({
          name: "io.example/files",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/files-mcp",
              version: "0.2.0",
              transport: { type: "stdio" },
              packageArguments: [{ type: "named", name: "--root", valueHint: "directory" }],
              environmentVariables: [
                { name: "FILES_API_KEY", isSecret: true },
                { name: "FILES_REGION", isRequired: true, default: "eu" },
                { name: "FILES_DEBUG" },
              ],
            },
          ],
        }),
        entry({
          name: "io.example/docker",
          packages: [
            {
              registryType: "oci",
              identifier: "ghcr.io/example/docker-mcp:1",
              transport: { type: "stdio" },
              runtimeArguments: [
                {
                  type: "named",
                  name: "-e",
                  value: "TOKEN={token}",
                  variables: { token: { isSecret: true } },
                },
              ],
            },
          ],
        }),
        entry({
          name: "io.example/py",
          packages: [
            {
              registryType: "pypi",
              identifier: "py-mcp",
              version: "3",
              transport: { type: "stdio" },
            },
          ],
        }),
      ],
    })!;
    expect(results.map((result) => [result.name, result.config, result.secrets])).toEqual([
      [
        "files",
        {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/files-mcp@0.2.0", "--root", "<directory>"],
          env: { FILES_API_KEY: "${FILES_API_KEY}", FILES_REGION: "eu" },
        },
        ["FILES_API_KEY"],
      ],
      [
        "docker",
        {
          transport: "stdio",
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "TOKEN=${TOKEN}", "ghcr.io/example/docker-mcp:1"],
          env: {},
        },
        ["TOKEN"],
      ],
      ["py", { transport: "stdio", command: "uvx", args: ["py-mcp==3"], env: {} }, []],
    ]);
  });

  it("drops what it cannot trust or start, and keeps the rest", () => {
    const results = registryResults({
      servers: [
        "not an entry",
        { server: { name: 42 } },
        entry({
          name: "io.example/plain-http",
          remotes: [{ type: "streamable-http", url: "http://example.test/mcp" }],
        }),
        entry({
          name: "io.example/nuget",
          packages: [{ registryType: "nuget", identifier: "X", transport: { type: "stdio" } }],
        }),
        entry({ name: "io.example/nothing" }),
        entry({
          name: "io.example/ok",
          websiteUrl: "javascript:alert(1)",
          remotes: [{ type: "streamable-http", url: "https://ok.test/mcp" }],
        }),
        entry({
          name: "io.example/ok",
          version: "0.9.0",
          remotes: [{ type: "streamable-http", url: "https://old.test/mcp" }],
        }),
      ],
    });
    expect(results).toEqual([
      {
        source: { registry: "mcp-registry", id: "io.example/ok", version: "1.0.0" },
        title: "io.example/ok",
        description: "",
        name: "ok",
        config: { transport: "http", url: "https://ok.test/mcp", headers: {} },
        secrets: [],
      },
    ]);
  });

  it("answers undefined for something that is not a registry answer, and caps the results", () => {
    expect(registryResults({ error: "down" })).toBeUndefined();
    expect(registryResults("<html>")).toBeUndefined();
    const many = Array.from({ length: 30 }, (_, index) =>
      entry({
        name: `io.example/s${index}`,
        remotes: [{ type: "streamable-http", url: "https://s.test/mcp" }],
      }),
    );
    expect(registryResults({ servers: many })).toHaveLength(MCP_REGISTRY_MAX_RESULTS);
  });
});
