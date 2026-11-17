import { ConnectionsSettings } from "./ConnectionsSettings";

/** How this computer is reached: network access, endpoints, Tailscale and WSL. */
export function MachineNetworkSection() {
  return <ConnectionsSettings view="network" />;
}
