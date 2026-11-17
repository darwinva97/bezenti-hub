// @effect-diagnostics nodeBuiltinImport:off -- reads the host's listening sockets from /proc.
/**
 * What a dedicated machine's container could reach of its host. Its network has no host loopback,
 * but every other address of the host is a route away, and rootless Podman cannot firewall it: a
 * dedicated machine runs its Sandbox only when nothing of the host listens beyond loopback, or the
 * Owner named each such port as fine to reach. See docs/internals/sandboxes.md.
 */
import * as NodeFS from "node:fs";

export interface HostListener {
  readonly address: string;
  readonly port: number;
}

/** `/proc/net/tcp`'s little-endian hex IPv4 (`0100007F`) as dotted quads. */
const ipv4Of = (hex: string) =>
  [6, 4, 2, 0].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(".");

/** `/proc/net/tcp6`'s address (four little-endian 32-bit words) as IPv6 text. */
const ipv6Of = (hex: string) => {
  const words: Array<string> = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    const bytes = [6, 4, 2, 0].map((at) => chunk.slice(at, at + 2)).join("");
    words.push(bytes.slice(0, 4), bytes.slice(4, 8));
  }
  return words.map((group) => Number.parseInt(group, 16).toString(16)).join(":");
};

const isLoopback = (address: string) =>
  address.startsWith("127.") ||
  address === "0:0:0:0:0:0:0:1" ||
  /^0:0:0:0:0:ffff:7f/u.test(address);

const LISTEN = "0A";

const readListeners = (file: string, parse: (hex: string) => string): Array<HostListener> => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found: Array<HostListener> = [];
  for (const line of text.split("\n").slice(1)) {
    const [, local, , state] = line.trim().split(/\s+/u);
    if (local === undefined || state !== LISTEN) continue;
    const [addressHex = "", portHex = ""] = local.split(":");
    const address = parse(addressHex);
    if (!isLoopback(address)) found.push({ address, port: Number.parseInt(portHex, 16) });
  }
  return found;
};

/**
 * The host's TCP sockets listening on an address other than loopback (`0.0.0.0` and `::`
 * included, which take every address), in the network namespace this server runs in.
 */
export const listeningOutsideLoopback = (): ReadonlyArray<HostListener> => [
  ...readListeners("/proc/net/tcp", ipv4Of),
  ...readListeners("/proc/net/tcp6", ipv6Of),
];

/**
 * Why the host's open ports keep a dedicated or lent Sandbox from running, or undefined: each
 * `address:port`, and the two ways out (bind it to loopback, or let Sandboxes reach that port).
 */
export const hostExposureRefusal = (
  listeners: ReadonlyArray<HostListener>,
  allowedPorts: ReadonlySet<number>,
): string | undefined => {
  const open = listeners.filter((listener) => !allowedPorts.has(listener.port));
  if (open.length === 0) return undefined;
  const named = [...new Set(open.map((listener) => `${listener.address}:${listener.port}`))];
  const ports = [...new Set(open.map((listener) => listener.port))].toSorted((a, b) => a - b);
  return `its Sandbox containers could reach this machine's ${named.join(", ")}. Either bind those services to 127.0.0.1, or let Sandboxes reach those ports by listing them in T3CODE_SANDBOX_HOST_PORTS (T3CODE_DEDICATED_HOST_PORTS also works), for example T3CODE_SANDBOX_HOST_PORTS=${ports.join(",")}.`;
};
