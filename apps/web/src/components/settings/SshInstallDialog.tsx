import type { SpaceId, SshInstallRun, SshInstallStep } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  cancelSshInstall,
  confirmSshInstall,
  defaultMachineName,
  fetchSshInstall,
  startSshInstall,
} from "../../environments/primary/sshInstall";
import { errorMessageOf } from "../../lib/errorMessage";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

// The steps report their output as they go.
const RUNNING_REFRESH_MS = 1_000;

const STEP_STATE_LABELS: Record<SshInstallStep["state"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Not run",
};

const STEP_STATE_TONES: Record<SshInstallStep["state"], string> = {
  pending: "text-muted-foreground",
  running: "text-foreground",
  succeeded: "text-success-foreground",
  failed: "text-destructive-foreground",
  cancelled: "text-muted-foreground",
};

interface FormState {
  host: string;
  port: string;
  username: string;
  authKind: "key" | "agent";
  privateKey: string;
  passphrase: string;
  spaceId: string;
  name: string;
  hubUrl: string;
  keepForUpdates: boolean;
}

const fieldClass = "text-xs font-medium";

const isFinished = (run: SshInstallRun) =>
  run.state !== "awaiting-host-key" && run.state !== "running";

/**
 * Settings → Environments, for the Owner and the Admins of an Organization (for the Organizations
 * they run): «Add a machine over SSH». The Hub connects from its own
 * process, shows the host key to confirm, then runs each step with its output here. The key goes
 * only into the request that starts the run, and is forgotten here once the run starts.
 */
const AUTH_ITEMS = [
  { value: "key", label: "A private key" },
  { value: "agent", label: "The Hub's SSH agent" },
];
/** Stands for «no Organization yet»: never sent, the connect button stays off. */
const NO_ORGANIZATION = "no-organization";

