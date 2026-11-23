import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../components/ui/Dialog";
import { type HomeListSpaceChoice, spaceChoiceOf } from "../features/home/home-list-filter-menu";
import { createOrganization, useLoadSpaces, useSpaceSelections } from "./spaces";
import { useSavedRemoteConnections } from "./use-remote-environment-registry";

/** The Space selector's choices: every connected Hub that lists Spaces for its signed-in User. */
export function useSpaceChoices(): ReadonlyArray<HomeListSpaceChoice> {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  useLoadSpaces(connections);
  const selections = useSpaceSelections();
  // Each Space with the loans waiting there for the viewer; the count refreshes with the directory.
  return connections.flatMap((connection) => {
    const choice = spaceChoiceOf(connection, selections.get(connection.environmentId));
    return choice === null ? [] : [choice];
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
