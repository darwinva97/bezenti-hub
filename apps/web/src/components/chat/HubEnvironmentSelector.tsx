import type { EnvironmentId, ProviderInstanceId, SpaceId } from "@t3tools/contracts";
import { memo } from "react";

import {
  chooseHubEnvironment,
  environmentUnavailableReason,
  noPlacementReason,
  placeableEnvironments,
  useHubEnvironmentChoice,
  useHubEnvironments,
  useHubEnvironmentsReady,
  useSandboxesUnavailable,
  previewDefaultEnvironment,
} from "../../environments/primary/useHubEnvironments";
import { useCurrentSpace } from "../../state/currentSpace";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * The Space a new Thread of the Project is claimed in, as the Hub claims it: the Project's, or for
 * a Project without one (the scratch Project, one from before Spaces) the Owner's Personal space,
 * which only the Owner knows (anyone else may run nothing there). Null: unknown.
 */
function useNewThreadSpaceId(projectSpaceId: SpaceId | null): SpaceId | null {
  const ownersSpaceId = useCurrentSpace((state) =>
    state.view?.isOwner === true ? state.view.personalSpaceId : null,
  );
  return projectSpaceId ?? ownersSpaceId;
}

/**
 * Spec 4 ticket 08: where a draft will run (the User's pick, else the Hub's default for it) and
 * the Space it is claimed in, so its composer offers that machine's providers and its AI-account
 * picker asks about it. Asked before a provider is chosen: the composer then offers only that
 * machine's, so the Hub places the Thread there too. Null: unknown.
 */
export function useDraftPlacement(input: {
  readonly draftThreadId: string | null;
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly spaceId: SpaceId | null;
}): { readonly environmentId: EnvironmentId | null; readonly spaceId: SpaceId | null } {
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  const spaceId = useNewThreadSpaceId(input.spaceId);
  const all = useHubEnvironments();
  const unavailable = useSandboxesUnavailable();
  const chosen = useHubEnvironmentChoice(input.draftThreadId ?? "");
  if (input.draftThreadId === null) return { environmentId: null, spaceId };
  if (chosen !== undefined) return { environmentId: chosen, spaceId };
  const placed = previewDefaultEnvironment({
    environments: placeableEnvironments(all, spaceId),
    preferredEnvironmentId: input.preferredEnvironmentId,
    providerInstanceId: null,
    userId,
    sandboxesUnavailable: unavailable,
  });
  return { environmentId: placed, spaceId };
}

/**
 * Why a new Thread nobody placed could run nowhere (the Hub has no Sandbox for it and does not
 * run it itself), as the composer says it before sending; null when it can run somewhere, when
 * the User chose a machine, or until the Environments list is read.
 */
export function useNoPlacementMessage(input: {
  readonly draftThreadId: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly spaceId: SpaceId | null;
}): string | null {
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  const spaceId = useNewThreadSpaceId(input.spaceId);
  const all = useHubEnvironments();
  const ready = useHubEnvironmentsReady();
  const unavailable = useSandboxesUnavailable();
  const chosen = useHubEnvironmentChoice(input.draftThreadId ?? "");
  if (!ready || input.draftThreadId === null) return null;
  if (chosen !== undefined) return null;
  const placed = previewDefaultEnvironment({
    environments: placeableEnvironments(all, spaceId),
    preferredEnvironmentId: input.preferredEnvironmentId,
    providerInstanceId: input.providerInstanceId,
    userId,
    sandboxesUnavailable: unavailable,
  });
  return placed === null ? noPlacementReason(unavailable) : null;
}

/**
 * Where a new Thread runs, among the Environments the User may use for the Project's Space (the
 * Hub decides and checks). Left alone it shows the Hub's own default (`previewThreadPlacement`);
 * a pick is sent as the User's choice. A stopped Sandbox is offered: sending starts it.
 */
export const HubEnvironmentSelector = memo(function HubEnvironmentSelector({
  draftThreadId,
  providerInstanceId,
  preferredEnvironmentId,
  spaceId,
}: {
  draftThreadId: string;
  /** Null until the composer has a provider: the machines are offered all the same. */
  providerInstanceId: ProviderInstanceId | null;
  preferredEnvironmentId: EnvironmentId | null;
  /** The Project's Space; null for a Project from before Spaces, the Owner's Personal space. */
  spaceId: SpaceId | null;
}) {
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  const environments = placeableEnvironments(useHubEnvironments(), useNewThreadSpaceId(spaceId));
  const sandboxesUnavailable = useSandboxesUnavailable();
  const chosen = useHubEnvironmentChoice(draftThreadId);
  const floatingLayerProps = useComposerMenuProps();
  const defaultId = previewDefaultEnvironment({
    environments,
    preferredEnvironmentId,
    providerInstanceId,
    userId,
    sandboxesUnavailable,
  });
  // One machine to pick from is no choice, unless the Thread would otherwise run nowhere.
  if (environments.length === 0 || (environments.length < 2 && defaultId !== null)) return null;
  const selectedId = chosen ?? defaultId;
  const selected = environments.find((environment) => environment.id === selectedId);
  const items = environments.map((environment) => ({
    value: environment.id,
    label: environment.name,
  }));
  return (
    <Select
      modal={false}
      value={selectedId}
      onValueChange={(value) => chooseHubEnvironment(draftThreadId, value)}
      items={items}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Environment"
              data-composer-context-control
            />
          }
        >
          <EnvironmentMachineIcon
            kind={selected === undefined || selected.kind !== "external" ? "server" : "desktop"}
            className="size-3 shrink-0"
          />
          <ComposerContextLabel>
            <SelectValue placeholder="No Environment" />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {selected === undefined ? "Choose where this Thread runs" : `Runs on ${selected.name}`}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...floatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on Environment</SelectGroupLabel>
          {environments.map((environment) => {
            const reason = environmentUnavailableReason(environment, providerInstanceId);
            return (
              <SelectItem
                key={environment.id}
                value={environment.id}
                disabled={reason !== null}
                aria-label={reason === null ? environment.name : `${environment.name}, ${reason}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <EnvironmentMachineIcon
                    kind={environment.kind === "external" ? "desktop" : "server"}
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">{environment.name}</span>
                  {reason === null ? null : (
                    <span className="text-muted-foreground">· {reason}</span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
