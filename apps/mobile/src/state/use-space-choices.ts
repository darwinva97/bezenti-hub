import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../components/ui/Dialog";
import type { HomeListSpaceChoice } from "../features/home/home-list-filter-menu";
import { createOrganization, useLoadSpaces, useSpaceSelections } from "./spaces";
import { useSavedRemoteConnections } from "./use-remote-environment-registry";

/** The Space selector's choices: every connected Hub that lists Spaces for its signed-in User. */
export function useSpaceChoices(): ReadonlyArray<HomeListSpaceChoice> {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  useLoadSpaces(connections);
  const selections = useSpaceSelections();
  return connections.flatMap((connection) => {
    const selection = selections.get(connection.environmentId);
    if (selection?.view == null || selection.view.spaces.length === 0) return [];
    return [
      {
        environmentId: connection.environmentId,
        environmentLabel: connection.environmentLabel,
        spaces: selection.view.spaces.map((space) => ({ id: space.id, name: space.name })),
        currentSpaceId: selection.currentSpaceId,
        canCreateOrganization: selection.view.canCreateOrganization,
      },
    ];
  });
}

/** «Create organization» on a Hub: asks for the name, then creates it and switches to it. */
export function useCreateOrganization(): (environmentId: EnvironmentId) => void {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (environmentId) => {
    const connection = savedConnectionsById[environmentId];
    if (connection === undefined) return;
    Dialog.prompt({
      title: "Create organization",
      message: "A Space your team shares. You run it and invite people to it.",
      confirmText: "Create",
      initialValue: "",
      onConfirm: (value) => {
        const name = value.trim();
        if (name.length === 0) return;
        createOrganization(connection, name).catch((cause: unknown) => {
          Dialog.alert(
            "Could not create the organization",
            cause instanceof Error && cause.message.length > 0 ? cause.message : "Try again.",
          );
        });
      },
    });
  };
}
