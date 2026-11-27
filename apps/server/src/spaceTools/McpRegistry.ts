/**
 * `spaceTools.mcp.search`: a Space's managers search the official MCP registry for drafts of the
 * "Add MCP server" form. The Hub asks the registry (one place to check its answer, one cache for
 * every client); nothing found here is saved or run. T3CODE_MCP_REGISTRY_URL=off turns it off.
 */
import { type SpaceMcpSearch, type SpaceMcpSearchInput, SpaceToolError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";

import { registryResults } from "./mcpRegistryRules.ts";
import * as SpaceTools from "./SpaceTools.ts";

export class McpRegistry extends Context.Service<
  McpRegistry,
  {
    readonly search: (input: SpaceMcpSearchInput) => Effect.Effect<SpaceMcpSearch, SpaceToolError>;
  }
>()("t3/spaceTools/McpRegistry") {}

const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 200;

const unavailable = (message: string) =>
  new SpaceToolError({ reason: "registry-unavailable", message });

export const make = Effect.fn("McpRegistry.make")(function* (baseUrl: string | undefined) {
  const tools = yield* SpaceTools.SpaceTools;
  const client = yield* HttpClient.HttpClient;
  // Every Space asks the same public registry, so one answer serves all of them.
  const cache = new Map<string, { readonly at: number; readonly answer: SpaceMcpSearch }>();

  const ask = (query: string) =>
    client
      .execute(
        HttpClientRequest.get(`${baseUrl}/v0/servers`, {
          urlParams: { search: query, limit: "50", version: "latest" },
        }),
      )
      .pipe(
        Effect.flatMap((response): Effect.Effect<unknown, unknown> =>
          response.status >= 200 && response.status < 300
            ? response.json
            : Effect.fail(response.status),
        ),
        Effect.timeout("8 seconds"),
        Effect.mapError(() => unavailable("The MCP registry did not answer. Try again later.")),
        Effect.flatMap((json) => {
          const results = registryResults(json);
          return results === undefined
            ? Effect.fail(unavailable("The MCP registry answered something unexpected."))
            : Effect.succeed({ results });
        }),
      );

  const search = Effect.fn("McpRegistry.search")(function* (input: SpaceMcpSearchInput) {
    const listed = yield* tools.list({ spaceId: input.spaceId });
    if (!listed.canManage) {
      return yield* new SpaceToolError({
        reason: "forbidden",
        message: "Only those who manage this Space's MCP servers search the registry.",
      });
    }
    if (baseUrl === undefined) {
      return yield* unavailable("This Hub does not search the MCP registry.");
    }
    const query = input.query.trim().toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(query);
    if (cached !== undefined && now - cached.at < CACHE_MS) return cached.answer;
    const answer = yield* ask(query);
    cache.delete(query);
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(query, { at: now, answer });
    return answer;
  });

  return McpRegistry.of({ search });
});

export const layer = Layer.effect(
  McpRegistry,
  Effect.gen(function* () {
    const configured = yield* Config.String("T3CODE_MCP_REGISTRY_URL").pipe(
      Config.withDefault(MCP_REGISTRY_URL),
    );
    const trimmed = configured.trim().replace(/\/+$/u, "");
    return yield* make(trimmed === "" || trimmed === "off" ? undefined : trimmed);
  }),
);
