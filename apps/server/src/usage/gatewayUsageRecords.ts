/**
 * Hub turns through the AI gateway, as usage records of the Usage dialog (ticket 16). A gateway
 * session's CLI writes its transcripts in the Thread's own provider home, which the dialog never
 * scans; the gateway's usage log (`AiUsage.threadRequests`) is read instead, so nothing is
 * counted twice.
 */
import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import type { AiUsageThreadRequest } from "../ai/AiUsage.ts";

/** Where the dialog's buckets and sources say these records come from. */
export const GATEWAY_USAGE_SOURCE = "Hub AI gateway";

/** Each gateway driver and the dialect it speaks to the gateway. */
const DRIVERS: Readonly<Record<string, { provider: UsageProviderKind; shape: string }>> = {
  claudeAgent: { provider: "claude", shape: "anthropic" },
  codex: { provider: "codex", shape: "openai" },
  opencode: { provider: "opencode", shape: "openai" },
  pi: { provider: "pi", shape: "openai" },
};

/** Without the Thread's driver (or with one of another dialect), the shape: Claude's or Codex's. */
const PROVIDER_OF_SHAPE: Readonly<Record<string, UsageProviderKind>> = {
  anthropic: "claude",
  openai: "codex",
};

/** One request as a record; undefined when its provider or time cannot be told. */
export const gatewayUsageRecord = (request: AiUsageThreadRequest): UsageRecord | undefined => {
  const driver = DRIVERS[request.driver];
  const provider =
    driver !== undefined && driver.shape === request.shape
      ? driver.provider
      : PROVIDER_OF_SHAPE[request.shape];
  const timestampMs = Date.parse(request.at);
  if (provider === undefined || Number.isNaN(timestampMs)) return undefined;
  const input = request.inputTokens ?? 0;
  const cacheRead = request.cacheReadTokens ?? 0;
  return {
    provider,
    timestampMs,
    model: request.model,
    sessionId: request.threadId,
    totals: {
      // Claude reports input without the cache; OpenAI and Gemini count the cache inside it.
      uncachedInputTokens: request.shape === "anthropic" ? input : Math.max(0, input - cacheRead),
      cachedInputTokens: cacheRead,
      cacheCreationTokens: request.cacheWriteTokens ?? 0,
      outputTokens: request.outputTokens ?? 0,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: `ai-gateway:${request.usageId}`,
  };
};
