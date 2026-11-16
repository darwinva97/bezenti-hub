import {
  isSecretReference,
  type EnvironmentId,
  type SecretProviderConfig,
  type SecretProviderId,
} from "@t3tools/contracts";
import type { OpenBaoAuthMethod } from "@t3tools/secret-provider-openbao/shared/definition";
import * as Result from "effect/Result";
import { useState, type ReactNode } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  draftFromSecretProvider,
  emptyOpenBaoDraft,
  OPENBAO_CREDENTIAL,
  secretProviderFromDraft,
  type OpenBaoDraft,
  type SecretProviderDraft,
} from "./SecretProviderDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SECRET_PROVIDER_KINDS } from "./secretProviderKinds";

const OPENBAO_METHODS: ReadonlyArray<{
  readonly value: OpenBaoAuthMethod;
  readonly label: string;
}> = [
  { value: "kubernetes", label: "Kubernetes (the Hub's ServiceAccount)" },
  { value: "jwt", label: "JWT from a file" },
  { value: "approle", label: "AppRole" },
  { value: "cert", label: "Client certificate" },
  { value: "token", label: "Token" },
  { value: "hub_identity", label: "This Hub's own identity (JWT)" },
];

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

/** Address, TLS, mounts, and the sign-in method with its own fields. */
function OpenBaoFields({
  draft,
  onChange,
  environmentId,
  selfId,
}: {
  readonly draft: OpenBaoDraft;
  readonly onChange: (patch: Partial<OpenBaoDraft>) => void;
  readonly environmentId: EnvironmentId;
  readonly selfId: SecretProviderId | undefined;
}) {
  // Another provider may hold this one's credential; never itself.
  const sources = useSecretSources(environmentId).filter((source) => source.id !== selfId);
  const credential = OPENBAO_CREDENTIAL[draft.authMethod];
  const reference = isSecretReference(draft.credential) ? draft.credential : undefined;
  const method = draft.authMethod;
  return (
    <>
      <Field
        id="openbao-address"
        label="Address"
        hint="https://, or http:// only to this machine (bao server -dev). Point it at the active node or the load balancer: a redirect to another host is not followed."
      >
        <Input
          id="openbao-address"
          placeholder="https://bao.example.com:8200"
          value={draft.address}
          onChange={(event) => onChange({ address: event.target.value })}
          spellCheck={false}
        />
      </Field>
      <Field id="openbao-namespace" label="Namespace (optional)">
        <Input
          id="openbao-namespace"
          value={draft.namespace}
          onChange={(event) => onChange({ namespace: event.target.value })}
          spellCheck={false}
        />
      </Field>
      <Field
        id="openbao-mounts"
        label="KV mounts"
        hint="One per line: its path and KV version, like kv v2 or team/legacy v1. References start with one of them."
      >
        <Textarea
          id="openbao-mounts"
          value={draft.mounts}
          onChange={(event) => onChange({ mounts: event.target.value })}
          spellCheck={false}
          rows={2}
        />
      </Field>
      <Field
        id="openbao-ca"
        label="CA certificate (optional)"
        hint="PEM. Added to the system's trusted CAs; certificate checks always stay on."
      >
        <Textarea
          id="openbao-ca"
          placeholder="-----BEGIN CERTIFICATE-----"
          value={draft.caCert}
          onChange={(event) => onChange({ caCert: event.target.value })}
          spellCheck={false}
          rows={2}
        />
      </Field>
      <Field id="openbao-method" label="Sign-in">
        <Select
          value={method}
          onValueChange={(value) => {
            if (value !== null)
              onChange({ authMethod: value as OpenBaoAuthMethod, credential: "" });
          }}
        >
          <SelectTrigger id="openbao-method" size="sm">
            <SelectValue>
              {OPENBAO_METHODS.find((option) => option.value === method)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {OPENBAO_METHODS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {method === "approle" ? (
        <Field id="openbao-role-id" label="Role ID">
          <Input
            id="openbao-role-id"
            value={draft.roleId}
            onChange={(event) => onChange({ roleId: event.target.value })}
            spellCheck={false}
          />
        </Field>
      ) : (
        <Field
          id="openbao-role"
          label={method === "cert" ? "Certificate role (optional)" : "Role"}
          hint={
            method === "kubernetes" || method === "jwt" || method === "hub_identity"
              ? "A Provider scope can sign in with its own role instead."
              : undefined
          }
        >
          <Input
            id="openbao-role"
            value={draft.authRole}
            onChange={(event) => onChange({ authRole: event.target.value })}
            spellCheck={false}
          />
        </Field>
      )}
      {method === "kubernetes" || method === "jwt" ? (
        <Field
          id="openbao-token-file"
          label={method === "jwt" ? "Token file" : "Token file (optional)"}
          hint="Read by the Hub, and only under the directories its operator allows in T3CODE_SECRET_PROVIDER_FILE_ROOTS (by default /var/run/secrets)."
        >
          <Input
            id="openbao-token-file"
            placeholder={
              method === "kubernetes" ? "/var/run/secrets/kubernetes.io/serviceaccount/token" : ""
            }
            value={draft.tokenFile}
            onChange={(event) => onChange({ tokenFile: event.target.value })}
            spellCheck={false}
          />
        </Field>
      ) : null}
      {method === "hub_identity" ? (
        <Field
          id="openbao-audience"
          label="Audience"
          hint="What OpenBao's JWT role expects in the token's aud. The Hub signs a token per Provider scope (claim scope), with no credential stored."
        >
          <Input
            id="openbao-audience"
            placeholder="vault"
            value={draft.audience}
            onChange={(event) => onChange({ audience: event.target.value })}
            spellCheck={false}
          />
        </Field>
      ) : null}
      {method === "cert" ? (
        <Field id="openbao-client-cert" label="Client certificate" hint="PEM; not a secret.">
          <Textarea
            id="openbao-client-cert"
            placeholder="-----BEGIN CERTIFICATE-----"
            value={draft.clientCert}
            onChange={(event) => onChange({ clientCert: event.target.value })}
            spellCheck={false}
            rows={2}
          />
        </Field>
      ) : null}
      {credential === undefined ? null : (
        <Field
          id="openbao-credential"
          label={credential.label.charAt(0).toUpperCase() + credential.label.slice(1)}
          hint="Kept in the Hub's secret store; it never comes back to this page."
        >
          <SecretSourceInput
            id="openbao-credential"
            aria-label={credential.label}
            size="sm"
            value={reference ?? ""}
            configured={reference === undefined && draft.credential !== ""}
            sources={sources}
            onCommit={(next) => onChange({ credential: next })}
            onSecretChange={(secret) => onChange({ credential: secret ?? "" })}
          />
        </Field>
      )}
      <Field id="openbao-auth-mount" label="Sign-in mount (optional)">
        <Input
          id="openbao-auth-mount"
          placeholder={method === "hub_identity" ? "jwt" : method}
          value={draft.authMount}
          onChange={(event) => onChange({ authMount: event.target.value })}
          spellCheck={false}
        />
      </Field>
    </>
  );
}

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<SecretProviderDraft>(
    existing ? draftFromSecretProvider(existing.config) : { name: "", account: "" },
  );
  const [submitted, setSubmitted] = useState(false);
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const nameError = submitted ? issues.name : undefined;
  const accountError = submitted ? issues.account : undefined;
  const openBaoError = submitted ? issues.openBao : undefined;
  const isOpenBao = draft.kind === "openbao";

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    updateSettings({ secretProviders: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? `Edit ${existing.config.label}`
              : isOpenBao
                ? "Add an OpenBao provider"
                : "Add a 1Password provider"}
          </DialogTitle>
          <DialogDescription>
            {isOpenBao
              ? `Provider variables and Vault entries on ${environmentLabel} can read values from it. That server signs in to OpenBao or HashiCorp Vault itself; values never pass through this page.`
              : `Provider variables on ${environmentLabel} can read values from it by name. Values are read with the op CLI on that server when a provider starts.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {existing ? null : (
              <Field id="secret-provider-kind" label="Kind">
                <Select
                  value={draft.kind ?? "one_password"}
                  onValueChange={(value) =>
                    value === "openbao"
                      ? update({ kind: "openbao", openBao: draft.openBao ?? emptyOpenBaoDraft })
                      : update({ kind: "one_password" })
                  }
                >
                  <SelectTrigger id="secret-provider-kind" size="sm">
                    <SelectValue>
                      {SECRET_PROVIDER_KINDS[draft.kind ?? "one_password"]?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="one_password">1Password</SelectItem>
                    <SelectItem value="openbao">OpenBao / HashiCorp Vault</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">Name</Label>
              <Input
                id="secret-provider-name"
                placeholder={isOpenBao ? "Team OpenBao" : "Personal"}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            {isOpenBao ? (
              <>
                <OpenBaoFields
                  draft={draft.openBao ?? emptyOpenBaoDraft}
                  onChange={(patch) =>
                    update({ openBao: { ...(draft.openBao ?? emptyOpenBaoDraft), ...patch } })
                  }
                  environmentId={environmentId}
                  selfId={existing?.id}
                />
                {openBaoError !== undefined ? (
                  <p role="alert" className="text-xs text-destructive">
                    {openBaoError}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-account">Account</Label>
                <Input
                  id="secret-provider-account"
                  placeholder="my.1password.com"
                  value={draft.account}
                  onChange={(event) => update({ account: event.target.value })}
                  maxLength={253}
                  spellCheck={false}
                  aria-invalid={accountError !== undefined}
                  aria-describedby={
                    accountError !== undefined ? "secret-provider-account-error" : undefined
                  }
                />
                {accountError !== undefined ? (
                  <p
                    id="secret-provider-account-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {accountError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  The account shorthand, sign-in address without https://, or ID that op account
                  list shows.
                </p>
              </div>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
