import type { InvitationPreview } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { InvitationSurface } from "./InvitationSurface";

// Keycloak sign-in, ticket 04: a Platform invitation invites to the Hub itself, so the page names
// the Hub it was opened on and no Organization or Role; who is signed in already has an account.

const preview = vi.hoisted(() => ({
  answer: { status: "invalid" } as InvitationPreview,
}));
const join = vi.hoisted(() => vi.fn());

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimarySessionState: () => ({
    data: { signInOptions: { keycloak: true } },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  fetchInvitationPreview: () => Promise.resolve(preview.answer),
  joinInvitation: join,
}));

const platformPreview: InvitationPreview = {
  status: "valid",
  kind: "platform",
  inviterName: "Olive Owner",
  expiresAt: DateTime.makeUnsafe("2026-11-27T10:00:00.000Z"),
};

it("names the Hub, not an Organization, and offers an account to someone new", async () => {
  preview.answer = platformPreview;
  window.history.replaceState(null, "", "/invite#token=platform-token");
  await using _screen = await render(
    <InvitationSurface signedIn={false} onAccepted={() => undefined} />,
    { router: false },
  );
  await expect
    .element(page.getByRole("heading", { name: `Invitation to ${window.location.host}` }))
    .toBeVisible();
  await expect
    .element(page.getByText("Olive Owner invited you to create an account on this Hub."))
    .toBeVisible();
  expect(page.getByText(/^Join /).elements()).toHaveLength(0);
  await expect
    .element(page.getByRole("button", { name: "Sign in with Keycloak to accept" }))
    .toBeVisible();
  await expect.element(page.getByText("Your name")).toBeVisible();
  // The token never stays in the address.
  expect(window.location.hash).toBe("");
});

it("tells a signed-in User they already have an account, once, and joins nothing", async () => {
  preview.answer = platformPreview;
  window.history.replaceState(null, "", "/invite?keycloak=has-account#token=platform-token");
  await using _screen = await render(<InvitationSurface signedIn onAccepted={() => undefined} />, {
    router: false,
  });
  await expect
    .element(page.getByRole("heading", { name: `Invitation to ${window.location.host}` }))
    .toBeVisible();
  expect(page.getByText(/You already have an account on this Hub/).elements()).toHaveLength(1);
  await expect.element(page.getByRole("button", { name: "Open the Hub" })).toBeVisible();
  expect(page.getByRole("button", { name: /^Accept/ }).elements()).toHaveLength(0);
  expect(join).not.toHaveBeenCalled();
});
