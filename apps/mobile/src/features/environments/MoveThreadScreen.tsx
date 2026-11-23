import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  environmentStatusLabel,
  environmentUseDescription,
  shownEnvironmentStatus,
  canMoveThread,
  activeEnvironmentOf,
  environmentNameOf,
  environmentUnavailableReason,
  moveCandidates,
  moveExplanation,
  moveProgressView,
} from "@t3tools/client-runtime/environment/hub-environments";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type HubEnvironmentSummary,
  type OrchestrationV2ThreadMove,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import {
  refreshHubEnvironments,
  useHubEnvironments,
  useHubEnvironmentsStatus,
} from "../../state/hubEnvironments";
import { useSpaceSelections, useThreadRolePermissions } from "../../state/spaces";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { EnvironmentStatusDot } from "./EnvironmentStatusDot";

type MoveThreadRouteParams = { readonly environmentId: string; readonly threadId: string };

type SendState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "sent"; readonly moveStartedAfter: string | null }
  | { readonly status: "refused"; readonly message: string };

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

/** «Move to another Environment»: the same choices, rules and progress as the web dialog. */
export function MoveThreadRouteScreen({ route }: StaticScreenProps<MoveThreadRouteParams>) {
  const threadRef: ScopedThreadRef = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    threadId: ThreadId.make(route.params.threadId),
  };
  return <MoveThreadForm threadRef={threadRef} />;
}

