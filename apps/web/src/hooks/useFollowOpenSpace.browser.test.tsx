import {
  EnvironmentId,
  SpaceId,
  ThreadId,
  UserId,
  type ScopedThreadRef,
  type SpaceDirectoryView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { selectSpace, useCurrentSpace } from "../state/currentSpace";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useFollowOpenSpace } from "./useFollowOpenSpace";

vi.mock("../state/entities", { spy: true });

const hub = EnvironmentId.make("hub");
const personal = SpaceId.make("personal:eijun");
const acme = SpaceId.make("org-acme");
const view = {
  userId: UserId.make("eijun"),
  personalSpaceId: personal,
  canCreateOrganization: false,
  isOwner: false,
  spaces: [
    { id: personal, kind: "personal", name: "Personal", role: null, isOwn: true },
    { id: acme, kind: "organization", name: "Acme", role: "member", isOwn: false },
  ],
} as unknown as SpaceDirectoryView;

const threadRef = (id: string): ScopedThreadRef => ({
  environmentId: hub,
  threadId: ThreadId.make(id),
});

function Probe(props: { readonly threadRef: ScopedThreadRef | null }) {
  // Renders again on a pick, which calls the mocked `useProject` once more.
  useCurrentSpace((state) => state.currentSpaceId);
  useFollowOpenSpace({ threadRef: props.threadRef, draft: null });
  return null;
}

function setup(currentSpaceId: SpaceId, openSpaceId: SpaceId | null) {
  useCurrentSpace.setState({ environmentId: hub, view, currentSpaceId, loadFailed: false });
  vi.mocked(useQuietThreadShell).mockReturnValue({
    environmentId: hub,
    id: ThreadId.make("t-acme"),
    projectId: "p",
  } as never);
  vi.mocked(useProject).mockReturnValue(
    openSpaceId === null ? null : ({ environmentId: hub, id: "p", spaceId: openSpaceId } as never),
  );
}

describe("useFollowOpenSpace", () => {
  it("follows the Space of a Thread opened while another Space is current", async () => {
    setup(personal, acme);
    await using _screen = await render(<Probe threadRef={threadRef("t-acme")} />);
    expect(useCurrentSpace.getState().currentSpaceId).toBe(acme);
  });

  it("keeps an explicit pick while a Thread of another Space stays open", async () => {
    setup(acme, acme);
    await using _screen = await render(<Probe threadRef={threadRef("t-acme")} />);
    const before = vi.mocked(useProject).mock.calls.length;
    selectSpace(personal);
    await vi.waitFor(() => expect(vi.mocked(useProject).mock.calls.length).toBeGreaterThan(before));
    expect(useCurrentSpace.getState().currentSpaceId).toBe(personal);
  });
});
