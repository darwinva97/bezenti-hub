// @effect-diagnostics globalTimersInEffect:off -- a step's timeout must fire inside an undo too.
/**
 * The Hub's own SSH client for «Add a machine over SSH» (ssh2, in this process): no `ssh` binary,
 * so the key is never in a file or an argument. It reads a host key without signing in, and signs
 * in only to the host whose key has the fingerprint the Owner confirmed. Errors carry fixed
 * messages, never what ssh2 or the key said.
 */
import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";

import { hostKeyFingerprint, shellQuote } from "./sshInstallScripts.ts";

// ssh2 is external to the CLI bundle (its CommonJS reads __dirname); a single-executable loads it from disk only with require.
const ssh2 = NodeModule.createRequire(import.meta.url)("ssh2") as typeof Ssh2;
const { Client, utils: SshUtils } = ssh2;
type Client = InstanceType<typeof Client>;

export interface SshTarget {
  /** The address the host resolved to, pinned for the whole run. */
  readonly address: string;
  readonly port: number;
  readonly username: string;
}

export type SshCredentials =
  | { readonly kind: "key"; readonly privateKey: string; readonly passphrase: string | undefined }
  | { readonly kind: "agent"; readonly agentSocket: string };

export const SshFailureReason = Schema.Literals([
  "unreachable",
  "timeout",
  "host-key-mismatch",
  "auth-failed",
  "lost",
  "key-unreadable",
  "failed",
]);
export type SshFailureReason = typeof SshFailureReason.Type;

