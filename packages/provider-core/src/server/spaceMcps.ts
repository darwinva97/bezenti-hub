import type { SecretEnv, SpaceMcpConfig, SpaceMcpLaunch } from "@t3tools/contracts";

export interface ResolvedSpaceMcp {
  readonly name: string;
  readonly config: SpaceMcpConfig;
}

const REFERENCE = /\$\{([^}]*)\}/gu;

/**
 * A Space's MCP servers with each `${NAME}` filled in from the session's own `secretEnv`, on the
 * machine that starts the process. A server naming a value the session lacks is dropped whole:
 * it never starts with an empty one.
 */
export const resolveSpaceMcps = (
  launches: ReadonlyArray<SpaceMcpLaunch> | undefined,
  secretEnv: SecretEnv | undefined,
): {
  readonly ready: ReadonlyArray<ResolvedSpaceMcp>;
  readonly dropped: ReadonlyArray<string>;
} => {
  const values = new Map((secretEnv?.variables ?? []).map((v) => [v.name, v.value] as const));
  const ready: Array<ResolvedSpaceMcp> = [];
  const dropped: Array<string> = [];
  for (const launch of launches ?? []) {
    let missing = false;
    const fill = (text: string) =>
      text.replace(REFERENCE, (_whole, name: string) => {
        const value = values.get(name);
        if (value === undefined) missing = true;
        return value ?? "";
      });
    const fillMap = (map: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(map).map(([key, value]) => [key, fill(value)]));
    const config: SpaceMcpConfig =
      launch.config.transport === "stdio"
        ? {
            transport: "stdio",
            command: launch.config.command,
            args: launch.config.args.map(fill),
            env: fillMap(launch.config.env),
          }
        : {
            transport: "http",
            url: launch.config.url,
            headers: fillMap(launch.config.headers),
          };
    if (missing) dropped.push(launch.name);
    else ready.push({ name: launch.name, config });
  }
  return { ready, dropped };
};
