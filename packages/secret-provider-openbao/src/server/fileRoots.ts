/**
 * Files the Hub reads to sign in to a provider (a projected token) and then sends to an address
 * the Owner typed. Only files under the operator's roots are read: else a settings edit could
 * send any file the Hub can read. docs/user/install.md, «Connect OpenBao».
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Colon-separated absolute directories; set by whoever runs the Hub, never from settings. */
export const FILE_ROOTS_ENV = "T3CODE_SECRET_PROVIDER_FILE_ROOTS";
/** Where Kubernetes projects ServiceAccount tokens. */
const DEFAULT_FILE_ROOTS = "/var/run/secrets";
export const MAX_PROVIDER_FILE_BYTES = 64 * 1024;

export type ProviderFileRefusal = "outside-roots" | "not-a-file" | "too-large" | "unreadable";

export type ProviderFileRead =
  | { readonly _tag: "ok"; readonly content: string }
  | { readonly _tag: "refused"; readonly reason: ProviderFileRefusal };

type Refused = Extract<ProviderFileRead, { readonly _tag: "refused" }>;
const refused = (reason: ProviderFileRefusal): Refused => ({ _tag: "refused", reason });

/** Absolute, with no empty, `.` or `..` segment: what it names is what it says. */
const isPlainAbsolute = (path: string) =>
  path.startsWith("/") &&
  path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const isUnder = (root: string, path: string) => path.startsWith(`${root}/`);

interface Root {
  readonly configured: string;
  readonly real: string;
}

/** The configured roots that are directories, each with its real path. `/` is never a root. */
const fileRoots = Effect.fn("OpenBaoFileRoots.fileRoots")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configured = yield* Config.String(FILE_ROOTS_ENV).pipe(
    Config.withDefault(DEFAULT_FILE_ROOTS),
    Effect.orElseSucceed(() => DEFAULT_FILE_ROOTS),
  );
  const roots: Array<Root> = [];
  for (const entry of configured.split(":")) {
    const root = entry.length > 1 && entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!isPlainAbsolute(root)) continue;
    const real = yield* fs.realPath(root).pipe(Effect.option);
    if (Option.isNone(real) || real.value === "/") continue;
    const info = yield* fs.stat(real.value).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") {
      roots.push({ configured: root, real: real.value });
    }
  }
  return roots;
});

/**
 * Where `path` really is, if it may be read: plain, under a root as written and once every
 * link is followed, a regular file within the size cap. Never opens it.
 */
const checkedPath = Effect.fn("OpenBaoFileRoots.checkedPath")(function* (path: string) {
  if (!isPlainAbsolute(path)) return refused("outside-roots");
  const roots = yield* fileRoots();
  if (!roots.some((root) => isUnder(root.configured, path) || isUnder(root.real, path))) {
    return refused("outside-roots");
  }
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(path).pipe(Effect.option);
  if (Option.isNone(real)) return refused("unreadable");
  if (!roots.some((root) => isUnder(root.real, real.value))) return refused("outside-roots");
  const info = yield* fs.stat(real.value).pipe(Effect.option);
  if (Option.isNone(info)) return refused("unreadable");
  if (info.value.type !== "File") return refused("not-a-file");
  if (Number(info.value.size) > MAX_PROVIDER_FILE_BYTES) return refused("too-large");
  return real.value;
});

const decoder = new TextDecoder();

/** The file's text, checked again on the open file: a swap after the check is refused too. */
export const readProviderFile = Effect.fn("OpenBaoFileRoots.readProviderFile")(function* (
  path: string,
) {
  const checked = yield* checkedPath(path);
  if (typeof checked !== "string") return checked;
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(checked, { flag: "r" });
      const info = yield* file.stat;
      if (info.type !== "File") return refused("not-a-file");
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      while (true) {
        const next = yield* file.readAlloc(MAX_PROVIDER_FILE_BYTES + 1 - total);
        if (Option.isNone(next) || next.value.length === 0) break;
        chunks.push(next.value);
        total += next.value.length;
        if (total > MAX_PROVIDER_FILE_BYTES) return refused("too-large");
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { _tag: "ok", content: decoder.decode(bytes) } satisfies ProviderFileRead;
    }),
  ).pipe(Effect.orElseSucceed(() => refused("unreadable")));
});
