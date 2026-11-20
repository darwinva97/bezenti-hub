import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppSignInSurface } from "./AppSignInSurface";
import { ConnectAgentSurface } from "./ConnectAgentSurface";

// Keycloak 09: the pages the desktop and mobile apps and MCP clients open offer Keycloak, and come
// back to themselves with the whole request.

const start = vi.hoisted(() => vi.fn((_input: unknown) => new Promise<void>(() => undefined)));
// Keycloak 08: local sign-in closed to non-Owners, so Keycloak is the only way in.
const options = { keycloak: true, localForMembers: false };

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimarySessionState: () => ({
    data: { signInOptions: options },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  startKeycloak: start,
}));
// The MCP page asks the Hub about the request; a signed-out browser gets no CSRF token.
vi.mock("~/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/runtime")>()),
  runPrimaryHttp: () =>
    Promise.resolve({
      kind: "ok",
      value: { clientName: "Some Agent", redirectHost: "agent.test", environmentHost: "hub.test" },
    }),
}));

const CHALLENGE = "A".repeat(43);
const STATE = "state-state-state-1";
const REDIRECT = "http://127.0.0.1:4455/callback";

const appQuery = new URLSearchParams({
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: STATE,
  client: "My Laptop",
}).toString();

it("offers Keycloak on app sign-in and comes back to the same request, nothing more", async () => {
  start.mockClear();
  // A refused earlier attempt left its reason in the address: it must not travel on.
  window.history.replaceState(null, "", `/app-sign-in?${appQuery}&keycloak=failed`);
  await using _screen = await render(<AppSignInSurface signedIn={false} />, { router: false });
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();
  expect(start).toHaveBeenCalledTimes(1);
  const input = start.mock.calls[0]![0] as { intent: string; returnTo: string };
  expect(input.intent).toBe("sign-in");
  expect(input.returnTo).not.toContain("keycloak=");
  expect(input.returnTo.startsWith("/app-sign-in?")).toBe(true);
  const params = new URL(input.returnTo, "https://hub.invalid").searchParams;
  expect(params.get("redirect_uri")).toBe(REDIRECT);
  expect(params.get("code_challenge")).toBe(CHALLENGE);
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("state")).toBe(STATE);
  expect(params.get("client")).toBe("My Laptop");
  expect([...params.keys()]).toHaveLength(5);
});

it("offers Keycloak on the MCP connect page and comes back to the same request", async () => {
  start.mockClear();
  const mcp = new URLSearchParams({
    response_type: "code",
    client_id: "client-1",
    redirect_uri: "http://127.0.0.1:9000/cb",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: STATE,
    resource: "https://hub.test/mcp",
  });
  window.history.replaceState(null, "", `/connect-agent?${mcp.toString()}`);
  await using _screen = await render(<ConnectAgentSurface />, { router: false });
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();
  const input = start.mock.calls[0]![0] as { returnTo: string };
  expect(input.returnTo.startsWith("/connect-agent?")).toBe(true);
  expect(new URL(input.returnTo, "https://hub.invalid").searchParams.toString()).toBe(
    new URLSearchParams(mcp).toString(),
  );
});
