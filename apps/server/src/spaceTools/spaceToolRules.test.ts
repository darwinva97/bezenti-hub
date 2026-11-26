import { SPACE_MCPS_CONTRACT_VERSION, type SpaceMcpConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { decideSpaceMcps } from "./spaceToolRules.ts";

const withToken: SpaceMcpConfig = {
  transport: "stdio",
  command: "github-mcp",
  args: [],
  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
};
const plain: SpaceMcpConfig = {
  transport: "http",
  url: "https://docs.example.test/mcp",
  headers: {},
};

const decide = (overrides: Partial<Parameters<typeof decideSpaceMcps>[0]> = {}) =>
  decideSpaceMcps({
    mcps: [
      { name: "github", config: withToken },
      { name: "docs", config: plain },
    ],
    delivered: new Set(["GITHUB_TOKEN"]),
    receivesSpaceMcps: true,
    receivesSecretEnv: true,
    contractVersion: SPACE_MCPS_CONTRACT_VERSION,
    ...overrides,
  }).map(({ name, available, reason, missing }) => ({ name, available, reason, missing }));

describe("decideSpaceMcps", () => {
  it("sends a server whose references the Thread receives", () => {
    expect(decide()).toEqual([
      { name: "github", available: true, reason: undefined, missing: [] },
      { name: "docs", available: true, reason: undefined, missing: [] },
    ]);
  });

  it("holds back one whose entry no longer reaches the Thread, saying which, never sent empty", () => {
    // A group unlinked, a Grant ended, a Lease that failed: the name is not in the Thread's set.
    expect(decide({ delivered: new Set() })).toEqual([
      { name: "github", available: false, reason: "not-delivered", missing: ["GITHUB_TOKEN"] },
      { name: "docs", available: true, reason: undefined, missing: [] },
    ]);
  });

  it("says why when the provider or the machine cannot take them", () => {
    expect(decide({ receivesSpaceMcps: false }).map((row) => row.reason)).toEqual([
      "not-supported",
      "not-supported",
    ]);
    expect(decide({ receivesSecretEnv: false }).map((row) => row.reason)).toEqual([
      "no-secrets",
      undefined,
    ]);
    expect(
      decide({ contractVersion: SPACE_MCPS_CONTRACT_VERSION - 1 }).map((row) => row.reason),
    ).toEqual(["outdated-machine", "outdated-machine"]);
  });
});
