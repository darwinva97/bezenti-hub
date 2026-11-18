import { describe, expect, it } from "vite-plus/test";

import {
  ENVIRONMENT_RECONNECT_GRACE_MS,
  ENVIRONMENT_RECONNECTING_AFTER_MS,
  environmentConnectionStatus,
} from "./environmentConnection.ts";

const NOW = 1_000_000;
const status = (connected: boolean, silentMs: number | null) =>
  environmentConnectionStatus({
    connected,
    lastSeenAtMs: silentMs === null ? null : NOW - silentMs,
    nowMs: NOW,
  });

describe("environmentConnectionStatus", () => {
  it("a machine whose socket just dropped still shows online, as behind a proxy it is back soon", () => {
    expect(status(true, 5_000)).toBe("online");
    expect(status(false, 0)).toBe("online");
    expect(status(false, ENVIRONMENT_RECONNECT_GRACE_MS - 1)).toBe("online");
    expect(status(false, ENVIRONMENT_RECONNECT_GRACE_MS)).toBe("reconnecting");
  });

  it("silence turns it reconnecting, then offline", () => {
    expect(status(true, ENVIRONMENT_RECONNECTING_AFTER_MS)).toBe("reconnecting");
    expect(status(false, 89_999)).toBe("reconnecting");
    expect(status(false, 90_000)).toBe("offline");
    expect(status(true, 90_000)).toBe("offline");
    expect(status(false, null)).toBe("offline");
  });
});
