// @effect-diagnostics nodeBuiltinImport:off -- a TLS agent per CA and client cert needs node:https.
/**
 * OpenBao's HTTP API, answered by status only: a body can echo what the server holds, so only
 * its parsed JSON of a 2xx leaves this module. A redirect is followed once and only to the same
 * origin: the token is never sent anywhere else.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";

/** Where and how to reach one OpenBao. `caCert` adds to the system CAs; it never disables checks. */
export interface OpenBaoEndpoint {
  readonly address: string;
  readonly namespace?: string | undefined;
  readonly caCert?: string | undefined;
  readonly clientCert?: string | undefined;
  readonly clientKey?: string | undefined;
}

export interface OpenBaoCall {
  readonly method: "GET" | "POST";
  /** After `/v1/`, already made of safe segments. */
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
}

/** A status and, for a 2xx, the JSON body; or no answer (network, TLS, timeout, redirect). */
export type OpenBaoResponse =
  | { readonly _tag: "status"; readonly status: number; readonly json: unknown }
  | { readonly _tag: "unreachable"; readonly why: "network" | "timeout" | "redirect" | "body" };

const REQUEST_TIMEOUT = Duration.seconds(5);
const MAX_BODY_BYTES = 1024 * 1024;

const agents = new Map<string, NodeHttp.Agent>();

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** One keep-alive agent per origin, CA, and client certificate. */
const agentFor = (endpoint: OpenBaoEndpoint, url: URL): NodeHttp.Agent => {
  const key = sha256(
    [url.origin, endpoint.caCert ?? "", endpoint.clientCert ?? "", endpoint.clientKey ?? ""].join(
      "\u0000",
    ),
  );
  const existing = agents.get(key);
  if (existing !== undefined) return existing;
  const agent =
    url.protocol === "http:"
      ? new NodeHttp.Agent({ keepAlive: true })
      : new NodeHttps.Agent({
          keepAlive: true,
          rejectUnauthorized: true,
          ...(endpoint.caCert === undefined
            ? {}
            : { ca: [...NodeTls.rootCertificates, endpoint.caCert] }),
          ...(endpoint.clientCert === undefined || endpoint.clientKey === undefined
            ? {}
            : { cert: endpoint.clientCert, key: endpoint.clientKey }),
        });
  agents.set(key, agent);
  return agent;
};

interface RawResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: Uint8Array | undefined;
}

const send = (
  endpoint: OpenBaoEndpoint,
  url: URL,
  call: OpenBaoCall,
  signal: AbortSignal,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    const headers: Record<string, string> = { "X-Vault-Request": "true" };
    if (call.token !== undefined) headers["X-Vault-Token"] = call.token;
    if (endpoint.namespace !== undefined) headers["X-Vault-Namespace"] = endpoint.namespace;
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const request = (url.protocol === "http:" ? NodeHttp : NodeHttps).request(url, {
      method: call.method,
      headers,
      agent: agentFor(endpoint, url),
      signal,
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status < 200 || status >= 300) {
        // Never read: an error body can carry what the server holds.
        response.resume();
        resolve({ status, location, body: undefined });
        return;
      }
      const chunks: Array<Buffer> = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.destroy();
          reject(new Error("OpenBao response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.end(payload);
  });

const parseJson = (body: Uint8Array | undefined): Option.Option<unknown> => {
  if (body === undefined || body.length === 0) return Option.some(undefined);
  try {
    return Option.some(JSON.parse(Buffer.from(body).toString("utf8")));
  } catch {
    return Option.none();
  }
};

const once = (endpoint: OpenBaoEndpoint, url: URL, call: OpenBaoCall) =>
  Effect.tryPromise({
    try: (signal) => send(endpoint, url, call, signal),
    catch: () => "network" as const,
  }).pipe(
    Effect.timeoutOption(REQUEST_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => "network" as const),
  );

/** One call, bounded; a same-origin redirect followed once, any other not at all. */
export const openBaoRequest = Effect.fn("OpenBao.request")(function* (
  endpoint: OpenBaoEndpoint,
  call: OpenBaoCall,
) {
  let url = new URL(`/v1/${call.path}`, endpoint.address);
  for (let hop = 0; hop < 2; hop++) {
    const raw = yield* once(endpoint, url, call);
    if (raw === undefined) return { _tag: "unreachable", why: "timeout" } as OpenBaoResponse;
    if (raw === "network") return { _tag: "unreachable", why: "network" } as OpenBaoResponse;
    if (raw.status >= 300 && raw.status < 400) {
      const next = raw.location === undefined ? undefined : URL.parse(raw.location, url.href);
      if (hop > 0 || next === null || next === undefined || next.origin !== url.origin) {
        return { _tag: "unreachable", why: "redirect" } as OpenBaoResponse;
      }
      url = next;
      continue;
    }
    const json = parseJson(raw.body);
    if (Option.isNone(json)) return { _tag: "unreachable", why: "body" } as OpenBaoResponse;
    return { _tag: "status", status: raw.status, json: json.value } as OpenBaoResponse;
  }
  return { _tag: "unreachable", why: "redirect" } as OpenBaoResponse;
});