function MoveThreadForm({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useThreadShell(threadRef);
  const environments = useHubEnvironments();
  const listStatus = useHubEnvironmentsStatus();
  const role = useThreadRolePermissions(threadRef.environmentId, thread?.source ?? null);
  const project = useProject(
    thread === null
      ? null
      : { environmentId: threadRef.environmentId, projectId: thread.projectId },
  );
  const serverConfig = useEnvironmentServerConfig(threadRef.environmentId);
  const move = useAtomCommand(threadEnvironment.move, { reportFailure: false });
  const cancel = useAtomCommand(threadEnvironment.cancelMove, { reportFailure: false });
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [ifRunning, setIfRunning] = useState<"wait" | "stop">("wait");
  const [send, setSend] = useState<SendState>({ status: "idle" });
  const [cancelError, setCancelError] = useState<string | null>(null);

  // A Thread without a Project moves its own folder: no worktree, no setup script.
  const withoutProject =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const sourceId = thread?.activeEnvironmentId;
  const sourceName = environmentNameOf(environments, sourceId);
  const currentMove: OrchestrationV2ThreadMove | null = thread?.move ?? null;
  // The move this screen started: the Thread's move once it began after the screen sent it.
  const ownMove =
    send.status === "sent" &&
    currentMove !== null &&
    (send.moveStartedAfter === null || currentMove.id !== send.moveStartedAfter)
      ? currentMove
      : null;
  const shownMove = ownMove ?? (currentMove?.status === "running" ? currentMove : null);
  const turnRunning = thread !== null && threadRuntimeIsActive(thread.runtime);
  const candidates = moveCandidates(environments, sourceId);
  const source = activeEnvironmentOf(environments, sourceId);
  const sourceAway = source !== null && !source.isHubMachine && source.status !== "online";
  const providerInstanceId = thread?.modelSelection.instanceId;
  const reasonOf = (environment: HubEnvironmentSummary) =>
    providerInstanceId === undefined
      ? null
      : environmentUnavailableReason(environment, providerInstanceId);
  // A machine lent to the Space says who lent it and that they see everything that runs there.
  const spaces = useSpaceSelections().get(threadRef.environmentId)?.view?.spaces ?? [];
  const lentNote = (environment: HubEnvironmentSummary) =>
    environment.lent === undefined
      ? null
      : environmentUseDescription(environment, {
          spaceName: spaces.find((space) => space.id === environment.spaceId)?.name,
        });
  const targetName = environmentNameOf(environments, shownMove?.targetEnvironmentId ?? target);
  const movedFromName =
    shownMove === null
      ? sourceName
      : environmentNameOf(environments, shownMove.sourceEnvironmentId);
  const starting = send.status === "sent" && shownMove === null;
  const running = shownMove?.status === "running";
  const close = () => navigation.goBack();

  const submit = async () => {
    if (target === null) return;
    setSend({ status: "sending" });
    const result = await move({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, targetEnvironmentId: target, ifRunning },
    });
    if (result._tag === "Success") {
      setSend({ status: "sent", moveStartedAfter: currentMove?.id ?? null });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setSend({ status: "idle" });
      return;
    }
    setSend({
      status: "refused",
      message: failureMessage(result, "The Thread could not be moved."),
    });
  };

  const cancelMove = async () => {
    const result = await cancel({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setCancelError(
      result._tag === "Success" || isAtomCommandInterrupted(result)
        ? null
        : failureMessage(result, "The move could not be cancelled."),
    );
  };

  // The same rule as the row menu; the Hub refuses anyone else anyway.
  const allowed = canMoveThread({
    canContinue: role.canContinue,
    environmentCount: environments.length,
    activeEnvironmentId: sourceId,
  });
  if (thread !== null && !role.canContinue) {
    return (
      <SettingsScreen formSheet title="Move to another Environment">
        <Text accessibilityRole="alert" className="px-5 pt-4 text-sm text-foreground-muted">
          Only someone who may continue this Thread can move it.
        </Text>
      </SettingsScreen>
    );
  }
  return (
    <SettingsScreen formSheet title="Move to another Environment">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          gap: 20,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 16,
          paddingTop: 4,
        }}
      >
        <Text className="px-1 text-sm leading-normal text-foreground-muted">
          {moveExplanation({
            sourceRemoved: sourceId === null && shownMove === null,
            sourceName: movedFromName,
            withoutProject,
          })}
        </Text>
        {starting ? (
          <Text accessibilityLiveRegion="polite" className="px-1 text-sm">
            Starting the move…
          </Text>
        ) : shownMove === null ? (
          <>
            <ListSection title="Environment">
              {listStatus === "loading" ? (
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  Loading this Hub's machines…
                </Text>
              ) : listStatus === "error" && environments.length === 0 ? (
                <View accessibilityRole="alert" className="flex-row items-center gap-3 px-4 py-3">
                  <Text className="flex-1 text-sm text-danger-foreground">
                    Could not load this Hub's machines.
                  </Text>
                  <Button
                    label="Try again"
                    size="compact"
                    tone="secondary"
                    onPress={refreshHubEnvironments}
                  />
                </View>
              ) : candidates.length === 0 || !allowed ? (
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  No other Environment you can use is joined to this Hub.
                </Text>
              ) : (
                candidates.map((environment, index) => {
                  const reason = reasonOf(environment);
                  const status = shownEnvironmentStatus(environment);
                  return (
                    <View key={environment.id} className="flex-row items-center pl-3">
                      <EnvironmentStatusDot status={status} />
                      <View className="flex-1">
                        <ListChoiceRow
                          label={environment.name}
                          description={
                            reason ??
                            [
                              environmentStatusLabel(status, environment.kind),
                              lentNote(environment),
                            ]
                              .filter((part) => part !== null)
                              .join(" · ")
                          }
                          selected={target === environment.id}
                          disabled={reason !== null}
                          separated={index > 0}
                          onPress={() => setTarget(environment.id)}
                        />
                      </View>
                    </View>
                  );
                })
              )}
            </ListSection>
            {turnRunning ? (
              <ListSection
                title="A turn is running"
                footer={
                  sourceAway
                    ? `The turn is paused: ${sourceName} is offline. Waiting means the move waits for ${sourceName} to come back; stopping the turn moves the Thread now.`
                    : undefined
                }
              >
                <ListChoiceRow
                  label="Wait for the turn to finish"
                  selected={ifRunning === "wait"}
                  onPress={() => setIfRunning("wait")}
                />
                <ListChoiceRow
                  label="Stop the turn"
                  selected={ifRunning === "stop"}
                  separated
                  onPress={() => setIfRunning("stop")}
                />
              </ListSection>
            ) : null}
            {send.status === "refused" ? (
              <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">
                {send.message}
              </Text>
            ) : null}
            <Button
              label="Move Thread"
              loading={send.status === "sending"}
              disabled={target === null || send.status === "sending"}
              onPress={() => void submit()}
              fullWidth
            />
          </>
        ) : (
          <>
            <MoveProgress move={shownMove} sourceName={movedFromName} targetName={targetName} />
            {cancelError === null ? null : (
              <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">
                {cancelError}
              </Text>
            )}
            {running ? (
              <Button
                label="Cancel move"
                tone="danger"
                onPress={() => void cancelMove()}
                fullWidth
              />
            ) : null}
            <Button
              label={running ? "Hide" : "Done"}
              tone={running ? "secondary" : "primary"}
              onPress={close}
              fullWidth
            />
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function MoveProgress(props: {
  readonly move: OrchestrationV2ThreadMove;
  readonly sourceName: string;
  readonly targetName: string;
}) {
  const view = moveProgressView(props.move, props.sourceName, props.targetName);
  return (
    <View className="gap-3 px-1">
      <Text accessibilityLiveRegion="polite" className="font-t3-medium text-sm">
        {view.summary}
      </Text>
      <View accessibilityLabel="Move progress" className="gap-1.5">
        {view.steps.map(({ step, label, state }) => (
          <Text
            key={step}
            accessibilityState={{ selected: state === "current" }}
            className={
              state === "pending"
                ? "text-sm text-foreground-muted"
                : state === "failed"
                  ? "text-sm text-danger-foreground"
                  : "text-sm"
            }
          >
            {state === "done"
              ? "✓ "
              : state === "failed"
                ? "✕ "
                : state === "current"
                  ? "… "
                  : "· "}
            {label}
          </Text>
        ))}
      </View>
      {view.continuesFrom === null ? null : (
        <Text className="text-sm text-foreground-muted">{view.continuesFrom}</Text>
      )}
      {view.failure === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {view.failure}
        </Text>
      )}
      {view.setAside === null ? null : (
        <Text className="text-sm text-foreground-muted">{view.setAside}</Text>
      )}
    </View>
  );
}
