/**
 * Reads KV v1 and v2 secrets from OpenBao or HashiCorp Vault. One request per path in a batch;
 * a 403 is taken for a lost token: one new sign-in and one retry per read, never more.
 * docs/internals/secrets.md, «OpenBao driver».
 */
import {
  defineSecretProviderDriver,
  readError,
  type SecretProviderTestReport,
  type SecretReadError,
  type SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import * as Effect from "effect/Effect";

import {
  definition,
  type OpenBaoReference,
  type OpenBaoSecretProviderConfig,
  parseReference,
} from "../shared/definition.ts";
import { FILE_ROOTS_ENV, providerFileProblem } from "./fileRoots.ts";
import { openBaoRequest } from "./http.ts";
import { classify, currentSession, dropToken, endpointOf, login } from "./tokens.ts";

/** Paths read at once from one OpenBao. */
const PATH_CONCURRENCY = 8;

type Fetched =
  | {
      readonly _tag: "data";
      readonly data: Readonly<Record<string, unknown>>;
      readonly version: string | undefined;
    }
  | { readonly _tag: "error"; readonly error: SecretReadError; readonly forbidden: boolean };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const apiPathOf = (reference: OpenBaoReference) =>
  reference.kvVersion === 2
    ? `${reference.mount}/data/${reference.path}${reference.version === undefined ? "" : `?version=${reference.version}`}`
    : `${reference.mount}/${reference.path}`;

const fetchPath = Effect.fn("OpenBaoDriver.fetchPath")(function* (
  config: OpenBaoSecretProviderConfig,
  reference: OpenBaoReference,
  token: string,
) {
  const response = yield* openBaoRequest(endpointOf(config), {
    method: "GET",
    path: apiPathOf(reference),
    token,
  });
  if (response._tag === "status" && response.status === 200) {
    const outer = record(record(response.json)?.data);
    const data = reference.kvVersion === 2 ? record(outer?.data) : outer;
    if (data === undefined) {
      yield* Effect.logWarning("OpenBao answered without data", { operation: "read" });
      return { _tag: "error", error: "unavailable", forbidden: false } satisfies Fetched;
    }
    const version = record(outer?.metadata)?.version;
    return {
      _tag: "data",
      data,
      version:
        reference.kvVersion === 2 && typeof version === "number" ? String(version) : undefined,
    } satisfies Fetched;
  }
  return {
    _tag: "error",
    error: yield* classify("read", response),
    forbidden: response._tag === "status" && response.status === 403,
  } satisfies Fetched;
});

/** A field as text: strings as they are, numbers and booleans written out; nothing else. */
const fieldOf = (fetched: Fetched, field: string): SecretReadResult => {
  if (fetched._tag === "error") return readError(fetched.error);
  const value = Object.hasOwn(fetched.data, field) ? fetched.data[field] : undefined;
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : undefined;
  if (text === undefined) return readError("not-found");
  return {
    _tag: "value",
    value: text,
    ...(fetched.version === undefined ? {} : { version: fetched.version }),
  };
};

const read = Effect.fn("OpenBaoDriver.read")(function* (
  config: OpenBaoSecretProviderConfig,
  references: ReadonlyArray<string>,
) {
  const parsed = references.map((reference) => {
    const found = parseReference(config.mounts, reference);
    return found === undefined || (found.version !== undefined && found.kvVersion === 1)
      ? undefined
      : found;
  });
  const paths = new Map<string, OpenBaoReference>();
  for (const reference of parsed) {
    if (reference !== undefined) paths.set(apiPathOf(reference), reference);
  }
  const fetched = new Map<string, Fetched>();
  if (paths.size > 0) {
    const first = yield* currentSession(config);
    if (first._tag === "error") {
      return references.map(() => readError(first.error));
    }
    const fetchAll = (keys: ReadonlyArray<string>, token: string) =>
      Effect.forEach(
        keys,
        (key) =>
          fetchPath(config, paths.get(key)!, token).pipe(
            Effect.tap((outcome) => Effect.sync(() => fetched.set(key, outcome))),
          ),
        { concurrency: PATH_CONCURRENCY, discard: true },
      );
    yield* fetchAll([...paths.keys()], first.session.token);
    const denied = [...fetched].flatMap(([key, outcome]) =>
      outcome._tag === "error" && outcome.forbidden ? [key] : [],
    );
    // A token given as is cannot be replaced: its 403 stands.
    if (denied.length > 0 && config.authMethod !== "token") {
      yield* dropToken(config, first.session.token);
      const again = yield* login(config);
      if (again._tag === "session") yield* fetchAll(denied, again.session.token);
    }
  }
  return parsed.map((reference) =>
    reference === undefined
      ? readError("invalid")
      : fieldOf(fetched.get(apiPathOf(reference))!, reference.field),
  );
});

const test = Effect.fn("OpenBaoDriver.test")(function* (config: OpenBaoSecretProviderConfig) {
  const signedIn = yield* login(config);
  if (signedIn._tag === "error") {
    return { ok: false, error: signedIn.error } satisfies SecretProviderTestReport;
  }
  const response = yield* openBaoRequest(endpointOf(config), {
    method: "GET",
    path: "auth/token/lookup-self",
    token: signedIn.session.token,
  });
  if (response._tag === "status" && response.status === 200) {
    return { ok: true } satisfies SecretProviderTestReport;
  }
  return {
    ok: false,
    error: yield* classify("lookup", response),
  } satisfies SecretProviderTestReport;
});

/** At save: a token file the Owner typed must lie under the operator's roots. */
const configProblem = Effect.fn("OpenBaoDriver.configProblem")(function* (
  config: OpenBaoSecretProviderConfig,
) {
  if (config.identityToken !== undefined) {
    return "identityToken is the Hub's to set at each read: it is never saved.";
  }
  if (config.tokenFile === undefined) return undefined;
  if (config.authMethod !== "kubernetes" && config.authMethod !== "jwt") return undefined;
  const problem = yield* providerFileProblem(config.tokenFile);
  return problem === undefined
    ? undefined
    : `The token file must be a regular file of at most 64 KiB under ${FILE_ROOTS_ENV} (${problem}).`;
});

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read,
  test,
  configProblem,
});
