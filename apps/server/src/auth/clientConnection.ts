import { isPrivateNetworkHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Headers from "effect/http/Headers";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";

/**
 * Which direct peers may tell the server who the client is. `loopback` covers the proxies that
 * reach the server on this machine: Tailscale Serve, a local Caddy or nginx.
 */
export interface TrustedProxies {
  readonly loopback: boolean;
  readonly networks: ReadonlyArray<IpNetwork.IpNetwork>;
}

export const DEFAULT_TRUSTED_PROXIES: TrustedProxies = { loopback: true, networks: [] };

/**
 * Parses `T3CODE_TRUSTED_PROXIES`: comma- or space-separated CIDRs, single addresses,
 * `loopback`, or `none`. The list replaces the default, so keep `loopback` when a local
 * proxy or tunnel also reaches the server.
 */
export const parseTrustedProxies = (value: string): Result.Result<TrustedProxies, string> => {
  let loopback = false;
  const networks: Array<IpNetwork.IpNetwork> = [];
  for (const entry of value.split(/[\s,]+/).filter((part) => part.length > 0)) {
    const lower = entry.toLowerCase();
    if (lower === "loopback") {
      loopback = true;
      continue;
    }
    if (lower === "none") continue;
    const network = entry.includes("/")
      ? IpNetwork.fromString(entry)
      : Result.flatMap(NetAddress.ipFromString(entry), (address) =>
          IpNetwork.fromAddress(address, NetAddress.width(address)),
        );
    if (Result.isFailure(network)) {
      return Result.fail(`"${entry}" is not an IP address, a CIDR range, loopback or none.`);
    }
    networks.push(network.success);
  }
  return Result.succeed({ loopback, networks });
};

/** An address from a socket or a forwarding header: quotes, brackets, port and IPv4 mapping removed. */
const parseAddress = (input: string | undefined): NetAddress.IpAddress | undefined => {
  if (input === undefined) return undefined;
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1] ?? "";
  else if (/^[\d.]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  const ip = NetAddress.ipFromString(value);
  return Result.isSuccess(ip) ? NetAddress.toCanonical(ip.success) : undefined;
};

/**
 * Who a per-client limit counts: an IPv4 address, or a whole IPv6 /64, which one customer usually
 * holds every address of. Unknown clients share one bucket.
 */
export const clientBucketOf = (input: string | undefined): string => {
  const address = parseAddress(input);
  if (address === undefined) return "unknown";
  if (!NetAddress.isIpv6Address(address)) return NetAddress.formatIp(address);
  const network = IpNetwork.fromAddress(address, 64);
  return Result.isSuccess(network)
    ? IpNetwork.format(network.success)
    : NetAddress.formatIp(address);
};

/** The canonical text of an IP address (IPv4-mapped IPv6 becomes IPv4), or undefined. */
export const normalizeClientAddress = (input: string | undefined): string | undefined => {
  const address = parseAddress(input);
  return address === undefined ? undefined : NetAddress.formatIp(address);
};

/** Loopback only; an unknown client is never local. */
export const isLoopbackClientAddress = (input: string | undefined): boolean => {
  const address = parseAddress(input);
  return address !== undefined && NetAddress.isLoopback(address);
};

/**
 * Loopback, a private LAN range, or the tailnet (CGNAT 100.64/10 and Tailscale's IPv6 prefix).
 * Link-local and unknown clients are not private.
 */
export const isPrivateClientAddress = (input: string | undefined): boolean => {
  const address = parseAddress(input);
  if (address === undefined) return false;
  if (NetAddress.isLoopback(address)) return true;
  const text = NetAddress.formatIp(address);
  if (NetAddress.isIpv6Address(address)) return isTailnetHost(text);
  return !text.startsWith("169.254.") && isPrivateNetworkHost(text);
};

const isTrusted = (proxies: TrustedProxies, address: NetAddress.IpAddress) =>
  (proxies.loopback && NetAddress.isLoopback(address)) ||
  proxies.networks.some((network) => IpNetwork.contains(network, address));

/** The entries of a comma-separated header, trimmed, empty ones dropped. */
export const headerList = (value: string | undefined): Array<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

const unquote = (value: string | undefined) => value?.replace(/^"|"$/g, "");

/** RFC 7239 `Forwarded`: one element per hop, each with optional `for`, `proto` and `host`. */
const parseForwarded = (value: string | undefined) =>
  headerList(value).map((element) => {
    const pairs = new Map<string, string>();
    for (const pair of element.split(";")) {
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      pairs.set(pair.slice(0, separator).trim().toLowerCase(), pair.slice(separator + 1).trim());
    }
    return {
      for: pairs.get("for"),
      proto: unquote(pairs.get("proto")),
      host: unquote(pairs.get("host")),
    };
  });

const hostShape = /^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/i;

export interface ClientConnection {
  /**
   * The client's address: the direct peer, or the hop a trusted proxy forwarded. Undefined when
   * a trusted proxy forwarded a request without naming the client, so it never passes as local.
   */
  readonly address: string | undefined;
  /** Whether the client's own connection used HTTPS. */
  readonly secure: boolean;
  /** The host the client asked for, when a trusted proxy reported one. */
  readonly forwardedHost: string | undefined;
}

/**
 * Who is on the other end of a request. Forwarding headers count only when the direct peer is a
 * trusted proxy, and then the hops are walked from the right: the first one that is not itself a
 * trusted proxy is the client, so an address a client writes into the header is never chosen.
 * The scheme and host are the ones the nearest proxy reports.
 */
export const resolveClientConnection = (input: {
  readonly peerAddress: string | undefined;
  readonly protocol: "http" | "https" | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly trustedProxies: TrustedProxies;
}): ClientConnection => {
  const peer = parseAddress(input.peerAddress);
  const transportSecure = input.protocol === "https";
  if (peer === undefined || !isTrusted(input.trustedProxies, peer)) {
    return {
      address: peer === undefined ? undefined : NetAddress.formatIp(peer),
      secure: transportSecure,
      forwardedHost: undefined,
    };
  }
  const xForwardedFor = headerList(input.headers["x-forwarded-for"]);
  const forwarded = parseForwarded(input.headers.forwarded);
  const xForwardedProto = headerList(input.headers["x-forwarded-proto"]).at(-1);
  const xForwardedHost = headerList(input.headers["x-forwarded-host"]).at(-1);
  const proto = xForwardedProto ?? forwarded.findLast((hop) => hop.proto !== undefined)?.proto;
  const host = xForwardedHost ?? forwarded.findLast((hop) => hop.host !== undefined)?.host;
  const forwardedRequest =
    xForwardedFor.length > 0 || forwarded.length > 0 || proto !== undefined || host !== undefined;

  // A trusted peer that forwarded nothing is the client itself, such as a browser on this machine.
  let client: NetAddress.IpAddress | undefined = forwardedRequest ? undefined : peer;
  const hops = xForwardedFor.length > 0 ? xForwardedFor : forwarded.map((hop) => hop.for);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    // `unknown`, an obfuscated `_name`, or a missing `for`: the proxy does not know the client.
    client = parseAddress(hops[index]);
    if (client === undefined || !isTrusted(input.trustedProxies, client)) break;
  }

  return {
    address: client === undefined ? undefined : NetAddress.formatIp(client),
    secure: proto === undefined ? transportSecure : proto.toLowerCase() === "https",
    forwardedHost: host !== undefined && hostShape.test(host) ? host : undefined,
  };
};

/**
 * The request as the client made it: `remoteAddress` is the client, `protocol` its scheme, the
 * `host` header the host it asked for, and `peerAddress` the direct peer. Every per-client rule
 * reads these, never the forwarding headers.
 */
export const withClientConnection = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: TrustedProxies,
): HttpServerRequest.HttpServerRequest => {
  const connection = resolveClientConnection({
    peerAddress: Option.getOrUndefined(request.peerAddress),
    protocol: request.protocol,
    headers: request.headers,
    trustedProxies,
  });
  return request.modify({
    remoteAddress: Option.fromUndefinedOr(connection.address),
    peerAddress: request.peerAddress,
    protocol: connection.secure ? "https" : "http",
    ...(connection.forwardedHost === undefined
      ? {}
      : { headers: Headers.set(request.headers, "host", connection.forwardedHost) }),
  });
};
