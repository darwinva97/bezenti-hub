// @effect-diagnostics nodeBuiltinImport:off -- an in-process HTTP(S) server.
/** A fake OpenBao for the driver tests: real sockets and TLS, a scripted API, every call kept. */
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeTls from "node:tls";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), "utf8");

/** TEST-ONLY TLS material; see test/fixtures/tls/README.md. */
export const TEST_TLS = {
  ca: fixture("test-only-ca.pem"),
  otherCa: fixture("test-only-other-ca.pem"),
  serverCert: fixture("test-only-server.pem"),
  serverKey: fixture("test-only-server.key.pem"),
  clientCert: fixture("test-only-client.pem"),
  clientKey: fixture("test-only-client.key.pem"),
};

export interface SeenRequest {
  readonly method: string;
  /** Path and query, as sent. */
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: unknown;
  /** The client certificate's CN, over mutual TLS. */
  readonly clientName: string | undefined;
}

export interface Reply {
  readonly status: number;
  readonly json?: unknown;
  /** A body that is not JSON (an error page that echoes data, say). */
  readonly text?: string;
  readonly location?: string;
}

export type Route = (request: SeenRequest) => Reply;

export interface FakeOpenBao {
  readonly address: string;
  readonly seen: Array<SeenRequest>;
  /** The first request (seen or still to come) that `matches`; background calls arrive later. */
  readonly next: (matches: (request: SeenRequest) => boolean) => Effect.Effect<SeenRequest>;
}

/** Serves `route` on 127.0.0.1 until the scope closes: plain, TLS, or TLS asking a client cert. */
export const startFakeOpenBao = (route: Route, tls?: "server" | "mutual") =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly fake: FakeOpenBao; readonly server: NodeHttp.Server }>((resolve) => {
          const seen: Array<SeenRequest> = [];
          const waiting: Array<{
            readonly matches: (request: SeenRequest) => boolean;
            readonly resolve: (request: SeenRequest) => void;
          }> = [];
          const next = (matches: (request: SeenRequest) => boolean) =>
            Effect.promise(
              () =>
                new Promise<SeenRequest>((resolve) => {
                  const already = seen.find(matches);
                  if (already !== undefined) resolve(already);
                  else waiting.push({ matches, resolve });
                }),
            );
          const handler: NodeHttp.RequestListener = (request, response) => {
            const chunks: Array<Buffer> = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              const socket = request.socket as NodeTls.TLSSocket;
              const peer =
                typeof socket.getPeerCertificate === "function"
                  ? socket.getPeerCertificate()
                  : undefined;
              const seenRequest: SeenRequest = {
                method: request.method ?? "",
                url: request.url ?? "",
                headers: request.headers,
                body: raw.length === 0 ? undefined : JSON.parse(raw),
                clientName:
                  peer !== undefined && typeof peer.subject?.CN === "string"
                    ? peer.subject.CN
                    : undefined,
              };
              seen.push(seenRequest);
              for (const waiter of waiting.filter((candidate) => candidate.matches(seenRequest))) {
                waiting.splice(waiting.indexOf(waiter), 1);
                waiter.resolve(seenRequest);
              }
              const reply = route(seenRequest);
              response.statusCode = reply.status;
              if (reply.location !== undefined) response.setHeader("Location", reply.location);
              if (reply.json !== undefined) {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify(reply.json));
              } else {
                response.end(reply.text ?? "");
              }
            });
          };
          const server =
            tls === undefined
              ? NodeHttp.createServer(handler)
              : NodeHttps.createServer(
                  {
                    key: TEST_TLS.serverKey,
                    cert: TEST_TLS.serverCert,
                    ...(tls === "mutual"
                      ? { ca: TEST_TLS.ca, requestCert: true, rejectUnauthorized: true }
                      : {}),
                  },
                  handler,
                );
          server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { readonly port: number }).port;
            resolve({
              fake: {
                address: `${tls === undefined ? "http" : "https"}://127.0.0.1:${port}`,
                seen,
                next,
              },
              server,
            });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  ).pipe(Effect.map(({ fake }) => fake));

export interface BaoModelOptions {
  /** KV v2 secrets by API path (`kv/data/acme/app`), each by version (1-based). */
  readonly kv2?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
  /** KV v1 secrets by API path (`legacy/db`). */
  readonly kv1?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Tokens that work without a login (the `token` method). */
  readonly staticTokens?: ReadonlyArray<string>;
  readonly leaseSeconds?: number;
  readonly renewable?: boolean;
  /** Whether a login body is accepted (wrong secret id: 400, say). Default: all are. */
  readonly acceptLogin?: (mount: string, body: unknown, clientName: string | undefined) => boolean;
}

/** An OpenBao that issues tokens at `auth/<mount>/login` and serves KV v1 and v2. */
export function baoModel(options: BaoModelOptions = {}) {
  const valid = new Set(options.staticTokens ?? []);
  let issued = 0;
  const lease = options.leaseSeconds ?? 3600;
  const renewable = options.renewable ?? true;
  const route: Route = (request) => {
    const url = new URL(request.url, "http://bao");
    const token = request.headers["x-vault-token"];
    const loginMount = /^\/v1\/auth\/(.+)\/login$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && loginMount !== undefined && loginMount !== "token") {
      if (
        options.acceptLogin &&
        !options.acceptLogin(loginMount, request.body, request.clientName)
      ) {
        return { status: 400, json: { errors: ["invalid credentials"] } };
      }
      const clientToken = `hvs.test-token-${++issued}`;
      valid.add(clientToken);
      return {
        status: 200,
        json: { auth: { client_token: clientToken, lease_duration: lease, renewable } },
      };
    }
    if (typeof token !== "string" || !valid.has(token)) {
      return { status: 403, json: { errors: ["permission denied"] } };
    }
    if (url.pathname === "/v1/auth/token/lookup-self") {
      return {
        status: 200,
        json: { data: { ttl: options.staticTokens?.includes(token) ? 0 : lease, renewable } },
      };
    }
    if (url.pathname === "/v1/auth/token/renew-self" && request.method === "POST") {
      return {
        status: 200,
        json: { auth: { client_token: token, lease_duration: lease, renewable } },
      };
    }
    const apiPath = url.pathname.slice("/v1/".length);
    const versions = options.kv2?.[apiPath];
    if (versions !== undefined) {
      const wanted = Number(url.searchParams.get("version") ?? versions.length);
      const data = versions[wanted - 1];
      return data === undefined
        ? { status: 404, json: { errors: [] } }
        : { status: 200, json: { data: { data, metadata: { version: wanted } } } };
    }
    const v1 = options.kv1?.[apiPath];
    if (v1 !== undefined) return { status: 200, json: { data: v1, lease_duration: 0 } };
    return { status: 404, json: { errors: [] } };
  };
  return {
    route,
    /** Every issued token stops working, as after a revoke. */
    revokeAll: () => valid.clear(),
  };
}
