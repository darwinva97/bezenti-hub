/**
 * The issuer of the Hub's workload identity tokens (ADR 0009): `T3CODE_IDENTITY_ISSUER`, else
 * `T3CODE_PUBLIC_URL`. Never a request's Host header: a forged Host must not name the issuer.
 * Without either, workload identity is off. docs/internals/secrets.md, «Workload identity».
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

const IDENTITY_ISSUER_ENV = "T3CODE_IDENTITY_ISSUER";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https://` (or `http://` to loopback), no user, query nor fragment; no trailing slash. */
const issuerOf = (value: string): string | undefined => {
  const url = URL.parse(value);
  if (url === null) return undefined;
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

export class IdentityIssuer extends Context.Service<
  IdentityIssuer,
  {
    /** The `iss` of every token and of the discovery document; none: identity is off. */
    readonly issuer: Option.Option<string>;
    /** Origins that are the Hub itself: never a token's audience. */
    readonly hubOrigins: ReadonlyArray<string>;
  }
>()("t3/identity/IdentityIssuer") {}

export const make = (input: {
  readonly configured: string | undefined;
  readonly publicUrl: URL | undefined;
}) => {
  const issuer = issuerOf(input.configured ?? input.publicUrl?.href ?? "");
  const hubOrigins = [
    ...(input.publicUrl === undefined ? [] : [input.publicUrl.origin]),
    ...(issuer === undefined ? [] : [issuer, new URL(issuer).origin]),
  ];
  return IdentityIssuer.of({
    issuer: Option.fromUndefinedOr(issuer),
    hubOrigins: [...new Set(hubOrigins)],
  });
};

export const layer = Layer.effect(
  IdentityIssuer,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const configured = yield* Config.String(IDENTITY_ISSUER_ENV).pipe(
      Config.option,
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const issuer = make({ configured, publicUrl: config.publicUrl });
    if (configured !== undefined && Option.isNone(issuer.issuer)) {
      yield* Effect.logWarning(
        `${IDENTITY_ISSUER_ENV} is not an https:// URL (http:// only to localhost): workload identity is off.`,
      );
    }
    return issuer;
  }),
);
