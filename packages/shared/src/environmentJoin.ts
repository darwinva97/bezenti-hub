// `t3 join`: the machine starts a join request on the Hub, the Owner approves it on the Hub's
// «Register this machine» page, and the machine asks the Hub until it is decided. A browser on the
// machine itself also returns to a loopback port, so `t3 join` finishes at once. See
// docs/internals/environment-auth.md#joined-environments.
import { isLocalLoopbackHost } from "./hostClassification.ts";

const REGISTER_PAGE_PATH = "/register-environment";
const CREDENTIAL_PREFIX = "t3env";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CREDENTIAL_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The Environment credential and everything it opens travel to this address, so it must be
 * HTTPS. Plain HTTP is only for a Hub on this same machine.
 */
export function assertEnvironmentHubUrl(hubUrl: string): URL {
  if (!URL.canParse(hubUrl)) throw new Error(`Not a Hub address: ${hubUrl}`);
  const url = new URL(hubUrl);
  if (url.username !== "" || url.password !== "") {
    throw new Error("The Hub's address must not carry a user name or password.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)) return url;
  throw new Error("The Hub's address must start with https:// (plain http only for localhost).");
}

const base64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const fromBase64Url = (text: string) => {
  try {
    const bytes = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * `t3env.<issuing Hub's id>.<secret>`, made on the machine: the Hub's id lets another Hub tell
 * whose it is. The Hub only ever learns its SHA-256.
 */
export const formatEnvironmentCredential = (hubId: string, secret: string) =>
  `${CREDENTIAL_PREFIX}.${base64Url(hubId)}.${secret}`;

/** The Hub that issued a credential, or undefined when it is not one. */
export const environmentCredentialIssuer = (credential: string): string | undefined => {
  const [prefix, hub, secret, ...rest] = credential.split(".");
  if (prefix !== CREDENTIAL_PREFIX || !hub || !secret || rest.length > 0) return undefined;
  return fromBase64Url(hub);
};

/** How `t3 join` names the User who approved it: their sign-in name, or their id without one. */
export const environmentJoinApproverLabel = (approver: {
  readonly userId: string;
  readonly displayName: string;
  readonly loginName: string | null;
}) => `${approver.displayName} (${approver.loginName ?? approver.userId})`;

/** Whether `--owner` names the approver: their sign-in name (any case) or their id. */
export const environmentJoinApproverMatches = (
  owner: string,
  approver: { readonly userId: string; readonly loginName: string | null },
) => {
  const named = owner.trim();
  return (
    named === approver.userId ||
    (approver.loginName !== null && named.toLowerCase() === approver.loginName.toLowerCase())
  );
};

/**
 * The question `t3 join` asks before registering; the desktop app reads it from its output. A
 * machine the Owner dedicated to a Space says so instead.
 */
export const environmentJoinConfirmationPrompt = (approverLabel: string, dedicatedTo?: string) =>
  dedicatedTo === undefined
    ? `Approved by ${approverLabel} as their personal machine. Register it as theirs? [y/N] `
    : `Approved by ${approverLabel} as a machine dedicated to ${dedicatedTo}. Register it for ${dedicatedTo}? [y/N] `;

/** What `t3 join` prints of the approval when it does not ask. */
export const environmentJoinApprovalLine = (approverLabel: string, dedicatedTo?: string) =>
  dedicatedTo === undefined
    ? `Approved by ${approverLabel} as their personal machine.`
    : `Approved by ${approverLabel} as a machine dedicated to ${dedicatedTo}.`;

const CONFIRMATION_PROMPT =
  /Approved by (.+?) as (?:their personal machine\. Register it as theirs|a machine dedicated to .+\. Register it for .+)\?/;

/** The approver a `t3 join` output line asks about, or null. */
export const readEnvironmentJoinConfirmationPrompt = (line: string): string | null =>
  CONFIRMATION_PROMPT.exec(line)?.[1] ?? null;

export const isEnvironmentCredentialHash = (value: string) => CREDENTIAL_HASH_PATTERN.test(value);
const isEnvironmentJoinRequestId = (value: string) => REQUEST_ID_PATTERN.test(value);

export const environmentJoinPageUrl = (hubUrl: string, requestId: string) => {
  const url = new URL(REGISTER_PAGE_PATH, hubUrl);
  url.searchParams.set("request", requestId);
  return url.toString();
};

/** The join request a page URL names; null when it names none. */
export function readEnvironmentJoinPageRequest(pageUrl: string): string | null {
  if (!URL.canParse(pageUrl)) return null;
  const requestId = new URL(pageUrl).searchParams.get("request") ?? "";
  return isEnvironmentJoinRequestId(requestId) ? requestId : null;
}