export function SshInstallDialog(props: {
  readonly organizations: ReadonlyArray<{ readonly id: SpaceId; readonly name: string }>;
  readonly onClose: () => void;
  /** A machine was added: the list should show it. */
  readonly onInstalled: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    host: "",
    port: "22",
    username: "",
    authKind: "key",
    privateKey: "",
    passphrase: "",
    spaceId: props.organizations[0]?.id ?? "",
    name: "",
    hubUrl: window.location.origin,
    keepForUpdates: false,
  }));
  // The Organizations may load after the dialog opens: the choice is the one made while it is
  // still listed, else the first one.
  const spaceId = props.organizations.some((space) => space.id === form.spaceId)
    ? form.spaceId
    : (props.organizations[0]?.id ?? "");
  const spaceItems =
    props.organizations.length === 0
      ? [{ value: NO_ORGANIZATION, label: "Create an Organization first" }]
      : props.organizations.map((space) => ({
          value: space.id as string,
          label: `Everyone in ${space.name}`,
        }));
  const [run, setRun] = useState<SshInstallRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Closed while the Hub was still reading the host key: that run is cancelled once it answers.
  const closedRef = useRef(false);
  // While its confirm is on its way, the run is as good as running.
  const [confirming, setConfirming] = useState(false);
  const running = run?.state === "running";
  const runId = run?.runId;

  const finished = useEffectEvent((next: SshInstallRun) => {
    if (next.state === "succeeded") props.onInstalled();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Hub for the run's steps and output while it runs.
  useEffect(() => {
    if (runId === undefined || !running) return;
    let current = true;
    const timer = window.setInterval(() => {
      void fetchSshInstall(runId).then(
        (next) => {
          if (!current) return;
          setRun(next);
          if (next.state !== "running") finished(next);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not follow the installation."));
        },
      );
    }, RUNNING_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [runId, running]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const act = async (action: () => Promise<SshInstallRun>, fallback: string) => {
    setPending(true);
    setError(null);
    try {
      const next = await action();
      setRun(next);
      return next;
    } catch (cause) {
      setError(errorMessageOf(cause, fallback));
      return null;
    } finally {
      setPending(false);
    }
  };

  const connect = async () => {
    const started = await act(
      () =>
        startSshInstall({
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username.trim(),
          auth:
            form.authKind === "agent"
              ? { kind: "agent" }
              : { kind: "key", privateKey: form.privateKey, passphrase: form.passphrase },
          spaceId: spaceId as SpaceId,
          name: form.name.trim() || defaultMachineName(form.host),
          hubUrl: form.hubUrl.trim(),
          keepForUpdates: form.keepForUpdates,
        }),
      "The Hub could not reach the machine.",
    );
    // The Hub holds it for the run now; nothing here keeps it.
    if (started !== null) setForm((current) => ({ ...current, privateKey: "", passphrase: "" }));
    if (started !== null && closedRef.current && !isFinished(started)) {
      void cancelSshInstall(started.runId).catch(() => undefined);
    }
  };

  // Closing ends a run that has not finished: none waits on its host key, or goes on unseen.
  const close = () => {
    if (
      (running || confirming) &&
      !window.confirm("Closing cancels the installation and undoes what it did. Close anyway?")
    ) {
      return;
    }
    closedRef.current = true;
    if (run !== null && !isFinished(run)) {
      void cancelSshInstall(run.runId).catch(() => undefined);
    }
    props.onClose();
  };

  const canConnect =
    form.host.trim() !== "" &&
    form.username.trim() !== "" &&
    /^\d+$/u.test(form.port) &&
    spaceId !== "" &&
    (form.authKind === "agent" || form.privateKey.trim() !== "");

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a machine over SSH</DialogTitle>
          <DialogDescription>
            The Hub signs in to the machine, checks it and installs Podman if it can, installs this
            Hub's version of T3 Code, registers the machine for one Organization and starts its
            service. The key is used for this run only unless you keep it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {run === null ? (
            <form
              className="grid gap-3"
              id="ssh-install-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (canConnect && !pending) void connect();
              }}
            >
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <div>
                  <label className={fieldClass} htmlFor="ssh-install-host">
                    Host
                  </label>
                  <Input
                    id="ssh-install-host"
                    nativeInput
                    placeholder="vps.example.com"
                    value={form.host}
                    onChange={(event) => set("host", event.currentTarget.value)}
                  />
                </div>
                <div>
                  <label className={fieldClass} htmlFor="ssh-install-port">
                    Port
                  </label>
                  <Input
                    id="ssh-install-port"
                    inputMode="numeric"
                    nativeInput
                    value={form.port}
                    onChange={(event) => set("port", event.currentTarget.value)}
                  />
                </div>
              </div>
              <div>
                <label className={fieldClass} htmlFor="ssh-install-user">
                  User
                </label>
                <Input
                  autoComplete="off"
                  id="ssh-install-user"
                  nativeInput
                  placeholder="deploy (not root)"
                  value={form.username}
                  onChange={(event) => set("username", event.currentTarget.value)}
                />
              </div>
              <div>
                <label className={fieldClass} htmlFor="ssh-install-auth">
                  Sign in with
                </label>
                <div className="mt-1">
                  <Select
                    items={AUTH_ITEMS}
                    value={form.authKind}
                    onValueChange={(value) => set("authKind", value === "agent" ? "agent" : "key")}
                  >
                    <SelectTrigger id="ssh-install-auth">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {AUTH_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              {form.authKind === "key" ? (
                <>
                  <div>
                    <label className={fieldClass} htmlFor="ssh-install-key">
                      Private key
                    </label>
                    <Textarea
                      autoComplete="off"
                      id="ssh-install-key"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      rows={5}
                      spellCheck={false}
                      value={form.privateKey}
                      onChange={(event) => set("privateKey", event.currentTarget.value)}
                    />
                  </div>
                  <div>
                    <label className={fieldClass} htmlFor="ssh-install-passphrase">
                      Passphrase (if the key has one)
                    </label>
                    <Input
                      autoComplete="off"
                      id="ssh-install-passphrase"
                      nativeInput
                      type="password"
                      value={form.passphrase}
                      onChange={(event) => set("passphrase", event.currentTarget.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label="Keep the key for updates"
                      checked={form.keepForUpdates}
                      onCheckedChange={(checked) => set("keepForUpdates", checked === true)}
                    />
                    Keep the key for updates (in the Hub's secret store)
                  </label>
                </>
              ) : null}
              <div>
                <label className={fieldClass} htmlFor="ssh-install-space">
                  Dedicated to
                </label>
                <div className="mt-1">
                  <Select
                    disabled={props.organizations.length === 0}
                    items={spaceItems}
                    value={props.organizations.length === 0 ? NO_ORGANIZATION : spaceId}
                    onValueChange={(value) => {
                      if (value !== null && value !== NO_ORGANIZATION) set("spaceId", value);
                    }}
                  >
                    <SelectTrigger id="ssh-install-space">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {spaceItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={fieldClass} htmlFor="ssh-install-name">
                    Name
                  </label>
                  <Input
                    id="ssh-install-name"
                    maxLength={64}
                    nativeInput
                    placeholder={defaultMachineName(form.host) || "Acme VPS"}
                    value={form.name}
                    onChange={(event) => set("name", event.currentTarget.value)}
                  />
                </div>
                <div>
                  <label className={fieldClass} htmlFor="ssh-install-hub">
                    Hub address, as the machine reaches it
                  </label>
                  <Input
                    id="ssh-install-hub"
                    nativeInput
                    value={form.hubUrl}
                    onChange={(event) => set("hubUrl", event.currentTarget.value)}
                  />
                </div>
              </div>
            </form>
          ) : (
            <RunView run={run} />
          )}
          {error !== null ? (
            <p className="mt-3 text-sm text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {run === null ? (
            <>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!canConnect || pending} form="ssh-install-form" type="submit">
                {pending ? "Connecting…" : "Connect"}
              </Button>
            </>
          ) : run.state === "awaiting-host-key" ? (
            <>
              <Button disabled={pending} type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={pending || run.hostKey === null}
                onClick={() => {
                  setConfirming(true);
                  void act(
                    () => confirmSshInstall(run.runId, run.hostKey?.fingerprint ?? ""),
                    "The installation did not start.",
                  ).finally(() => setConfirming(false));
                }}
              >
                Trust this key and install
              </Button>
            </>
          ) : running ? (
            <Button
              disabled={pending}
              variant="destructive-outline"
              onClick={() => void act(() => cancelSshInstall(run.runId), "Could not cancel.")}
            >
              {pending ? "Cancelling…" : "Cancel installation"}
            </Button>
          ) : (
            <>
              {run.state !== "succeeded" ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setRun(null);
                    setError(null);
                  }}
                >
                  Try again
                </Button>
              ) : null}
              <Button onClick={props.onClose}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RunView(props: { readonly run: SshInstallRun }) {
  const { run } = props;
  const target = `${run.username}@${run.host}:${run.port}`;
  if (run.state === "awaiting-host-key" && run.hostKey !== null) {
    return (
      <div className="grid gap-2 text-sm">
        <p>{`${target} shows this host key. Check it is the machine's before you trust it:`}</p>
        <p
          aria-label="Host key fingerprint"
          className="rounded-md bg-muted/50 p-2 font-mono text-xs break-all"
        >
          {`${run.hostKey.algorithm} ${run.hostKey.fingerprint}`}
        </p>
        <p className="text-muted-foreground">
          On the machine, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints its fingerprint.
          A key that changes later is refused.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p>
        {run.state === "succeeded"
          ? `${run.name} is dedicated to ${run.spaceName} and online.`
          : run.state === "running"
            ? `Installing ${run.name} on ${target} for ${run.spaceName}…`
            : run.state === "cancelled"
              ? `The installation on ${target} was cancelled.`
              : `The installation on ${target} stopped.`}
        {run.state === "succeeded" && run.keyKept ? " Its key is kept for updates." : ""}
      </p>
      {run.error !== null ? (
        <p className="text-destructive-foreground" role="alert">
          {run.error}
        </p>
      ) : null}
      <ol className="grid gap-2">
        {run.steps.map((step, index) => (
          <li key={step.id} aria-label={`Step ${index + 1}: ${step.title}`}>
            <div className="flex items-center gap-2">
              {step.state === "running" ? <Spinner size="sm" /> : null}
              <span className="font-medium">{`${index + 1}. ${step.title}`}</span>
              <span className={`text-xs ${STEP_STATE_TONES[step.state]}`}>
                {STEP_STATE_LABELS[step.state]}
              </span>
            </div>
            {step.output.length > 0 ? (
              <pre
                aria-label={`Output of ${step.title}`}
                className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs leading-4 whitespace-pre-wrap"
                role="log"
                // The newest lines are the ones to follow while it runs.
                ref={(node) => {
                  if (node !== null) node.scrollTop = node.scrollHeight;
                }}
              >
                {step.output.join("\n")}
              </pre>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
