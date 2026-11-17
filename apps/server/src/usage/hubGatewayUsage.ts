/**
 * The Usage dialog's summary on the Hub, with its turns through the AI gateway (ticket 16): read
 * from the gateway's usage log for what the session may see (AiUsage's own rules), then bucketed
 * and priced with the transcripts. A failure to read the log leaves the transcripts' summary.
 */
import type { UsageSummary, UsageSummaryInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as AiUsage from "../ai/AiUsage.ts";
import { gatewayUsageRecord } from "./gatewayUsageRecords.ts";
import type * as UsageService from "./UsageService.ts";

const DAY_MS = 86_400_000;

/** The instants the window may reach in any time zone: a day of slack each side. */
export const gatewayWindowOf = (input: UsageSummaryInput) => {
  const since =
    input.resolution === "hour" && input.sinceTime !== undefined
      ? Date.parse(input.sinceTime)
      : Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS;
  const until =
    input.resolution === "hour" && input.untilTime !== undefined
      ? Date.parse(input.untilTime)
      : Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS;
  if (Number.isNaN(since) || Number.isNaN(until)) return undefined;
  return {
    fromAt: DateTime.formatIso(DateTime.makeUnsafe(since)),
    toAt: DateTime.formatIso(DateTime.makeUnsafe(until)),
  };
};

export const withHubGatewayUsage =
  (usage: UsageService.UsageService["Service"], aiUsage: AiUsage.AiUsage["Service"]) =>
  (summary: UsageSummary, input: UsageSummaryInput) =>
    Effect.gen(function* () {
      const window = gatewayWindowOf(input);
      if (window === undefined) return summary;
      const requests = yield* aiUsage
        .threadRequests(window)
        .pipe(
          Effect.catch((error) =>
            (error.reason === "forbidden"
              ? Effect.void
              : Effect.logWarning("Usage: could not read the AI gateway's usage", { error })
            ).pipe(Effect.as([])),
          ),
        );
      const records = requests.flatMap((request) => {
        const record = gatewayUsageRecord(request);
        return record === undefined ? [] : [record];
      });
      return yield* usage.withGatewayRecords(summary, input, records);
    });
