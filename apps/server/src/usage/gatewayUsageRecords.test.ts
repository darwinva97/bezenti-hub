import { assert, describe, it } from "@effect/vitest";
import { UsageDay } from "@t3tools/contracts";

import { gatewayUsageRecord } from "./gatewayUsageRecords.ts";
import { gatewayWindowOf } from "./hubGatewayUsage.ts";

const request = (driver: string, shape: string) => ({
  usageId: "u1",
  at: "2026-08-01T10:00:00.000Z",
  shape,
  model: "m",
  threadId: "t1",
  driver,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: null,
  cacheWriteTokens: null,
});

describe("the Hub turns' gateway records (ticket 16)", () => {
  it("names the provider by the session's driver, else by the request's dialect", () => {
    assert.equal(gatewayUsageRecord(request("pi", "openai"))?.provider, "pi");
    assert.equal(gatewayUsageRecord(request("claudeAgent", "anthropic"))?.provider, "claude");
    assert.equal(gatewayUsageRecord(request("", "anthropic"))?.provider, "claude");
    assert.equal(gatewayUsageRecord(request("", "openai"))?.provider, "codex");
    // A Thread that changed driver: its request's dialect decides.
    assert.equal(gatewayUsageRecord(request("pi", "anthropic"))?.provider, "claude");
    // Neither tells: not guessed.
    assert.isUndefined(gatewayUsageRecord(request("", "gemini")));
    assert.isUndefined(gatewayUsageRecord({ ...request("codex", "openai"), at: "not a time" }));
  });

  it("reads a window a day wider each side, or the hourly instants as given", () => {
    assert.deepEqual(
      gatewayWindowOf({
        timeZone: "Europe/Madrid",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-02"),
      }),
      { fromAt: "2026-07-31T00:00:00.000Z", toAt: "2026-08-04T00:00:00.000Z" },
    );
    assert.deepEqual(
      gatewayWindowOf({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-01"),
        resolution: "hour",
        sinceTime: "2026-08-01T10:00:00.000Z",
        untilTime: "2026-08-01T12:00:00.000Z",
      }),
      { fromAt: "2026-08-01T10:00:00.000Z", toAt: "2026-08-01T12:00:00.000Z" },
    );
  });
});
