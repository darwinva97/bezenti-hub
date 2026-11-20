import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ResetPasskeySurface } from "./ResetPasskeySurface";

// Keycloak sign-in, ticket 08: an Owner's reset link may bind a Keycloak account; while local
// sign-in is the Owner's alone, that is all it offers.

const status = vi.hoisted(() => ({
  current: {
    status: "valid" as const,
    displayName: "Ana",
    loginName: "ana",
    passwordAllowed: false,
    local: false,
    keycloak: true,
  },
}));
const start = vi.hoisted(() => vi.fn((_input: unknown) => new Promise<void>(() => undefined)));
const token = vi.hoisted(() => ({ current: "reset-token-from-the-link" as string | null }));

vi.mock("../../environments/primary/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/auth")>()),
  peekPairingTokenFromUrl: () => token.current,
  stripPairingTokenFromUrl: () => undefined,
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  fetchResetLinkStatus: () => Promise.resolve(status.current),
  startKeycloak: start,
}));

it("offers only Keycloak while local sign-in is the Owner's alone", async () => {
  window.history.replaceState(null, "", "/reset");
  await using _screen = await render(<ResetPasskeySurface onFinished={() => undefined} />, {
    router: false,
  });
  const keycloak = page.getByRole("button", { name: "Continue with Keycloak" });
  await expect.element(keycloak).toBeVisible();
  expect(page.getByRole("button", { name: "Register a new passkey" }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Set a new password instead" }).elements()).toHaveLength(
    0,
  );
  await keycloak.click();
  expect(start).toHaveBeenCalledWith({
    intent: "reset",
    returnTo: "/",
    resetToken: "reset-token-from-the-link",
  });
});

it("says why a reset through Keycloak did not go through", async () => {
  // The refusal lands here without the link: its token is never in an address.
  token.current = null;
  window.history.replaceState(null, "", "/reset?keycloak=taken");
  await using _screen = await render(<ResetPasskeySurface onFinished={() => undefined} />, {
    router: false,
  });
  await expect
    .element(page.getByText("That Keycloak account is already connected", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("Open your reset link again", { exact: false }))
    .toBeVisible();
});