export class SshFailure extends Schema.TaggedError<SshFailure>()("SshFailure", {
  reason: SshFailureReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 15_000;

/** Whether ssh2 can read the key with that passphrase; never says what it read. */
export const keyRefusal = (privateKey: string, passphrase: string | undefined) => {
  try {
    const parsed = SshUtils.parseKey(privateKey, passphrase);
    if (parsed instanceof Error) {
      return /passphrase/iu.test(parsed.message)
        ? "The private key needs its passphrase, or the passphrase is wrong."
        : "The private key could not be read (OpenSSH, PEM and PuTTY keys are).";
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key === undefined || !key.isPrivateKey()) return "That is not a private key.";
    return undefined;
  } catch {
    return "The private key could not be read (OpenSSH, PEM and PuTTY keys are).";
  }
};

/** What an ssh2 error was, in words of our own: socket codes are kept, nothing else of it. */
const failureOf = (error: unknown, context: { readonly hostKeyRejected: boolean }) => {
  if (context.hostKeyRejected) {
    return new SshFailure({
      reason: "host-key-mismatch",
      detail: "The machine's host key is not the one confirmed; the Hub did not sign in.",
    });
  }
  const level = (error as { readonly level?: unknown } | null)?.level;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (level === "client-authentication") {
    return new SshFailure({
      reason: "auth-failed",
      detail: "The machine refused the key (or the agent's keys) for that user.",
    });
  }
  if (level === "client-timeout") {
    return new SshFailure({ reason: "timeout", detail: "The machine did not answer SSH in time." });
  }
  if (level === "client-socket") {
    return new SshFailure({
      reason: "unreachable",
      detail: `Could not reach the machine's SSH port${typeof code === "string" && /^[A-Z_]+$/u.test(code) ? ` (${code})` : ""}.`,
    });
  }
  if (level === "agent") {
    return new SshFailure({
      reason: "auth-failed",
      detail: "The Hub's SSH agent could not be used.",
    });
  }
  return new SshFailure({ reason: "failed", detail: "The SSH connection failed." });
};

/**
 * Reads the machine's host key without signing in: the key is turned down as soon as it is seen,
 * so no credential is ever offered to a host the Owner has not confirmed.
 */
export const probeHostKey = (target: Omit<SshTarget, "username">) =>
  Effect.callback<Uint8Array, SshFailure>((resume) => {
    const client = new Client();
    let seen: Uint8Array | undefined;
    let done = false;
    const finish = (effect: Effect.Effect<Uint8Array, SshFailure>) => {
      if (done) return;
      done = true;
      client.end();
      resume(effect);
    };
    client.on("error", (error) => {
      if (seen !== undefined) finish(Effect.succeed(seen));
      else finish(Effect.fail(failureOf(error, { hostKeyRejected: false })));
    });
    client.on("close", () => {
      if (seen !== undefined) finish(Effect.succeed(seen));
      else
        finish(
          Effect.fail(
            new SshFailure({
              reason: "lost",
              detail: "The machine closed the connection before showing its host key.",
            }),
          ),
        );
    });
    client.connect({
      host: target.address,
      port: target.port,
      username: "t3-host-key-probe",
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        seen = Uint8Array.from(key);
        finish(Effect.succeed(seen));
        return false;
      },
    });
    return Effect.sync(() => {
      done = true;
      client.end();
    });
  });

export interface ExecOptions {
  /** Written to the command's standard input, which is then closed. */
  readonly stdin?: string;
  /** Each chunk of its standard output and error, as it comes. */
  readonly onOutput: (chunk: string) => void;
  readonly timeoutMs: number;
}

export interface SshSession {
  /** Runs a POSIX shell script (`sh -c`, whatever the user's login shell); its exit code. */
  readonly exec: (script: string, options: ExecOptions) => Effect.Effect<number, SshFailure>;
}

/** `sh -c '<script>'`: the user's login shell only parses the quoting. */
const asShCommand = (script: string) => `sh -c ${shellQuote(script)}`;

/**
 * Signs in to the machine whose host key has this fingerprint, and nothing else. Closed with the
 * scope.
 */
export const connect = (
  target: SshTarget,
  credentials: SshCredentials,
  fingerprint: string,
): Effect.Effect<SshSession, SshFailure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ readonly client: Client; readonly closed: { current: boolean } }, SshFailure>(
      (resume) => {
        const client = new Client();
        const closed = { current: false };
        let hostKeyRejected = false;
        let ready = false;
        client.on("ready", () => {
          ready = true;
          resume(Effect.succeed({ client, closed }));
        });
        client.on("error", (error) => {
          if (!ready) resume(Effect.fail(failureOf(error, { hostKeyRejected })));
        });
        client.on("close", () => {
          closed.current = true;
          if (!ready) {
            resume(
              Effect.fail(
                hostKeyRejected
                  ? failureOf(undefined, { hostKeyRejected })
                  : new SshFailure({
                      reason: "lost",
                      detail: "The machine closed the connection.",
                    }),
              ),
            );
          }
        });
        const config: ConnectConfig = {
          host: target.address,
          port: target.port,
          username: target.username,
          readyTimeout: READY_TIMEOUT_MS,
          keepaliveInterval: KEEPALIVE_MS,
          keepaliveCountMax: 4,
          hostVerifier: (key: Buffer) => {
            const matches = hostKeyFingerprint(key) === fingerprint;
            if (!matches) hostKeyRejected = true;
            return matches;
          },
          ...(credentials.kind === "key"
            ? {
                privateKey: credentials.privateKey,
                ...(credentials.passphrase === undefined
                  ? {}
                  : { passphrase: credentials.passphrase }),
              }
            : { agent: credentials.agentSocket }),
        };
        client.connect(config);
        return Effect.sync(() => client.end());
      },
    ),
    ({ client }) => Effect.sync(() => client.end()),
  ).pipe(
    Effect.map(({ client, closed }) => ({
      exec: (script: string, options: ExecOptions) =>
        Effect.callback<number, SshFailure>((resume) => {
          if (closed.current) {
            resume(
              Effect.fail(
                new SshFailure({ reason: "lost", detail: "The SSH connection was lost." }),
              ),
            );
            return;
          }
          let finished = false;
          let channelRef: { close: () => void } | undefined;
          // Its own timer, not an Effect timeout: an undo runs it while the run is interrupted.
          const timer = setTimeout(() => {
            channelRef?.close();
            finish(
              Effect.fail(new SshFailure({ reason: "timeout", detail: "The step took too long." })),
            );
          }, options.timeoutMs);
          const finish = (effect: Effect.Effect<number, SshFailure>) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            client.removeListener("close", onClose);
            resume(effect);
          };
          const onClose = () =>
            finish(
              Effect.fail(
                new SshFailure({ reason: "lost", detail: "The SSH connection was lost." }),
              ),
            );
          client.on("close", onClose);
          client.exec(asShCommand(script), (error, channel) => {
            if (error) {
              finish(
                Effect.fail(
                  new SshFailure({
                    reason: "failed",
                    detail: "The machine refused to run a command.",
                  }),
                ),
              );
              return;
            }
            channelRef = channel;
            let exitCode: number | null = null;
            channel.setEncoding("utf8");
            channel.stderr.setEncoding("utf8");
            channel.on("data", (chunk: string) => options.onOutput(chunk));
            channel.stderr.on("data", (chunk: string) => options.onOutput(chunk));
            channel.on("exit", (code: number | null) => {
              exitCode = typeof code === "number" ? code : 255;
            });
            channel.on("close", () => finish(Effect.succeed(exitCode ?? 255)));
            if (options.stdin === undefined) channel.end();
            else channel.end(options.stdin);
          });
          return Effect.sync(() => {
            finished = true;
            clearTimeout(timer);
            client.removeListener("close", onClose);
            channelRef?.close();
          });
        }),
    })),
  );
