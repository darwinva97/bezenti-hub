import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SignInSurface } from "./SignInSurface";

// Keycloak sign-in, ticket 07: a browser that signed out of a Keycloak sign-in lands here with the
// sign-out's handle in the fragment, and may leave Keycloak too.

const leave = vi.hoisted(() => vi.fn((_handle: string) => Promise.resolve("ended" as const)));
// Keycloak 08: whether everyone but the Owner may still sign in locally.
const options = vi.hoisted(() => ({ current: { keycloak: true, localForMembers: true } }));

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimarySessionState: () => ({
    data: { signInOptions: options.current },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  signOutOfKeycloak: leave,
}));

it("offers to sign out of Keycloak too, says what else it ends, and drops the handle from the address", async () => {
  window.history.replaceState(null, "", "/sign-in#keycloak-sign-out=handle-from-sign-out");
  await using _screen = await render(<SignInSurface onSignedIn={() => undefined} />, {
    router: false,
  });
  await expect
    .element(page.getByText("You signed out of this Hub.", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText(/also signs out the apps and outside agents you approved/))
    .toBeVisible();
  // The handle lives in the page only: never in its address or history.
  expect(window.location.hash).toBe("");
  await page.getByRole("button", { name: "Also sign out of Keycloak" }).click();
  expect(leave).toHaveBeenCalledWith("handle-from-sign-out");
  // Done without a realm address to go to: the offer goes away.
  await expect
    .element(page.getByRole("button", { name: "Also sign out of Keycloak" }))
    .not.toBeInTheDocument();
});

it("offers nothing after a sign-out that came from no Keycloak sign-in", async () => {
  window.history.replaceState(null, "", "/sign-in");
  await using _screen = await render(<SignInSurface onSignedIn={() => undefined} />, {
    router: false,
  });
  await expect.element(page.getByRole("button", { name: "Sign in with Keycloak" })).toBeVisible();
  expect(page.getByRole("button", { name: "Also sign out of Keycloak" }).elements()).toHaveLength(
    0,
  );
});

it("folds the local form under «Owner access» while local sign-in is the Owner's alone", async () => {
  options.current = { keycloak: true, localForMembers: false };
  window.history.replaceState(null, "", "/sign-in");
  try {
    await using _screen = await render(<SignInSurface onSignedIn={() => undefined} />, {
      router: false,
    });
    await expect.element(page.getByRole("button", { name: "Sign in with Keycloak" })).toBeVisible();
    expect(page.getByRole("button", { name: "Sign in with a passkey" }).elements()).toHaveLength(0);
    // Still there for the Owner's break-glass, one click away.
    const ownerAccess = page.getByRole("button", { name: "Owner access" });
    await expect.element(ownerAccess).toHaveAttribute("aria-expanded", "false");
    await ownerAccess.click();
    await expect.element(ownerAccess).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByRole("button", { name: "Sign in with a passkey" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Lost your passkey? Use a recovery code" }))
      .toBeVisible();
  } finally {
    options.current = { keycloak: true, localForMembers: true };
  }
});

it("shows the local form open while everyone may sign in locally", async () => {
  window.history.replaceState(null, "", "/sign-in");
  await using _screen = await render(<SignInSurface onSignedIn={() => undefined} />, {
    router: false,
  });
  await expect.element(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  expect(page.getByRole("button", { name: "Owner access" }).elements()).toHaveLength(0);
});
