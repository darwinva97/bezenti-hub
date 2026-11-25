// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources to list its doors.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  EnvironmentHttpApi,
  SecretEnv,
  VaultEntry,
  VaultThreadVariable,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import type * as SchemaAST from "effect/SchemaAST";
import { describe, expect, it } from "@effect/vitest";
import * as HttpApi from "effect/http-api/HttpApi";
import { Tool } from "effect/ai";

import { INSTALLATION_RPC_METHODS } from "@t3tools/contracts";

import {
  AI_ACCOUNT_SIGN_IN_RULES,
  AMBIENT_COOKIE_RULES,
  HTTP_ENDPOINT_RULES,
  IDENTITY_DOORS,
  KEYCLOAK_SESSION_CREDENTIALS,
  MCP_TOOL_RULES,
  RAW_ROUTE_RULES,
} from "./DoorRules.ts";
import { spaceAccessForRpcMethod } from "./RpcSpaceAccess.ts";

const SRC = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const sources = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !/\.test(kit)?\.ts$|\.testkit\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

const files = sources(SRC).map((file) => ({
  file: NodePath.relative(SRC, file).replaceAll("\\", "/"),
  text: NodeFS.readFileSync(file, "utf8"),
}));

/** `METHOD path` of every raw route, as its source names it (`file: METHOD path`). */
const rawRoutes = files.flatMap(({ file, text }) => [
  ...Array.from(
    text.matchAll(/\.add\(\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|\*)",\s*([^,\n]+),/g),
    (match) => `${file}: ${match[1]} ${match[2]!.trim()}`,
  ),
  ...Array.from(
    text.matchAll(/McpServer\.layerHttp\(\{[^}]*?path:\s*("[^"]+")/gs),
    (match) => `${file}: * ${match[1]}`,
  ),
  // A global middleware sees every request before any route, and may answer it itself.
  ...(/HttpRouter\.middleware\(/.test(text) ? [`${file}: middleware`] : []),
]);

// Every module that makes MCP tools, loaded: the tool names come from the Tool objects themselves.
const toolModules = files.filter(({ text }) => /Tool\.make\(/.test(text));
const mcpTools = (
  await Promise.all(
    toolModules.map(({ file }) => import(NodeURL.pathToFileURL(NodePath.join(SRC, file)).href)),
  )
).flatMap((module: Record<string, unknown>) =>
  Object.values(module).flatMap((value) => {
    if (Tool.isUserDefined(value)) return [value.name];
    const tools = (value as { readonly tools?: unknown } | null)?.tools;
    return tools !== null && typeof tools === "object"
      ? Object.values(tools).flatMap((tool) => (Tool.isUserDefined(tool) ? [tool.name] : []))
      : [];
  }),
);

const endpoints = (() => {
  const found: Array<string> = [];
  HttpApi.reflect(EnvironmentHttpApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => found.push(`${group.identifier}.${endpoint.identifier}`),
  });
  return found;
})();

/** Every field name a schema can carry, at any depth and in any union member. */
const successFields = (
  ast: SchemaAST.AST,
  into: Set<string> = new Set(),
  seen: Set<SchemaAST.AST> = new Set(),
): Set<string> => {
  if (seen.has(ast)) return into;
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      for (const property of ast.propertySignatures) {
        into.add(String(property.name));
        successFields(property.type, into, seen);
      }
      break;
    case "Arrays":
      for (const element of [...ast.elements, ...ast.rest]) successFields(element, into, seen);
      break;
    case "Union":
      for (const member of ast.types) successFields(member, into, seen);
      break;
    case "Suspend":
      successFields(ast.thunk(), into, seen);
      break;
  }
  return into;
};

/** Every object schema, at any depth, that has a field named `name`. */
const objectsWith = (
  ast: SchemaAST.AST,
  name: string,
  into: Set<SchemaAST.AST> = new Set(),
  seen: Set<SchemaAST.AST> = new Set(),
): Set<SchemaAST.AST> => {
  if (seen.has(ast)) return into;
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      if (ast.propertySignatures.some((property) => property.name === name)) into.add(ast);
      for (const property of ast.propertySignatures) objectsWith(property.type, name, into, seen);
      break;
    case "Arrays":
      for (const element of [...ast.elements, ...ast.rest]) objectsWith(element, name, into, seen);
      break;
    case "Union":
      for (const member of ast.types) objectsWith(member, name, into, seen);
      break;
    case "Suspend":
      objectsWith(ast.thunk(), name, into, seen);
      break;
  }
  return into;
};

const undeclared = (doors: ReadonlyArray<string>, rules: Readonly<Record<string, unknown>>) =>
  [...new Set(doors)].filter((door) => !Object.hasOwn(rules, door)).toSorted();
const stale = (doors: ReadonlyArray<string>, rules: Readonly<Record<string, unknown>>) =>
  Object.keys(rules)
    .filter((door) => !doors.includes(door))
    .toSorted();

describe("every door of the Hub declares its rule", () => {
  it("lists every HTTP endpoint, raw route and MCP tool in DoorRules", () => {
    expect(endpoints.length).toBeGreaterThan(50);
    expect(rawRoutes.length).toBeGreaterThan(10);
    expect(mcpTools.length).toBeGreaterThan(50);
    expect({
      endpoints: undeclared(endpoints, HTTP_ENDPOINT_RULES),
      rawRoutes: undeclared(rawRoutes, RAW_ROUTE_RULES),
      mcpTools: undeclared(mcpTools, MCP_TOOL_RULES),
    }).toEqual({ endpoints: [], rawRoutes: [], mcpTools: [] });
    // A door that is gone leaves no entry behind.
    expect({
      endpoints: stale(endpoints, HTTP_ENDPOINT_RULES),
      rawRoutes: stale(rawRoutes, RAW_ROUTE_RULES),
      mcpTools: stale(mcpTools, MCP_TOOL_RULES),
    }).toEqual({ endpoints: [], rawRoutes: [], mcpTools: [] });
  });

  it("names, for a door that shares an RPC's rule, an RPC that has one", () => {
    const twins = [
      ...Object.values(HTTP_ENDPOINT_RULES),
      ...Object.values(RAW_ROUTE_RULES),
      ...Object.values(MCP_TOOL_RULES),
    ].flatMap((rule) => ("rpc" in rule ? [rule.rpc] : []));
    expect(twins.filter((method) => spaceAccessForRpcMethod(method) === undefined)).toEqual([]);
  });

  it("reads a Secret's value only to deliver and mask it; a Variable's also to list it (owned-resources 01)", () => {
    // No door reveals: the HTTP one is gone, and nothing defines or calls a reveal.
    expect(
      files.filter(({ text }) => /\.reveal\(|\.authorizeReveal\(|vault\.reveal/u.test(text)),
    ).toEqual([]);
    expect(Object.keys(HTTP_ENDPOINT_RULES).filter((name) => /reveal/iu.test(name))).toEqual([]);
    // Who opens the Vault values' store: delivery and the masker read it; Vaults reads it for a
    // Variable (`vault.readVariables`) and, at its start, to give a former Secret link its own
    // copy (`unshareValues`); the rest remove only.
    const holders = files
      .filter(({ text }) =>
        /(?:yield\* |serviceOption\()ServerSecretStore\.VaultValueStore\b/u.test(text),
      )
      .map(({ file }) => file);
    expect(holders.toSorted()).toEqual([
      "spaces/InstallationUserService.ts",
      "spaces/OrganizationLifecycle.ts",
      "vaults/SecretDelivery.ts",
      "vaults/SecretMasker.ts",
      "vaults/Vaults.ts",
    ]);
    // A deleted Organization's and a removed User's values are removed, never read (owned-resources 10).
    for (const file of ["spaces/OrganizationLifecycle.ts", "spaces/InstallationUserService.ts"]) {
      const text = files.find((candidate) => candidate.file === file)!.text;
      expect(text, file).not.toMatch(/vaultValues\.value\.get\(/u);
    }
    expect(
      [...Object.keys(MCP_TOOL_RULES), ...Object.keys(RAW_ROUTE_RULES)].filter((name) =>
        /vault|reveal/iu.test(name),
      ),
    ).toEqual([]);
    // No WS answer about Vaults has a field that could carry a Secret's value: a `value` is a
    // Variable's, in VaultEntry (Vaults.shown) and in a Thread's variables (owned-resources 05:
    // Vaults.variableValue, for Variables alone; Vaults.test.ts and EffectiveVaults.test.ts).
    const vaultRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      rpc._tag.startsWith("vaults."),
    );
    // Grants ticket 07: `vaults.allow` went (allowances became Grants).
    expect(vaultRpcs.length).toBe(13);
    expect(
      vaultRpcs
        .filter((rpc) => objectsWith(rpc.successSchema.ast, "value").has(VaultEntry.ast))
        .map((rpc) => rpc._tag)
        .toSorted(),
    ).toEqual(["vaults.entries.list", "vaults.entries.put"]);
    for (const rpc of vaultRpcs) {
      expect(
        [...objectsWith(rpc.successSchema.ast, "value")].filter(
          (holder) => holder !== VaultEntry.ast && holder !== VaultThreadVariable.ast,
        ),
        rpc._tag,
      ).toEqual([]);
      // Spec 5 ticket 03: nor the id of one (EffectiveVaults' are for delivery alone).
      expect(successFields(rpc.successSchema.ast), rpc._tag).not.toContain("valueId");
    }
    // The effective set with value ids is for delivery (ticket 04) alone: the only door that
    // reaches it is the Thread's names, which strip them (EffectiveVaults.threadEnvironment). A
    // Project's move asks only which Vaults it loses, by name (ticket 07).
    const effectiveUsers = files
      .filter(({ text }) => /vaults\/EffectiveVaults\.ts"/u.test(text))
      .map(({ file }) => file);
    expect(effectiveUsers.toSorted()).toEqual([
      "orchestration-v2/runtimeLayer.ts",
      "project/ProjectService.ts",
      "server.ts",
      "ws.ts",
    ]);
    for (const file of ["ws.ts", "project/ProjectService.ts", "orchestration-v2/runtimeLayer.ts"]) {
      const text = files.find((candidate) => candidate.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/\.forThread\b/u);
    }
  });

  it("keeps Secret providers' scopes and «Test connection» the Owner's, and never a credential (Vaults ticket 03)", () => {
    const ownerOnly = [
      WS_METHODS.secretProvidersTest,
      WS_METHODS.secretProvidersImpact,
      WS_METHODS.secretProvidersScopesList,
      WS_METHODS.secretProvidersScopesPut,
      WS_METHODS.secretProvidersScopesDelete,
      WS_METHODS.secretProvidersScopesAllow,
    ];
    // Installation RPCs: refused before any handler to anyone but an unlimited Owner's session.
    for (const method of ownerOnly) {
      expect(INSTALLATION_RPC_METHODS as ReadonlyArray<string>, method).toContain(method);
      expect(spaceAccessForRpcMethod(method), method).toBe("installation");
    }
    // A Vault's usable scopes: decided by Vaults for the Vault's editors.
    expect(spaceAccessForRpcMethod(WS_METHODS.vaultsProviderScopes)).toMatchObject({
      unscoped: expect.stringContaining("Vaults"),
    });
    for (const rpc of WsRpcGroup.requests.values()) {
      if (
        !rpc._tag.startsWith("secretProviders.") &&
        rpc._tag !== WS_METHODS.vaultsProviderScopes
      ) {
        continue;
      }
      for (const credential of ["value", "credential", "token", "password", "secret", "config"]) {
        expect(successFields(rpc.successSchema.ast), `${rpc._tag} ${credential}`).not.toContain(
          credential,
        );
      }
    }
    // A scope's `auth` (role, mount…) goes only to the Owner, never to a Vault's editors.
    const editors = [...WsRpcGroup.requests.values()].find(
      (rpc) => rpc._tag === WS_METHODS.vaultsProviderScopes,
    );
    expect(successFields(editors!.successSchema.ast)).not.toContain("auth");
  });

  it("reads a Vault value in two places only: delivery and masking (spec 5 ticket 09, owned-resources 01)", () => {
    // Every module that holds the values' store, and why. A new one fails here.
    const holders = files
      .filter(({ text }) => /\bVaultValueStore\b/u.test(text))
      .map(({ file }) => file)
      .filter((file) => !["auth/ServerSecretStore.ts", "auth/MasterKeyFile.ts"].includes(file));
    expect(holders.toSorted()).toEqual([
      "persistence/Migrations/111_Vaults.ts", // a comment: where values live
      "spaces/InstallationUserService.ts", // removes a removed User's values
      "spaces/OrganizationLifecycle.ts", // removes an Organization's values
      "vaults/EffectiveVaults.ts", // a comment: value ids, read by delivery alone
      "vaults/SecretDelivery.ts", // reads: the environment of a process that starts
      "vaults/SecretMasker.ts", // reads: what to show as [NAME]
      "vaults/VaultReachLoss.ts", // removes values no row holds
      "vaults/Vaults.ts", // reads: Variables (shown, variableValue); copies a former link's
    ]);
    const readers = files
      .filter(({ file }) => holders.includes(file))
      .filter(({ text }) => /\b(values|vaultValues)(\.value)?\s*\.get\(/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual([
      "vaults/SecretDelivery.ts",
      "vaults/SecretMasker.ts",
      "vaults/Vaults.ts",
    ]);
    // Ticket 02: values read from Secret providers, kept sealed only to mask them. Delivery seals
    // them, the masker reads them, DeliveredValues removes them with their Thread: nothing else.
    const deliveredHolders = files
      .filter(({ text }) => /\bDeliveredValueStore\b/u.test(text))
      .map(({ file }) => file)
      .filter((file) => file !== "auth/ServerSecretStore.ts");
    expect(deliveredHolders.toSorted()).toEqual([
      "vaults/DeliveredValues.ts", // removes a deleted Thread's, sweeps at the start
      "vaults/SecretDelivery.ts", // seals what a process receives
      "vaults/SecretMasker.ts", // reads: what to show as [NAME]
      "vaults/deliveredValueId.ts", // a comment: where they are read back from
    ]);
    // In Vaults, a value is read for a Variable shown (`shown`, its class checked), nothing else:
    // no reveal (owned-resources 01), no copy (owned-resources 03). `unshareValues` copies a
    // value a former Secret link shares under a new id, never reading it out.
    const vaults = files.find(({ file }) => file === "vaults/Vaults.ts")?.text ?? "";
    // `shown` (vaults.entries.*) and `variableValue` (a Thread's panel), both Variables alone.
    expect(vaults.match(/\breadValue\(/gu)?.length).toBe(2);
    expect(vaults.match(/\bvalues\.get\(/gu)?.length).toBe(2);
    expect(vaults).toMatch(
      /classOf\(row\) === "variable" && valueIdOf\(row\) !== null\s*\?\s*readValue\(/u,
    );
    // The Vaults' tables: the modules of the Vaults and their migrations, nothing else.
    expect(
      files
        .filter(({ text }) => /\b(vault_entries|thread_secret_values)\b/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual([
      "ai/aiCredentialValue.ts", // a comment: how a direct AI credential is named there
      "grants/Grants.ts", // names only: the Secrets a lent group's lender is told to rotate
      "identity/IdentityTokens.ts", // names only: whether any identity entry exists (question 12)
      "persistence/Migrations/111_Vaults.ts",
      "persistence/Migrations/115_VaultReachLoss.ts",
      "persistence/Migrations/116_ThreadSecretValues.ts",
      "persistence/Migrations/119_VaultEntryClass.ts",
      "persistence/Migrations/120_VaultProviderEntries.ts",
      "persistence/Migrations/122_VaultEntryDelivery.ts",
      "persistence/Migrations/123_WorkloadIdentity.ts",
      "persistence/Migrations/141_VaultEntriesSealed.ts",
      "persistence/Migrations/142_VaultGroups.ts",
      "persistence/Migrations/144_OwnedResourcesGone.ts",
      "vaults/DeliveredValues.ts",
      "vaults/EffectiveVaults.ts",
      "vaults/SecretDelivery.ts",
      "vaults/SecretMasker.ts",
      "vaults/SecretProviderScopes.ts", // names only: the entries a scope change would break
      "vaults/ThreadSecretValues.ts",
      "vaults/VaultReachLoss.ts",
      "vaults/Vaults.ts",
      "vaults/deliveredValueId.ts", // a comment: how a provider's value is named there
    ]);
    // A direct AI account's credential (spec 4 ticket 07) is a value too: read in AiAccounts,
    // handed only to the session manager opening a provider process (issueDirect), which
    // remembers it for masking first; on the wire it is a variable of `secretEnv`, whose
    // `aiCredential` only names it.
    const directReaders = files
      .filter(({ text }) => /\.directCredential\(/u.test(text))
      .map(({ file }) => file);
    expect(directReaders.toSorted()).toEqual(["ai/AiGatewaySessions.ts"]);
    const issuers = files
      .filter(({ text }) => /\.issueDirect\(/u.test(text))
      .map(({ file }) => file);
    expect(issuers.toSorted()).toEqual(["orchestration-v2/ProviderSessionManager.ts"]);
    const sessions = files.find(({ file }) => file === "ai/AiGatewaySessions.ts")?.text ?? "";
    expect(sessions).toMatch(/\.directCredential\([\s\S]*\.remember\([\s\S]*DirectSession/u);
    expect(SecretEnv.fields.aiCredential.ast._tag).toBe("String");
    // No WS answer, of any RPC, can carry a process's secrets.
    for (const rpc of WsRpcGroup.requests.values()) {
      expect(successFields(rpc.successSchema.ast), rpc._tag).not.toContain("secretEnv");
    }
  });

  it("delivers secret values only where a process starts (spec 5 ticket 04)", () => {
    // SecretDelivery reads values: each module that reaches it starts a process of a Thread
    // (a provider session, a shell, a setup script), or asks only whether it has secrets.
    const deliveryUsers = files
      .filter(({ text }) => /vaults\/SecretDelivery\.ts"/u.test(text))
      .map(({ file }) => file);
    expect(deliveryUsers.toSorted()).toEqual([
      "environment/ThreadWorkspace.ts",
      // Vaults ticket 07: re-signs identity files held by running processes, nothing else.
      "identity/IdentityRefresher.ts",
      // list_secret_names (spec 5 ticket 06): names only, through `turnNames`.
      "mcp/OrchestratorMcpService.ts",
      "orchestration-v2/Orchestrator.ts",
      "orchestration-v2/ProviderSessionManager.ts",
      "project/ProjectSetupScriptRunner.ts",
      "server.ts",
    ]);
    const refresher =
      files.find(({ file }) => file === "identity/IdentityRefresher.ts")?.text ?? "";
    expect([...refresher.matchAll(/delivery\.value\s*\.(\w+)/gu)].map((m) => m[1])).toEqual([
      "refreshIdentityFiles",
    ]);
    const orchestrator = files.find(({ file }) => file === "orchestration-v2/Orchestrator.ts");
    expect(orchestrator?.text).not.toMatch(/\.(forProcess|forTurn)\(/u);
    const mcp = files.find(({ file }) => file === "mcp/OrchestratorMcpService.ts")?.text ?? "";
    const mcpCalls = [...mcp.matchAll(/secretDelivery\.value\s*\.(\w+)/gu)].map((m) => m[1]);
    expect(mcpCalls.length).toBeGreaterThan(0);
    expect(mcpCalls.every((call) => call === "turnNames")).toBe(true);
    // On the wire, values go only with the calls that start a process.
    const wire = files.find(({ file }) => file === "environment/RemoteExecutorWire.ts")?.text ?? "";
    expect(wire.match(/secretEnv: Schema\.optionalKey\(SecretEnv\)/gu)?.length).toBe(3);
  });

  it("keeps AI accounts' credentials in the Hub: only AiAccounts reads them, no answer carries one", () => {
    // The store's folder for them is read only by AiAccounts, which writes them into CLIProxyAPI,
    // and by the masker, which hides a direct credential a Thread's process received (ticket 07).
    const readers = files
      .filter(({ text }) => /AiAccountCredentialStore\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual([
      "ai/AiAccounts.ts",
      "auth/ServerSecretStore.ts",
      "vaults/SecretMasker.ts",
    ]);
    // No HTTP, raw route or MCP door for AI accounts: only the WS RPCs.
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
      ].filter((name) => /aiAccount|ai-account|ai_account/iu.test(name)),
    ).toEqual([]);
    // No WS answer about AI accounts has a field that could carry a credential.
    const accountRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      rpc._tag.startsWith("aiAccounts."),
    );
    expect(accountRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "aiAccounts.create",
      "aiAccounts.delete",
      "aiAccounts.importCliproxy",
      "aiAccounts.importVertex",
      "aiAccounts.list",
      "aiAccounts.login.complete",
      "aiAccounts.login.start",
      "aiAccounts.picker",
      "aiAccounts.reorder",
      "aiAccounts.update",
    ]);
    for (const rpc of accountRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      for (const credential of ["apiKey", "key", "credential", "secret", "token", "value"]) {
        expect(fields, rpc._tag).not.toContain(credential);
      }
    }
  });

  it("reaches CLIProxyAPI's API only through the gateway layer, with a gateway key and no cookie (spec 4 ticket 04)", () => {
    // The Hub's client key: written into its config, used by the management client and the
    // gateway layer, nothing else.
    const clientKeyUsers = files
      .filter(({ text }) => /\.clientKey\b/u.test(text))
      .map(({ file }) => file)
      .toSorted();
    expect(clientKeyUsers).toEqual([
      "ai/AiGatewayProxy.ts",
      "ai/CliproxyManagement.ts",
      "ai/cliproxyConfig.ts",
    ]);
    const gateway = Object.keys(RAW_ROUTE_RULES).filter((door) => door.startsWith("ai/"));
    expect(gateway).toEqual(["ai/AiGatewayRoute.ts: * `${AI_GATEWAY_ROUTE_PREFIX}/*`"]);
    expect(AMBIENT_COOKIE_RULES[gateway[0]!]).toHaveProperty("refused");
    // Keys are read and written by AiGatewayKeys alone (the migrations aside): no other door.
    // A move or a removal revokes them through it, inside its own transaction (ticket 11).
    expect(
      files
        .filter(({ text }) => /\bai_gateway_keys\b/u.test(text))
        .map(({ file }) => file)
        // The door inventory names the table among the credentials (Keycloak ticket 11).
        .filter((file) => file !== "auth/DoorRules.ts")
        .toSorted(),
    ).toEqual([
      "ai/AiGatewayKeys.ts",
      "persistence/Migrations/113_AiGatewayKeys.ts",
      "persistence/Migrations/118_AiAccountReachLoss.ts",
    ]);
    // The route reads no cookie and no session: only its key headers.
    for (const file of ["ai/AiGatewayRoute.ts", "ai/AiGatewayProxy.ts"]) {
      const text = files.find((entry) => entry.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/cookie|EnvironmentAuth|SessionStore|authenticateRequest/iu);
    }
  });

  it("hands a Thread's gateway key only to its provider process (spec 4 ticket 06)", () => {
    // Thread keys are issued in one place, for a provider session about to start a process.
    expect(
      files
        .filter(({ text }) => /\.issueForThread\(/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual(["ai/AiGatewaySessions.ts"]);
    // That rule is reached by the session manager (which opens the process), the orchestrator
    // (which only asks whether a Thread needs a process of its own) and the server's wiring.
    expect(
      files
        .filter(({ text }) => /ai\/AiGatewaySessions\.ts"/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual([
      "orchestration-v2/Orchestrator.ts",
      "orchestration-v2/ProviderSessionManager.ts",
      // Asks only whether Hub turns run on AI accounts, to refuse Antigravity's Google sign-in.
      "provider/ProviderAuthService.ts",
      "server.ts",
      // Asks only the same, to keep Antigravity's login out of titles and summaries.
      "textGeneration/TextGeneration.ts",
    ]);
    const orchestrator = files.find(({ file }) => file === "orchestration-v2/Orchestrator.ts");
    expect(orchestrator?.text).not.toMatch(/\.forSession\(/u);
    for (const file of ["provider/ProviderAuthService.ts", "textGeneration/TextGeneration.ts"]) {
      const text = files.find((entry) => entry.file === file)?.text;
      expect(text, file).not.toMatch(/\.(issue|issueDirect|plan)\(/u);
    }
    // On the wire, the key goes only with `provider.openSession`.
    const wire = files.find(({ file }) => file === "environment/RemoteExecutorWire.ts")?.text ?? "";
    expect(wire.match(/aiGateway: Schema\.optionalKey\(AiGatewayAccess\)/gu)?.length).toBe(1);
    // Terminals and setup scripts never get one (a User's shell would carry the Thread's key).
    for (const file of [
      "environment/ThreadWorkspace.ts",
      "project/ProjectSetupScriptRunner.ts",
      "terminal/Manager.ts",
    ]) {
      const text = files.find((entry) => entry.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/aiGateway|AiGatewaySessions|T3_AI_GATEWAY_KEY/u);
    }
    // A machine's agents reach the gateway through its one relay, which reads no credential.
    const relay = files.find(({ file }) => file === "environments/AiGatewayRelay.ts")?.text ?? "";
    expect(relay).toMatch(/listen\(0, "127\.0\.0\.1"/u);
    expect(relay).not.toMatch(/EnvironmentAuth|ServerSecretStore|joinedHubState|\.credential\b/u);
  });

  it("hands a direct AI account credential only to its Thread's provider process (spec 4 ticket 07)", () => {
    // Read in one place, for a provider session about to start a process, and masked there.
    const readers = (pattern: RegExp) =>
      files
        .filter(({ text }) => pattern.test(text))
        .map(({ file }) => file)
        .toSorted();
    expect(readers(/\.directCredential\(/u)).toEqual(["ai/AiGatewaySessions.ts"]);
    expect(readers(/\.issueDirect\(/u)).toEqual(["orchestration-v2/ProviderSessionManager.ts"]);
    // On the wire it is one more `secretEnv` variable, named by `aiCredential`: no new field.
    const wire = files.find(({ file }) => file === "environment/RemoteExecutorWire.ts")?.text ?? "";
    expect(wire).not.toMatch(/aiCredential|directCredential/u);
    // Terminals and setup scripts never get one.
    for (const file of [
      "environment/ThreadWorkspace.ts",
      "project/ProjectSetupScriptRunner.ts",
      "terminal/Manager.ts",
      "vaults/SecretDelivery.ts",
    ]) {
      const text = files.find((entry) => entry.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/aiCredential|directCredential|issueDirect/u);
    }
    // No WS answer names a field that could carry it (the Secrets panel gets names, and a
    // Variable's `value` alone, owned-resources 05).
    const environment = [...WsRpcGroup.requests.values()].find(
      (rpc) => rpc._tag === "vaults.threadEnvironment",
    );
    expect(environment).toBeDefined();
    for (const credential of ["apiKey", "key", "credential", "secret", "token"]) {
      expect(successFields(environment!.successSchema.ast)).not.toContain(credential);
    }
  });

  it("picks and switches a Thread's AI account over WS only: the picker per Space, the switch a Thread command (spec 4 ticket 08)", () => {
    // The switch names a Thread (hidden ones answer like missing ones) and goes through the
    // Thread door (`thread.continue`, AiAccountChoice); the picker is decided for the session.
    expect(spaceAccessForRpcMethod("thread.setAiAccount")).toBe("thread");
    expect(typeof spaceAccessForRpcMethod("aiAccounts.picker")).toBe("object");
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
      ].filter((name) => /setAiAccount|picker/iu.test(name)),
    ).toEqual([]);
    // Names and model names only: never a credential.
    for (const tag of ["aiAccounts.picker", "thread.setAiAccount"]) {
      const rpc = [...WsRpcGroup.requests.values()].find((candidate) => candidate._tag === tag);
      expect(rpc, tag).toBeDefined();
      const fields = successFields(rpc!.successSchema.ast);
      for (const credential of ["apiKey", "key", "credential", "secret", "token", "value"]) {
        expect(fields, tag).not.toContain(credential);
      }
    }
  });

  it("makes, lists and revokes local CLI keys over the session's WS RPCs only: no HTTP, raw route or MCP door, the key in one answer (spec 4 ticket 10)", () => {
    const keyRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^aiGatewayKeys\./u.test(rpc._tag),
    );
    expect(keyRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "aiGatewayKeys.create",
      "aiGatewayKeys.list",
      "aiGatewayKeys.revoke",
    ]);
    // Decided in AiGatewayKeys for the session's own person (not the Owner's alone).
    for (const rpc of keyRpcs) {
      expect(typeof spaceAccessForRpcMethod(rpc._tag), rpc._tag).toBe("object");
    }
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
        ...mcpTools,
        ...endpoints,
      ].filter((name) => /gateway[-_ ]?key/iu.test(name)),
    ).toEqual([]);
    // Only `create` answers with the key; no answer carries a hash.
    for (const rpc of keyRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      expect(fields.has("key"), rpc._tag).toBe(rpc._tag === "aiGatewayKeys.create");
      for (const secret of ["hash", "keyHash", "secret", "token"]) {
        expect(fields, rpc._tag).not.toContain(secret);
      }
    }
    // The session doors are reached from the WS RPCs alone: no MCP tool module, HTTP API or
    // other door makes, lists or revokes a User's key.
    expect(
      files
        .filter(({ text }) =>
          /\.(createForSession|listForSession|revokeForSession|createForUser|listUserKeys)\(|\.listForSession\b/u.test(
            text,
          ),
        )
        .map(({ file }) => file)
        // AccessKeys has session doors of its own (access-keys ticket 01), swept below.
        .filter((file) => file !== "ai/AiGatewayKeys.ts" && file !== "ai/AccessKeys.ts")
        .toSorted(),
    ).toEqual(["ws.ts"]);
    for (const { file, text } of toolModules) {
      expect(text, file).not.toMatch(/AiGatewayKeys/u);
    }
  });

  it("makes, lists and revokes access keys over the session's WS RPCs only: no HTTP, raw route or MCP door, the key in one answer, the table AccessKeys' alone (access-keys ticket 01)", () => {
    const keyRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^accessKeys\./u.test(rpc._tag),
    );
    expect(keyRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "accessKeys.create",
      "accessKeys.list",
      "accessKeys.modelOptions",
      "accessKeys.revoke",
      "accessKeys.update",
    ]);
    // Decided in AccessKeys for the session's own person, by AccessPolicy on the key's Space.
    for (const rpc of keyRpcs) {
      expect(typeof spaceAccessForRpcMethod(rpc._tag), rpc._tag).toBe("object");
    }
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
        ...mcpTools,
        ...endpoints,
      ].filter((name) => /access[-_ ]?key/iu.test(name)),
    ).toEqual([]);
    // Only `create` answers with the key; no answer carries a hash.
    for (const rpc of keyRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      expect(fields.has("key"), rpc._tag).toBe(rpc._tag === "accessKeys.create");
      for (const secret of ["hash", "keyHash", "secret", "token"]) {
        expect(fields, rpc._tag).not.toContain(secret);
      }
    }
    // The session doors are reached from the WS RPCs alone.
    expect(
      files
        .filter(({ text }) => /\.(createForSession|listForSession|revokeForSession)\(/u.test(text))
        .filter(({ text }) => /accessKeys\./u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual(["ws.ts"]);
    for (const { file, text } of toolModules) {
      expect(text, file).not.toMatch(/AccessKeys/u);
    }
    // The table: written and read by AccessKeys alone (and created by its migration);
    // AiGatewayKeys.authorize reads a request's key through AccessKeys' exported functions.
    expect(
      files
        .filter(({ text }) => /\bai_access_keys\b/u.test(text))
        .map(({ file }) => file)
        // The door inventory names the table among the credentials (Keycloak ticket 11).
        .filter((file) => file !== "auth/DoorRules.ts")
        .toSorted(),
    ).toEqual([
      "ai/AccessKeys.ts",
      "persistence/Migrations/159_AiAccessKeys.ts",
      // Revokes the keys of Spaces deleted before access-keys ticket 07.
      "persistence/Migrations/161_AccessKeysOfGoneSpaces.ts",
    ]);
  });

  it("keeps Makita's token in the Hub: WS doors of a person's session only, no answer carries it, its store read by MakitaGitHub alone, its tables makita/'s (Makita tickets 01 to 03)", () => {
    const makitaRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^makita\./u.test(rpc._tag),
    );
    expect(makitaRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "makita.account.get",
      "makita.account.pauseAll",
      "makita.account.resumeAll",
      "makita.account.set",
      // Ticket 07: reads of what Makita does and spends, and of the viewer's Makita Threads.
      "makita.activity",
      "makita.configs.create",
      "makita.configs.delete",
      // Ticket 24: the labels of the chosen Projects' repositories, for the form.
      "makita.configs.labels",
      "makita.configs.list",
      "makita.configs.pause",
      "makita.configs.resume",
      "makita.configs.update",
      "makita.permissions.grant",
      "makita.permissions.list",
      "makita.permissions.revoke",
      // Ticket 11: the Owner approves a task's waiting push, `makita.approve`.
      "makita.tasks.approve",
      // Ticket 06: stop one task, `makita.pause` on its configuration.
      "makita.tasks.stop",
      "makita.threads",
    ]);
    // Each decided in makita/ for the session's own person, by AccessPolicy.
    for (const rpc of makitaRpcs) {
      expect(typeof spaceAccessForRpcMethod(rpc._tag), rpc._tag).toBe("object");
    }
    // No HTTP, raw route or MCP door (tickets 05+ add MCP tools with their own rules).
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
        ...endpoints,
      ].filter((name) => /makita/iu.test(name)),
    ).toEqual([]);
    // No answer has a field that could carry the token; only `set` takes one.
    for (const rpc of makitaRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      for (const secret of ["token", "secret", "hash", "tokenHash"]) {
        expect(fields, rpc._tag).not.toContain(secret);
      }
      expect(successFields(rpc.payloadSchema.ast).has("token"), rpc._tag).toBe(
        rpc._tag === "makita.account.set",
      );
    }
    // The sealed token: written by MakitaAccount, read by MakitaGitHub, nothing else.
    expect(
      files
        .filter(({ text }) => /\bMakitaTokenStore\b/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual(["auth/ServerSecretStore.ts", "makita/MakitaAccount.ts", "makita/MakitaGitHub.ts"]);
    expect(
      files
        .filter(({ text }) => /\btokens\s*\.get\(/u.test(text))
        .filter(({ file }) => file.startsWith("makita/"))
        .map(({ file }) => file),
    ).toEqual(["makita/MakitaGitHub.ts"]);
    // Makita's client never touches Source Control's credential nor its request policy.
    for (const { file, text } of files.filter(({ file }) => file.startsWith("makita/"))) {
      expect(text, file).not.toMatch(/GitHubCredentials|GitHubRest\b|PinnedGitHubCredential/u);
    }
    // The tables: named under makita/ and by their migrations; removals call makita/'s functions.
    for (const entry of [
      ["makita_account", "163_MakitaAccount"],
      ["makita_permissions", "164_MakitaPermissions"],
      ["makita_configs", "165_MakitaConfigs", "172_MakitaTriage", "173_MakitaAutonomy"],
      // Ticket 04: what the intake read and decided.
      ["makita_repo_cursors", "166_MakitaIntake"],
      ["makita_events", "166_MakitaIntake"],
      // Ticket 05: the tasks; others ask makitaRows.makitaTaskOfThread. Ticket 10: the worktree.
      [
        "makita_tasks",
        "167_MakitaTasks",
        "169_MakitaTaskWorkspace",
        "171_MakitaTaskCi",
        "172_MakitaTriage",
        "173_MakitaAutonomy",
      ],
      // Tickets 25–27: what a configuration does on its own, and each issue Makita closed.
      ["makita_issue_closes", "173_MakitaAutonomy"],
    ] as const) {
      const [table, ...migrations] = entry;
      expect(
        files
          .filter(({ text }) => new RegExp(`\\b${table}\\b`, "u").test(text))
          .map(({ file }) => file)
          .filter((file) => !file.startsWith("makita/"))
          .toSorted(),
        table,
      ).toEqual(migrations.map((migration) => `persistence/Migrations/${migration}.ts`));
    }
    for (const { file, text } of toolModules) {
      expect(text, file).not.toMatch(
        /MakitaAccount|MakitaTokenStore|MakitaPermissions|MakitaConfigs|MakitaIntake|MakitaGitHub/u,
      );
    }
    // Ticket 05: MCP tools for a Makita task's Thread only; no tool takes a repository. Ticket
    // 10: `makita_push`, only where its configuration may push. 12: its pull request and the CI
    // logs, likewise; no approve tool. 13: a merge is only requested, never made by a tool.
    // 23: a read-only search of its own repository. 24: labels from its configuration's list.
    expect(Object.keys(MCP_TOOL_RULES).filter((name) => name.startsWith("makita_"))).toEqual([
      "makita_comment",
      "makita_read_issue",
      "makita_push",
      "makita_open_pull_request",
      "makita_ci_logs",
      "makita_request_merge",
      "makita_search",
      "makita_label",
      // Ticket 26: only where its configuration may close issues; the Hub decides the close.
      "makita_close_issue",
    ]);
    expect(Object.keys(MCP_TOOL_RULES).filter((name) => /merge|approve/u.test(name))).toEqual([
      "makita_request_merge",
    ]);
    // No RPC merges or lands anything.
    expect([...WsRpcGroup.requests.keys()].filter((tag) => /merge|land/iu.test(tag))).toEqual([]);
  });

  it("links a User's GitHub account over the session's WS RPCs only: no HTTP, raw route or MCP door, the code in one answer, its tables GitHubIdentities' (Makita ticket 08)", () => {
    const identityRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^githubIdentity\./u.test(rpc._tag),
    );
    expect(identityRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "githubIdentity.get",
      "githubIdentity.linkCode",
      "githubIdentity.unlink",
    ]);
    // Decided in GitHubIdentities for the session's own person, by AccessPolicy.
    for (const rpc of identityRpcs) {
      expect(typeof spaceAccessForRpcMethod(rpc._tag), rpc._tag).toBe("object");
    }
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
        ...mcpTools,
        ...endpoints,
      ].filter((name) => /github[-_ ]?identit|link[-_ ]?code/iu.test(name)),
    ).toEqual([]);
    // Only `linkCode` answers with the code; no answer carries its hash.
    for (const rpc of identityRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      expect(fields.has("code"), rpc._tag).toBe(rpc._tag === "githubIdentity.linkCode");
      for (const secret of ["hash", "codeHash", "secret", "token"]) {
        expect(fields, rpc._tag).not.toContain(secret);
      }
    }
    // The tables: named by GitHubIdentities and its migration alone.
    for (const table of ["github_identities", "github_link_codes"]) {
      expect(
        files
          .filter(({ text }) => new RegExp(`\\b${table}\\b`, "u").test(text))
          .map(({ file }) => file)
          // The door inventory names the code among the credentials.
          .filter((file) => file !== "auth/DoorRules.ts")
          .toSorted(),
        table,
      ).toEqual(["makita/GitHubIdentities.ts", "persistence/Migrations/170_GitHubIdentities.ts"]);
    }
    for (const { file, text } of toolModules) {
      expect(text, file).not.toMatch(/GitHubIdentities/u);
    }
  });

  it("reads AI usage over one WS RPC only, counts only: no HTTP, raw route or MCP door, tables read by AiUsage alone (spec 4 ticket 05)", () => {
    const usageRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^aiUsage\./u.test(rpc._tag),
    );
    expect(usageRpcs.map((rpc) => rpc._tag)).toEqual(["aiUsage.summary"]);
    // Decided inside AiUsage.summary for the session (not the Owner's alone, so not `installation`).
    expect(typeof spaceAccessForRpcMethod("aiUsage.summary")).toBe("object");
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
      ].filter((name) => /ai[-_ ]?usage/iu.test(name)),
    ).toEqual([]);
    // No answer has a field that could carry a prompt, an answer, a key or a header.
    const fields = successFields(usageRpcs[0]!.successSchema.ast);
    for (const content of ["prompt", "messages", "content", "text", "body", "key", "headers"]) {
      expect(fields).not.toContain(content);
    }
    // The tables: AiUsage's alone, and their migrations'; GrantCaps sums a Grant's days (Grants
    // 03); migration 145 reads who used a migrated account (Grants 02); 147 backfills uncached
    // input (Grants 05); 159 adds the access key's column (access-keys 01).
    const readers = files
      .filter(({ text }) => /\bai_usage(_daily)?\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual([
      // An access key's use, for its caps and its list (access-keys tickets 04, 05).
      "ai/AccessKeyCaps.ts",
      "ai/AiUsage.ts",
      "ai/GrantCaps.ts",
      "persistence/Migrations/114_AiUsage.ts",
      "persistence/Migrations/145_AiAccountAllowancesToGrants.ts",
      "persistence/Migrations/146_AiUsageGrant.ts",
      "persistence/Migrations/147_AiUsageUncachedInput.ts",
      "persistence/Migrations/159_AiAccessKeys.ts",
      "persistence/Migrations/160_AiUsageAccessKey.ts",
      // Each Makita configuration's usage apart (Makita ticket 07).
      "persistence/Migrations/168_AiUsageMakita.ts",
    ]);
  });

  it("reads a lent Vault group's use over one WS RPC only, names and counts only: its table read by VaultGrantUsage alone (Grants ticket 15)", () => {
    const usageRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /vault[-_ ]?usage/iu.test(rpc._tag),
    );
    expect(usageRpcs.map((rpc) => rpc._tag)).toEqual(["grants.vaultUsage"]);
    // Decided inside Grants for the session (a lender or the borrowing Space's Admins).
    expect(typeof spaceAccessForRpcMethod("grants.vaultUsage")).toBe("object");
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
        ...mcpTools,
        ...endpoints,
      ].filter((name) => /vault[-_ ]?usage|grant[-_ ]?usage/iu.test(name)),
    ).toEqual([]);
    // No answer has a field that could carry a value, a Thread or what an agent was asked.
    const fields = successFields(usageRpcs[0]!.successSchema.ast);
    for (const never of ["value", "threadId", "prompt", "content", "text", "secret", "valueId"]) {
      expect(fields).not.toContain(never);
    }
    // The table: written (when a process starts) and read by VaultGrantUsage alone, made by its
    // migration.
    const readers = files
      .filter(({ text }) => /\bvault_grant_usage\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual([
      "persistence/Migrations/150_VaultGrantUsage.ts",
      "vaults/VaultGrantUsage.ts",
    ]);
    // Counted only where values are read for a process that starts; read only by Grants.
    const callers = files
      .filter(({ text }) => /VaultGrantUsage\.(record|read)\(/u.test(text))
      .map(({ file }) => file);
    expect(callers.toSorted()).toEqual(["grants/Grants.ts", "vaults/SecretDelivery.ts"]);
  });

  it("signs in to subscriptions over WS RPCs only: no callback route, tokens read by AiAccounts alone", () => {
    // Owned-resources 08: every sign-in door is an account owner's, decided by AiAccounts (never
    // a Thread's or Project's rule), with access:write; none is a route of its own.
    const signIn = [...WsRpcGroup.requests.keys()].filter((tag) =>
      /^aiAccounts\.(login\.|importVertex|importCliproxy)/u.test(tag),
    );
    expect(signIn.toSorted()).toEqual(Object.keys(AI_ACCOUNT_SIGN_IN_RULES).toSorted());
    for (const method of signIn) {
      expect([
        method,
        (INSTALLATION_RPC_METHODS as ReadonlyArray<string>).includes(method),
      ]).toEqual([method, false]);
      expect([method, typeof spaceAccessForRpcMethod(method)]).toEqual([method, "object"]);
    }
    // No door on the Hub takes a provider's redirect: no route or endpoint for a callback.
    expect(
      [...Object.keys(HTTP_ENDPOINT_RULES), ...Object.keys(RAW_ROUTE_RULES), ...rawRoutes].filter(
        (door) =>
          /callback|oauth-callback|auth-url/iu.test(door) && /ai|account|gateway/iu.test(door),
      ),
    ).toEqual([]);
    // The tokens' store folder is read by AiAccounts alone, which hands them to CLIProxyAPI.
    const readers = files
      .filter(({ text }) => /AiAccountTokenStore\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual(["ai/AiAccounts.ts", "auth/ServerSecretStore.ts"]);
    // Only the Hub's management client talks to CLIProxyAPI's sign-in and credential API.
    // (The fake CLIProxyAPI of the tests, a testkit, answers them.)
    const management = files
      .filter(({ file }) => !file.endsWith(".testkit.ts"))
      .filter(({ text }) =>
        /\/oauth\/(auth-url|callback|status)|\/credentials\/download/u.test(text),
      )
      .map(({ file }) => file);
    expect(management.toSorted()).toEqual(["ai/CliproxyManagement.ts"]);
  });

  it("reaches the Owner's SSH install only through its HTTP endpoints: no WS or MCP door", () => {
    const users = files
      .filter(({ text }) => /sshInstall\/SshInstall\.ts"/u.test(text))
      .map(({ file }) => file);
    // server.ts builds its layer; environments/http.ts is its one door.
    expect(users.toSorted()).toEqual(["environments/http.ts", "server.ts"]);
    const doors = Object.keys(HTTP_ENDPOINT_RULES).filter((name) => /ssh/iu.test(name));
    expect(doors.toSorted()).toEqual([
      "environments.sshInstallCancel",
      "environments.sshInstallConfirm",
      "environments.sshInstallStart",
      "environments.sshInstallStatus",
    ]);
    expect(
      [...Object.keys(MCP_TOOL_RULES), ...Object.keys(RAW_ROUTE_RULES)].filter((name) =>
        /ssh/iu.test(name),
      ),
    ).toEqual([]);
  });
});

describe("every door of the Keycloak sign-in spec (ticket 11)", () => {
  const IDENTITY_GROUPS = new Set([
    "auth",
    "appSignIn",
    "keycloakSignIn",
    "signInSettings",
    "platformInvitations",
    "invitations",
    "mcpOAuth",
    "installationUsers",
  ]);

  it("lists in IDENTITY_DOORS every door that creates, links or keeps an identity", () => {
    const doors = [
      ...endpoints.filter((door) => IDENTITY_GROUPS.has(door.split(".")[0] ?? "")),
      // Doors of other groups that link, promote or prove a person.
      "environments.approveJoin",
      "spaces.changeMemberRole",
      "spaces.createOrganization",
      "spaces.issueMemberResetLink",
      ...rawRoutes.filter((door) => door.startsWith("auth/") && !door.endsWith(": middleware")),
      'ws.ts: GET "/ws"',
    ];
    expect({
      undeclared: undeclared(doors, IDENTITY_DOORS),
      stale: stale(doors, IDENTITY_DOORS),
    }).toEqual({ undeclared: [], stale: [] });
    // The spec's own doors (its «Puertas y contratos»), each with a rule of its own.
    const specEndpoints = [
      "keycloakSignIn.start",
      "keycloakSignIn.signOut",
      "signInSettings.get",
      "signInSettings.update",
      "signInSettings.check",
      "platformInvitations.create",
      "platformInvitations.list",
    ];
    const specRoutes = [
      "auth/keycloakSignInHttp.ts: GET KEYCLOAK_CALLBACK_PATH",
      "auth/keycloakSignInHttp.ts: POST KEYCLOAK_BACKCHANNEL_LOGOUT_PATH",
    ];
    for (const door of specEndpoints) {
      expect(HTTP_ENDPOINT_RULES[door], door).toHaveProperty("own");
      expect(endpoints, door).toContain(door);
    }
    for (const door of specRoutes) {
      expect(RAW_ROUTE_RULES[door], door).toHaveProperty("own");
      expect(AMBIENT_COOKIE_RULES[door], door).toBeDefined();
    }
  });

  it("opens no WS RPC or MCP tool for sign-in settings, Keycloak or Platform invitations", () => {
    const pattern = /keycloak|signInSetting|sign-in-setting|platformInvitation|identityLogin/iu;
    expect(
      [...WsRpcGroup.requests.keys(), ...mcpTools].filter((name) => pattern.test(name)),
    ).toEqual([]);
  });

  it("keeps the flow cookie to its flow: set by `start`, read by the callback alone", () => {
    const naming = files
      .filter(({ text }) => /FLOW_COOKIE_NAME|t3_keycloak_flow/u.test(text))
      .map(({ file }) => file);
    expect(naming.toSorted()).toEqual(["auth/KeycloakSignIn.ts", "auth/keycloakSignInHttp.ts"]);
    const signIn = files.find(({ file }) => file === "auth/KeycloakSignIn.ts")?.text ?? "";
    // One reader (flowCookieOf, through readHubCookie), and its one caller is the callback.
    expect(signIn.match(/readHubCookie\([^)]*FLOW_COOKIE_NAME/gu)?.length).toBe(1);
    const calls = [...signIn.matchAll(/flowCookieOf\(request/gu)].map((match) => match.index);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeGreaterThan(signIn.indexOf('Effect.fn("KeycloakSignIn.callback")'));
    expect(signIn.indexOf('Effect.fn("KeycloakSignIn.callback")')).toBeGreaterThan(0);
  });

  it("names, for every credential a session can lead to, whether it ends with its Keycloak sign-in", () => {
    // Credential columns, by the table each statement makes or alters (a rebuilt `_new` table is
    // the table it becomes).
    const column = /\b(?:[a-z_]*_(?:hash|sealed|secret|ciphertext)|identity_login_id)\b/gu;
    const columns = files
      .filter(({ file }) => file.startsWith("persistence/Migrations/"))
      .flatMap(({ text }) =>
        text.split("sql`").flatMap((chunk) => {
          const statement = chunk.split("`")[0] ?? "";
          const table = /(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_]+)/u.exec(
            statement,
          )?.[1];
          if (table === undefined) return [];
          return [...statement.matchAll(column)].map(
            (match) => `${table.replace(/_new$/u, "")}.${match[0]}`,
          );
        }),
      );
    // Modules that sign credentials or hold them in memory.
    const holders = files
      .filter(
        ({ file, text }) =>
          !file.startsWith("persistence/") &&
          // The server's wiring builds the signers' layers; it hands nothing out.
          file !== "server.ts" &&
          /from "[./a-z]*\/(?:PayloadSigner|AssetSigner)\.ts"|makeGrantStore</u.test(text),
      )
      .map(({ file }) => file);
    const found = [...new Set([...columns, ...holders])];
    const named = Object.values(KEYCLOAK_SESSION_CREDENTIALS).flatMap((rule) => rule.where);
    expect({
      unnamed: found.filter((where) => !named.includes(where)).toSorted(),
      stale: named.filter((where) => !found.includes(where)).toSorted(),
    }).toEqual({ unnamed: [], stale: [] });
    // What carries a sign-in ends with it.
    const ending = Object.values(KEYCLOAK_SESSION_CREDENTIALS)
      .filter((rule) => "endsWithLogin" in rule)
      .flatMap((rule) => rule.where);
    const carriers = found.filter((where) => where.endsWith(".identity_login_id"));
    expect(carriers.toSorted()).toEqual([
      "auth_pairing_links.identity_login_id",
      "auth_sessions.identity_login_id",
    ]);
    expect(carriers.filter((where) => !ending.includes(where))).toEqual([]);
  });
});

describe("no door takes the Hub's cookies from a preview's own origin", () => {
  it("names, for every raw route and the HTTP API, how a preview origin's request is kept off", () => {
    const doors = [...new Set(rawRoutes), "HttpApi"];
    expect({
      undeclared: doors.filter((door) => !Object.hasOwn(AMBIENT_COOKIE_RULES, door)).toSorted(),
      stale: Object.keys(AMBIENT_COOKIE_RULES)
        .filter((door) => !doors.includes(door))
        .toSorted(),
    }).toEqual({ undeclared: [], stale: [] });
  });

  it("reads every Hub cookie through readHubCookie, and sets none for a preview origin", () => {
    // A cookie is read off a request in one place (readHubCookie: none from a preview page, no
    // bare one a preview could plant); the preview route reads only its own preview cookies.
    const direct = files.flatMap(({ file, text }) =>
      Array.from(text.matchAll(/\.cookies\[([^\]]+)\]/g), (match) => `${file}: ${match[1]}`),
    );
    expect(direct.toSorted()).toEqual([
      "preview/PreviewOrigin.ts: `${HOST_PREFIX}${name}`",
      "preview/PreviewOrigin.ts: name",
      "preview/hubPreviewRoute.ts: PREVIEW_COOKIE_NAME",
      "preview/hubPreviewRoute.ts: PREVIEW_ORIGIN_COOKIE_NAME",
    ]);
    // Every module that sets or clears a cookie, found by what it writes (never a hand list,
    // Keycloak ticket 11): a Hub cookie's asks whether the request is a preview's first.
    const setters = files
      .filter(({ text }) =>
        /Cookies\.(set|setAll|unsafeSet|expireCookie)\(|\.(setCookie|setCookies|expireCookie|mergeCookies)\(|["']set-cookie["']/iu.test(
          text,
        ),
      )
      .map(({ file }) => file);
    const ASKS = "fromPreviewOrigin";
    const cookieSetters: Readonly<Record<string, string>> = {
      "auth/http.ts": ASKS,
      "auth/keycloakSignInHttp.ts": ASKS,
      "guest/http.ts": ASKS,
      "preview/hubPreviewRoute.ts": "a preview's own cookie, on its address's path or host",
      "device/DeviceHubProxy.ts": "drops an upstream's set-cookie; sets none",
    };
    expect(setters.toSorted()).toEqual(Object.keys(cookieSetters).toSorted());
    for (const [file, how] of Object.entries(cookieSetters)) {
      if (how !== ASKS) continue;
      expect(files.find((entry) => entry.file === file)?.text, file).toMatch(/fromPreviewOrigin/);
    }
    const cookieDoors = Object.entries(AMBIENT_COOKIE_RULES).filter(([door]) =>
      ["guest/http.ts: ", "preview/hubPreviewRoute.ts: *"].some((prefix) =>
        door.startsWith(prefix),
      ),
    );
    expect(cookieDoors.filter(([, rule]) => !("refused" in rule)).map(([door]) => door)).toEqual(
      [],
    );
  });
});
