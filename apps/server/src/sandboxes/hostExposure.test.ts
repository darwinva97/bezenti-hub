// @effect-diagnostics nodeBuiltinImport:off -- binds a real service on the host's own address.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { hostExposureRefusal, listeningOutsideLoopback } from "./hostExposure.ts";

/** The host's own address on its network, as a LAN service would bind it. */
const lanAddress = Object.values(NodeOS.networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux" || lanAddress === undefined)(
  "a dedicated machine's host",
  () => {
    const servers: Array<NodeNet.Server> = [];
    afterAll(() => {
      for (const server of servers) server.close();
    });
    const listen = (host: string) =>
      new Promise<number>((resolve) => {
        const server = NodeNet.createServer();
        servers.push(server);
        server.listen(0, host, () => resolve((server.address() as NodeNet.AddressInfo).port));
      });

    it("finds a service bound on its LAN address, and refuses the Sandbox until it is allowed", async () => {
      const lanPort = await listen(lanAddress!);
      const loopbackPort = await listen("127.0.0.1");
      const listeners = listeningOutsideLoopback();
      expect(listeners).toContainEqual({ address: lanAddress, port: lanPort });
      expect(listeners.some((listener) => listener.port === loopbackPort)).toBe(false);
      const ours = listeners.filter((listener) => listener.port === lanPort);
      const refusal = hostExposureRefusal(ours, new Set());
      // It names each service and both ways out: bind it to loopback, or list its port.
      expect(refusal).toContain(`${lanAddress}:${lanPort}`);
      expect(refusal).toContain("127.0.0.1");
      expect(refusal).toContain(`T3CODE_SANDBOX_HOST_PORTS=${lanPort}`);
      expect(hostExposureRefusal(ours, new Set([lanPort]))).toBeUndefined();
    });
  },
);
