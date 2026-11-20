/**
 * Previews on their own origin (spec 3 ticket 15): `T3CODE_PREVIEW_ORIGIN=https://*.<zone>` serves
 * each preview address at `https://<id>.<zone>`. Every host under the zone belongs to previews: the
 * Hub never answers there, nor takes its cookies from a page there. See docs/internals/sandboxes.md.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";

export interface PreviewOriginPattern {
  readonly protocol: "https:" | "http:";
  /** The wildcard's parent, lower case: `preview.example.com`. */
  readonly zone: string;
  /** An explicit port, or "" for the scheme's own. */
  readonly port: string;
}

/** An address's subdomain: 256 random bits in lower-case base32, a valid DNS label. */
const PREVIEW_ID = /^[a-z2-7]{52}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new preview subdomain: as unguessable as the address's token, and never reused. */
export const newPreviewId = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) id += BASE32[(value << (5 - bits)) & 31];
  return id;
};

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost");

/**
 * Reads `T3CODE_PREVIEW_ORIGIN`. Plain HTTP only under `localhost`, which browsers treat as a
 * secure context (the preview cookie is `Secure`); the zone needs two labels, so a wildcard over a
 * whole top-level domain is refused; and the Hub's own host must not fall inside it.
 */
export const parsePreviewOrigin = (
  value: string,
  hub: { readonly publicUrl?: URL | undefined; readonly host?: string | undefined } = {},
): Result.Result<PreviewOriginPattern, string> => {
  const match = /^(https?):\/\/\*\.([^/:]+)(?::(\d{1,5}))?\/?$/i.exec(value.trim());
  if (match === null) {
    return Result.fail(
      "T3CODE_PREVIEW_ORIGIN must be a wildcard origin such as https://*.preview.example.com.",
    );
  }
  const protocol = match[1]!.toLowerCase() === "https" ? "https:" : "http:";
  const zone = match[2]!.toLowerCase().replace(/\.$/, "");
  const port = match[3] ?? "";
  const labels = zone.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    return Result.fail(`T3CODE_PREVIEW_ORIGIN: "${zone}" is not a host name.`);
  }
  if (labels.length < 2 && zone !== "localhost") {
    return Result.fail(
      "T3CODE_PREVIEW_ORIGIN needs a domain of its own under the wildcard, such as *.preview.example.com.",
    );
  }
  if (protocol === "http:" && !isLocalhostName(zone)) {
    return Result.fail("T3CODE_PREVIEW_ORIGIN must be https:// (plain http only under localhost).");
  }
  if (port !== "" && (Number(port) < 1 || Number(port) > 65_535)) {
    return Result.fail(`T3CODE_PREVIEW_ORIGIN: ${port} is not a port.`);
  }
  const pattern: PreviewOriginPattern = {
    protocol,
    zone,
    port: port === (protocol === "https:" ? "443" : "80") ? "" : port,
  };
  for (const host of [hub.publicUrl?.hostname, hub.host]) {
    if (host !== undefined && inPreviewZone(pattern, host)) {
      return Result.fail(
        `T3CODE_PREVIEW_ORIGIN: the Hub's own host ${host} is inside *.${zone}; previews need a domain the Hub does not answer on.`,
      );
    }
  }
  return Result.succeed(pattern);
};

/** Whether `hostname` is under the preview zone: a preview's, or nobody's, never the Hub's. */
export const inPreviewZone = (pattern: PreviewOriginPattern, hostname: string): boolean =>
  hostname.toLowerCase().replace(/\.$/, "").endsWith(`.${pattern.zone}`);

/**
 * Where a request under the zone goes: `{ id }` when its host is exactly one preview subdomain on
 * the pattern's scheme and port, `{ id: undefined }` for any other host in the zone (answered as
 * an unknown preview), `undefined` outside it (the Hub's own routes).
 */
export const previewHostOf = (
  pattern: PreviewOriginPattern,
  url: URL,
): { readonly id: string | undefined } | undefined => {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!inPreviewZone(pattern, hostname)) return undefined;
  const label = hostname.slice(0, -(pattern.zone.length + 1));
  const sameOrigin = url.protocol === pattern.protocol && url.port === pattern.port;
  return { id: sameOrigin && PREVIEW_ID.test(label) ? label : undefined };
};

/** The origin a preview subdomain is served on. */
export const previewOriginOf = (pattern: PreviewOriginPattern, id: string): string =>
  `${pattern.protocol}//${id}.${pattern.zone}${pattern.port === "" ? "" : `:${pattern.port}`}`;

const headerInZone = (pattern: PreviewOriginPattern, value: string | undefined) => {
  if (value === undefined || value === "null") return false;
  try {
    return inPreviewZone(pattern, new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * Whether a request may come from a page on a preview origin: its `Origin` or `Referer` is in the
 * zone, or it hides both (`Origin: null` from another site, as a `no-cors` fetch with no referrer
 * sends). A same-site GET embed naming neither changes nothing and is unreadable; frames are refused.
 */
export const crossesFromPreviewOrigin = (
  pattern: PreviewOriginPattern | undefined,
  headers: Readonly<Record<string, string | undefined>>,
): boolean =>
  pattern !== undefined &&
  (headerInZone(pattern, headers.origin) ||
    headerInZone(pattern, headers.referer) ||
    (headers.origin === "null" &&
      (headers["sec-fetch-site"] === "same-site" || headers["sec-fetch-site"] === "cross-site")));

const HOST_PREFIX = "__Host-";

/**
 * A Hub cookie (session, legacy, dev token, guest) as a request carries it, read in one place:
 * `__Host-<name>` first, which only the Hub's own host can set; the bare name only where no preview
 * could have set it (previews off, or plain HTTP); nothing for a page on a preview's own origin.
 */
export const readHubCookie = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
  pattern: PreviewOriginPattern | undefined,
  /** `hostOnly`: over HTTPS only `__Host-`, previews or not (a sibling host can toss a bare one). */
  options?: { readonly hostOnly?: boolean },
): string | undefined => {
  if (crossesFromPreviewOrigin(pattern, request.headers)) return undefined;
  const hostOnly = request.cookies[`${HOST_PREFIX}${name}`];
  if (hostOnly) return hostOnly;
  if ((pattern !== undefined || options?.hostOnly === true) && request.protocol === "https") {
    return undefined;
  }
  return request.cookies[name] || undefined;
};

/** `T3CODE_PREVIEW_ORIGIN` as this server runs with it (none without a server config). */
export const previewOriginSetting = Effect.map(
  Effect.serviceOption(ServerConfig.ServerConfig),
  (config) => Option.getOrUndefined(config)?.previewOrigin,
);

/** `crossesFromPreviewOrigin` for the request being served. */
export const fromPreviewOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return crossesFromPreviewOrigin(yield* previewOriginSetting, request.headers);
});
