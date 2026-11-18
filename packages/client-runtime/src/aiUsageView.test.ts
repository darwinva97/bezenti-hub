// @effect-diagnostics globalDate:off -- the Usage range is calendar days (UTC) computed from the clock the screen reads.
import type { AiUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dayBefore,
  formatSharePercent,
  formatTokens,
  formatUsd,
  groupUsage,
  threadNoGatewayUsage,
  uncountedUsage,
  usageNotes,
} from "./aiUsageView.ts";

const totals = (requests: number, input = 0, output = 0) => ({
  requests,
  failedRequests: 0,
  unknownRequests: 0,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const summary = {
  fromDay: "2026-11-01",
  toDay: "2026-11-02",
  scope: "all",
  rows: [
    {
      day: "2026-11-02",
      userId: "ada",
      spaceId: "acme",
      accountId: "a1",
      model: "m",
      ...totals(2, 20, 10),
      estimatedUsd: 0.25,
    },
    {
      day: "2026-11-01",
      userId: "ada",
      spaceId: "acme",
      accountId: "a1",
      model: "m",
      ...totals(1, 11, 7),
      estimatedUsd: 0.5,
    },
    {
      day: "2026-11-02",
      userId: "gus",
      spaceId: "globex",
      accountId: null,
      model: null,
      ...totals(5),
      estimatedUsd: null,
    },
  ],
  totals: totals(8, 31, 17),
  labels: {
    users: [{ id: "ada", name: "Ada" }],
    spaces: [
      { id: "acme", name: "Acme" },
      { id: "globex", name: "Globex" },
    ],
    accounts: [{ id: "a1", name: null, provider: "claude" }],
  },
  truncated: false,
  retentionDays: 90,
} as unknown as AiUsageSummary;

describe("groupUsage", () => {
  it("adds rows up per day, newest first", () => {
    const days = groupUsage(summary, "day");
    expect(days.map((group) => [group.key, group.totals.requests])).toEqual([
      ["2026-11-02", 7],
      ["2026-11-01", 1],
    ]);
  });

  it("names Users, Spaces and accounts, most requests first, hiding what it may not name", () => {
    expect(
      groupUsage(summary, "user").map((group) => [group.label, group.totals.requests]),
    ).toEqual([
      ["Removed User", 5],
      ["Ada", 3],
    ]);
    expect(groupUsage(summary, "space").map((group) => group.label)).toEqual(["Globex", "Acme"]);
    expect(groupUsage(summary, "account").map((group) => group.label)).toEqual([
      "No account reached",
      "Claude account",
    ]);
  });

  // Grants ticket 05: a group with no priced row has no estimate, never a zero.
  it("adds up the estimate of the priced rows, and gives none where nothing is priced", () => {
    expect(groupUsage(summary, "user").map((group) => [group.label, group.estimatedUsd])).toEqual([
      ["Removed User", null],
      ["Ada", 0.75],
    ]);
    expect(groupUsage(summary, "day").map((group) => group.estimatedUsd)).toEqual([0.25, 0.5]);
  });
});

describe("formatting", () => {
  it("shortens token counts", () => {
    expect(
      [0, 999, 1_000, 1_234, 15_600, 250_000, 3_400_000, 7_000_000_000].map(formatTokens),
    ).toEqual(["0", "999", "1k", "1.2k", "15.6k", "250k", "3.4M", "7B"]);
  });

  it("says what is unknown or failed, and nothing when all is well", () => {
    expect(usageNotes(totals(3))).toEqual([]);
    expect(usageNotes({ ...totals(3), unknownRequests: 1, failedRequests: 2 })).toEqual([
      "1 request without token counts",
      "2 failed",
    ]);
  });

  it("says what it cannot count, naming the direct-credential accounts (ticket 16)", () => {
    const general = uncountedUsage([]);
    expect(general).toHaveLength(3);
    expect(general[0]).toContain("direct credential");
    expect(general[1]).toContain("own login");
    const named = uncountedUsage(["Grok direct", "Gemini key"]);
    expect(named[0]).toContain("(Grok direct, Gemini key)");
  });

  it("says a Thread had no gateway request, as far as the viewer may see", () => {
    expect(threadNoGatewayUsage("all")).toMatch(/^No request of this Thread went through/u);
    expect(threadNoGatewayUsage("own")).toMatch(/^No request you may see in this Thread/u);
    expect(threadNoGatewayUsage("spaces")).toContain("direct credential");
  });

  it("shows dollars to the cent, and a tiny cost as less than a cent", () => {
    expect([0, 0.004, 0.01, 0.4219, 12.5, 1234.567].map(formatUsd)).toEqual([
      "$0.00",
      "<$0.01",
      "$0.01",
      "$0.42",
      "$12.50",
      "$1,234.57",
    ]);
  });

  it("shows a quota share in whole points, and a tiny one as less than one", () => {
    expect([0, 0.3, 1, 12.46, 100].map(formatSharePercent)).toEqual([
      "0%",
      "<1%",
      "1%",
      "12%",
      "100%",
    ]);
  });

  it("counts days back from today, inclusive", () => {
    expect(dayBefore(new Date("2026-11-13T10:00:00Z"), 7)).toBe("2026-11-07");
    expect(dayBefore(new Date("2026-11-13T10:00:00Z"), 1)).toBe("2026-11-13");
  });
});
