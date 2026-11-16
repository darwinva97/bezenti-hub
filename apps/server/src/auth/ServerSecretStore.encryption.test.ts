/**
 * The Hub's secret store encrypts every entry at rest with its master key (spec 5 «Vaults», ticket
 * 01). Real files in a real state directory: what a copy of the disk shows, what a missing or wrong
 * key does at startup, the one-time encryption of plaintext stores, rotation and import.
 */
// @effect-diagnostics nodeBuiltinImport:off - the tests read the store's files as a copy would.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as MasterKeyFile from "./MasterKeyFile.ts";
import * as SecretCipher from "./SecretCipher.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const platform = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const newBaseDir = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secret-enc-")));
const stateDirOf = (baseDir: string) => NodePath.join(baseDir, "userdata");
const secretsDirOf = (baseDir: string) => NodePath.join(stateDirOf(baseDir), "secrets");
const keyFileOf = (baseDir: string) => NodePath.join(stateDirOf(baseDir), "master.key");

const configAt = (baseDir: string) => ServerConfig.layerTest(process.cwd(), baseDir);

/** The store as the Hub builds it over `baseDir`, on the real file system unless one is given. */
const storeAt = (baseDir: string, fileSystem?: Layer.Layer<FileSystem.FileSystem>) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(configAt(baseDir)),
    Layer.provideMerge(fileSystem ?? Layer.empty),
  );

const withStore = <A, E>(
  baseDir: string,
  body: (store: ServerSecretStore.ServerSecretStore["Service"]) => Effect.Effect<A, E>,
  fileSystem?: Layer.Layer<FileSystem.FileSystem>,
) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, body).pipe(
    Effect.provide(storeAt(baseDir, fileSystem)),
  );

/** Every file under `dir`, recursively, with its bytes. */
const filesUnder = (dir: string): Array<{ readonly path: string; readonly bytes: Buffer }> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [{ path, bytes: NodeFS.readFileSync(path) }];
  });

const seedPlaintext = (baseDir: string, entries: Record<string, string>) => {
  NodeFS.mkdirSync(secretsDirOf(baseDir), { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(entries)) {
    NodeFS.writeFileSync(NodePath.join(secretsDirOf(baseDir), `${name}.bin`), value, {
      mode: 0o600,
    });
  }
};

/** Where the store keeps `name`, whatever its file's extension. */
const entryFileOf = (baseDir: string, name: string) => {
  const found = NodeFS.readdirSync(secretsDirOf(baseDir)).find(
    (file) => file.startsWith(`${name}.`) && !file.endsWith(".tmp"),
  );
  assert.isDefined(found, `no file for ${name}`);
  return NodePath.join(secretsDirOf(baseDir), found!);
};

const readAll = (baseDir: string, names: ReadonlyArray<string>) =>
  withStore(baseDir, (store) =>
    Effect.forEach(names, (name) =>
      store.get(name).pipe(Effect.map(Option.map((bytes) => decoder.decode(bytes)))),
    ),
  );

/** A file system whose `rename` fails from its `failFrom`-th call on, as a crash would stop it. */
const layerRenameFailsFrom = (failFrom: number) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let calls = 0;
      return {
        ...fileSystem,
        rename: (from, to) => {
          calls += 1;
          return calls >= failFrom
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${from} -> ${to}`,
                  description: "The process stopped here.",
                }),
              )
            : fileSystem.rename(from, to);
        },
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(platform));

const SECRET = "sk-live-PLAINTEXT-must-never-show-4471";

it.layer(platform)("ServerSecretStore encryption", (it) => {
  describe("at rest", () => {
    it.effect("no file of the store holds a value it wrote", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("provider-token", encoder.encode(SECRET));
            yield* store.create("created-token", encoder.encode(`${SECRET}-created`));
            const random = yield* store.getOrCreateRandom("signing-key", 32);
            const back = yield* store.get("provider-token");
            assert.equal(decoder.decode(Option.getOrThrow(back)), SECRET);
            for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
              assert.isFalse(bytes.includes(Buffer.from(SECRET)), `${path} holds the value`);
              assert.isFalse(bytes.includes(Buffer.from(random)), `${path} holds the random key`);
            }
          }),
        );
      }),
    );

    it.effect("an entry moved to another name does not open", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("owner-token", encoder.encode(SECRET));
            NodeFS.copyFileSync(
              entryFileOf(baseDir, "owner-token"),
              entryFileOf(baseDir, "owner-token").replace("owner-token", "guest-token"),
            );
            const moved = yield* Effect.exit(store.get("guest-token"));
            assert.isTrue(Exit.isFailure(moved), "a renamed entry opened");
          }),
        );
      }),
    );

    it.effect("two writes of the same value never share bytes", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("a", encoder.encode(SECRET));
            const first = NodeFS.readFileSync(entryFileOf(baseDir, "a"));
            yield* store.set("a", encoder.encode(SECRET));
            const second = NodeFS.readFileSync(entryFileOf(baseDir, "a"));
            assert.notDeepEqual(first, second);
          }),
        );
      }),
    );
  });

  describe("the master key", () => {
    it.effect("is created on first start, owner-only, outside the secrets folder", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const keyFile = keyFileOf(baseDir);
        assert.isTrue(NodeFS.existsSync(keyFile));
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.equal(NodeFS.statSync(keyFile).mode & 0o777, 0o600);
        }
        const text = NodeFS.readFileSync(keyFile, "utf8").trim();
        assert.match(text, /^t3-master-key-v1:[A-Za-z0-9_-]{43}$/);
      }),
    );

    it.effect("missing, with encrypted secrets, stops the store and is never created anew", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        NodeFS.rmSync(keyFileOf(baseDir));
        const before = filesUnder(secretsDirOf(baseDir));
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit), "the store started without its key");
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "t3 secrets key import");
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)), "a new key was created");
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), before);
      }),
    );

    it.effect("wrong, stops the store and leaves the key and every entry as they were", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const other = newBaseDir();
        yield* withStore(other, (store) => store.set("b", encoder.encode("x")));
        const wrongKey = NodeFS.readFileSync(keyFileOf(other));
        NodeFS.writeFileSync(keyFileOf(baseDir), wrongKey, { mode: 0o600 });
        const before = filesUnder(secretsDirOf(baseDir));
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit), "the store started with another key");
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "master key");
        assert.deepEqual(NodeFS.readFileSync(keyFileOf(baseDir)), wrongKey);
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), before);
      }),
    );

    it.effect("readable by others, is refused until only its owner may read it", () =>
      Effect.gen(function* () {
        // Windows: mode bits mean nothing; the file inherits its folder's ACL.
        if ((yield* HostProcess.Platform) === "win32") return;
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        NodeFS.chmodSync(keyFileOf(baseDir), 0o644);
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "chmod 600");
        NodeFS.chmodSync(keyFileOf(baseDir), 0o600);
        const [value] = yield* readAll(baseDir, ["a"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );
  });

  describe("a store from before encryption", () => {
    it.effect("is encrypted once at startup, values unchanged", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { "session-signing-key": SECRET, "ssh-install-key-1": "PRIVATE" });
        const values = yield* readAll(baseDir, ["session-signing-key", "ssh-install-key-1"]);
        assert.deepEqual(values.map(Option.getOrThrow), [SECRET, "PRIVATE"]);
        for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
          assert.isFalse(bytes.includes(Buffer.from(SECRET)), `${path} still in clear`);
          assert.isFalse(bytes.includes(Buffer.from("PRIVATE")), `${path} still in clear`);
        }
        // Idempotent: a second start rewrites nothing.
        const after = filesUnder(secretsDirOf(baseDir));
        yield* readAll(baseDir, ["session-signing-key"]);
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), after);
      }),
    );

    it.effect("stopped half-way, keeps every value readable and the next start finishes", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { one: "VALUE-ONE", two: "VALUE-TWO", three: "VALUE-THREE" });
        const crashed = yield* Effect.exit(
          withStore(baseDir, () => Effect.void, layerRenameFailsFrom(2)),
        );
        assert.isTrue(Exit.isFailure(crashed), "the startup did not stop where it crashed");
        const values = yield* readAll(baseDir, ["one", "two", "three"]);
        assert.deepEqual(values.map(Option.getOrThrow), ["VALUE-ONE", "VALUE-TWO", "VALUE-THREE"]);
        for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
          assert.isFalse(bytes.includes(Buffer.from("VALUE-")), `${path} still in clear`);
        }
      }),
    );
  });

  describe("rotation", () => {
    const keyIdsOf = (baseDir: string) =>
      filesUnder(secretsDirOf(baseDir)).map(({ bytes }) => bytes.subarray(5, 13).toString("hex"));

    it.effect("reseals every entry with a new key and keeps the old one as .previous", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { one: "VALUE-ONE", two: "VALUE-TWO" });
        yield* readAll(baseDir, ["one"]);
        const oldKey = NodeFS.readFileSync(keyFileOf(baseDir), "utf8");
        const rotated = yield* MasterKeyFile.rotate().pipe(Effect.provide(configAt(baseDir)));
        assert.notEqual(rotated.keyId, rotated.previousKeyId);
        assert.equal(NodeFS.readFileSync(`${keyFileOf(baseDir)}.previous`, "utf8"), oldKey);
        assert.notEqual(NodeFS.readFileSync(keyFileOf(baseDir), "utf8"), oldKey);
        assert.isFalse(NodeFS.existsSync(`${keyFileOf(baseDir)}.next`));
        assert.deepEqual([...new Set(keyIdsOf(baseDir))], [rotated.keyId]);
        const values = yield* readAll(baseDir, ["one", "two"]);
        assert.deepEqual(values.map(Option.getOrThrow), ["VALUE-ONE", "VALUE-TWO"]);
      }),
    );

    it.effect("re-encrypts a Vault's values too, in their own folder and purpose", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { hub: "VALUE-HUB" });
        const vaultValues = Effect.flatMap(ServerSecretStore.VaultValueStore, (values) =>
          values.set("value-1", encoder.encode("VALUE-VAULT")),
        );
        yield* vaultValues.pipe(Effect.provide(storeAt(baseDir)));
        const file = NodePath.join(secretsDirOf(baseDir), "vault-values", "value-1.sealed");
        const before = NodeFS.readFileSync(file);
        assert.isFalse(before.includes(Buffer.from("VALUE-VAULT")));
        const rotated = yield* MasterKeyFile.rotate().pipe(Effect.provide(configAt(baseDir)));
        const after = NodeFS.readFileSync(file);
        assert.equal(after.subarray(5, 13).toString("hex"), rotated.keyId);
        const key = SecretCipher.MasterKey.parse(NodeFS.readFileSync(keyFileOf(baseDir), "utf8"));
        assert.equal(SecretCipher.open([key!], "vault-value", "value-1", after)._tag, "opened");
        assert.equal(
          SecretCipher.open([key!], "server-secret", "value-1", after)._tag,
          "rejected",
          "a Vault value opens only under its own purpose",
        );
        const read = yield* Effect.flatMap(ServerSecretStore.VaultValueStore, (values) =>
          values.get("value-1"),
        ).pipe(Effect.provide(storeAt(baseDir)));
        assert.equal(decoder.decode(Option.getOrThrow(read)), "VALUE-VAULT");
        // The store's own names never reach that folder.
        const refused = yield* Effect.flip(
          withStore(baseDir, (store) => store.get("vault-values/value-1")),
        );
        assert.equal(refused._tag, "SecretStoreDecodeError");
      }),
    );

    it.effect("stopped half-way, keeps both keys and the next start finishes it", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { one: "VALUE-ONE", two: "VALUE-TWO", three: "VALUE-THREE" });
        yield* readAll(baseDir, ["one"]);
        const oldKey = NodeFS.readFileSync(keyFileOf(baseDir), "utf8");
        // The `.next` key is written (rename 1), then one entry resealed (rename 2): stop there.
        const crashed = yield* Effect.exit(
          MasterKeyFile.rotate().pipe(
            Effect.provide(configAt(baseDir)),
            Effect.provide(layerRenameFailsFrom(3)),
          ),
        );
        assert.isTrue(Exit.isFailure(crashed));
        assert.isTrue(NodeFS.existsSync(`${keyFileOf(baseDir)}.next`));
        assert.equal(NodeFS.readFileSync(keyFileOf(baseDir), "utf8"), oldKey);
        assert.equal(new Set(keyIdsOf(baseDir)).size, 2, "expected entries under both keys");
        const values = yield* readAll(baseDir, ["one", "two", "three"]);
        assert.deepEqual(values.map(Option.getOrThrow), ["VALUE-ONE", "VALUE-TWO", "VALUE-THREE"]);
        assert.isFalse(NodeFS.existsSync(`${keyFileOf(baseDir)}.next`));
        assert.equal(NodeFS.readFileSync(`${keyFileOf(baseDir)}.previous`, "utf8"), oldKey);
        assert.equal(new Set(keyIdsOf(baseDir)).size, 1);
      }),
    );

    it.effect("makes an earlier backup no backup of the new key", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        const backupRecord = (write: boolean) =>
          Effect.gen(function* () {
            const { keyring } = yield* ServerSecretStore.MasterKeyring;
            const current = Option.getOrThrow(keyring);
            if (write) yield* MasterKeyFile.writeBackupRecord(current, "2026-11-11T00:00:00.000Z");
            return yield* MasterKeyFile.readBackupRecord(current);
          }).pipe(Effect.provide(storeAt(baseDir)));
        assert.equal(Option.getOrNull(yield* backupRecord(true)), "2026-11-11T00:00:00.000Z");
        yield* MasterKeyFile.rotate().pipe(Effect.provide(configAt(baseDir)));
        assert.isTrue(Option.isNone(yield* backupRecord(false)));
      }),
    );
  });

  describe("import", () => {
    const exportedFrom = (baseDir: string) =>
      readAll(baseDir, []).pipe(
        Effect.map(() => Redacted.make(NodeFS.readFileSync(keyFileOf(baseDir), "utf8"))),
      );

    it.effect("opens the same secrets in another state directory", () =>
      Effect.gen(function* () {
        const source = newBaseDir();
        yield* withStore(source, (store) => store.set("owner-token", encoder.encode(SECRET)));
        const key = yield* exportedFrom(source);
        const target = newBaseDir();
        NodeFS.cpSync(secretsDirOf(source), secretsDirOf(target), { recursive: true });
        const imported = yield* MasterKeyFile.importKey(key).pipe(Effect.provide(configAt(target)));
        assert.isFalse(imported.replaced);
        const [value] = yield* readAll(target, ["owner-token"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );

    it.effect("drops the workload identity signing keys: a restored Hub makes new ones", () =>
      Effect.gen(function* () {
        const source = newBaseDir();
        yield* withStore(source, (store) =>
          Effect.all([
            store.set("owner-token", encoder.encode(SECRET)),
            store.set("identity-signing-kid-1", encoder.encode('{"d":"private"}')),
          ]),
        );
        const key = yield* exportedFrom(source);
        const target = newBaseDir();
        NodeFS.cpSync(secretsDirOf(source), secretsDirOf(target), { recursive: true });
        // The same key, or a key restored over another: either way the signing keys go.
        yield* MasterKeyFile.importKey(key).pipe(Effect.provide(configAt(target)));
        const [kept, signing] = yield* readAll(target, ["owner-token", "identity-signing-kid-1"]);
        assert.equal(Option.getOrThrow(kept!), SECRET);
        assert.isTrue(Option.isNone(signing!));
      }),
    );

    it.effect("of a key that does not open the secrets here changes nothing", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const other = newBaseDir();
        yield* withStore(other, (store) => store.set("b", encoder.encode("x")));
        const before = NodeFS.readFileSync(keyFileOf(baseDir));
        const otherKey = yield* exportedFrom(other);
        const exit = yield* Effect.exit(
          MasterKeyFile.importKey(otherKey).pipe(Effect.provide(configAt(baseDir))),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual(NodeFS.readFileSync(keyFileOf(baseDir)), before);
        const [value] = yield* readAll(baseDir, ["a"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );

    it.effect("over a wrong key keeps the replaced one beside it", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const good = yield* exportedFrom(baseDir);
        const other = newBaseDir();
        yield* withStore(other, (store) => store.set("b", encoder.encode("x")));
        const wrong = NodeFS.readFileSync(keyFileOf(other), "utf8");
        NodeFS.writeFileSync(keyFileOf(baseDir), wrong, { mode: 0o600 });
        const imported = yield* MasterKeyFile.importKey(good).pipe(
          Effect.provide(configAt(baseDir)),
        );
        assert.isTrue(imported.replaced);
        const kept = NodeFS.readdirSync(stateDirOf(baseDir)).filter((name) =>
          name.startsWith("master.key.replaced-"),
        );
        assert.equal(kept.length, 1);
        assert.equal(
          NodeFS.readFileSync(NodePath.join(stateDirOf(baseDir), kept[0]!), "utf8"),
          wrong,
        );
        const [value] = yield* readAll(baseDir, ["a"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );

    it.effect("of text that is not a key is refused", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        const exit = yield* Effect.exit(
          MasterKeyFile.importKey(Redacted.make("not a key")).pipe(
            Effect.provide(configAt(baseDir)),
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)));
      }),
    );
  });

  describe("T3CODE_MASTER_KEY_FILE", () => {
    it.effect("puts the key where it says, outside the state directory", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        const elsewhere = NodePath.join(newBaseDir(), "keys", "hub.key");
        const config = Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (base) => ({ ...base, masterKeyFile: elsewhere })),
        ).pipe(Layer.provide(configAt(baseDir)));
        yield* Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) =>
          store.set("a", encoder.encode(SECRET)),
        ).pipe(Effect.provide(ServerSecretStore.layer.pipe(Layer.provideMerge(config))));
        assert.isTrue(NodeFS.existsSync(elsewhere));
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)));
      }),
    );
  });

  describe("logs, spans and errors", () => {
    it.effect("never hold the key, whatever the store does or refuses", () => {
      const recorded: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            recorded.push(span.name, ...Array.from(span.attributes.values(), String), String(exit));
            end(endTime, exit);
          };
          return span;
        },
      });
      const logger = Logger.make((options) => {
        recorded.push(
          String(options.message),
          String(options.cause),
          JSON.stringify(options.fiber.getRef(References.CurrentLogAnnotations)),
        );
      });
      return Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { legacy: "LEGACY" });
        yield* readAll(baseDir, ["legacy"]);
        const keyOf = () => NodeFS.readFileSync(keyFileOf(baseDir), "utf8").trim().split(":")[1]!;
        const firstKey = keyOf();
        yield* MasterKeyFile.rotate().pipe(Effect.provide(configAt(baseDir)));
        const rotatedKey = keyOf();
        // A refusal: another key.
        const other = newBaseDir();
        yield* readAll(other, []);
        NodeFS.copyFileSync(keyFileOf(other), keyFileOf(baseDir));
        const refused = yield* Effect.exit(readAll(baseDir, ["legacy"]));
        assert.isTrue(Exit.isFailure(refused));
        recorded.push(String(Exit.isFailure(refused) ? refused.cause : ""));
        assert.isAbove(recorded.length, 3);
        for (const secret of [firstKey, rotatedKey]) {
          const hex = Buffer.from(secret, "base64url").toString("hex");
          assert.isFalse(
            recorded.some((value) => value.includes(secret) || value.includes(hex)),
            "the master key reached a log, a span or an error",
          );
        }
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
    });
  });

  describe("review findings", () => {
    it.effect(
      "a joined machine that was a Hub opens what it sealed, never hands out sealed bytes",
      () =>
        Effect.gen(function* () {
          const baseDir = newBaseDir();
          yield* withStore(baseDir, (store) => store.set("provider-token", encoder.encode(SECRET)));
          NodeFS.writeFileSync(NodePath.join(stateDirOf(baseDir), "joined-hub.json"), "{}");
          const [value] = yield* readAll(baseDir, ["provider-token"]);
          assert.equal(Option.getOrThrow(value!), SECRET);
          // Without the key, the sealed entry is an error, never bytes passed off as the value.
          NodeFS.rmSync(keyFileOf(baseDir));
          const read = yield* Effect.exit(readAll(baseDir, ["provider-token"]));
          assert.isTrue(Exit.isFailure(read), "a sealed value came back unopened");
        }),
    );

    it.effect("a damaged entry stops the startup before anything in clear is sealed", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("b", encoder.encode(SECRET)));
        const damaged = NodeFS.readFileSync(entryFileOf(baseDir, "b"));
        damaged[damaged.length - 20] = (damaged[damaged.length - 20] ?? 0) ^ 0xff;
        NodeFS.writeFileSync(entryFileOf(baseDir, "b"), damaged);
        seedPlaintext(baseDir, { a: "VALUE-A" });
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit), "the startup went on past a damaged entry");
        const aFiles = NodeFS.readdirSync(secretsDirOf(baseDir)).filter((f) => f.startsWith("a."));
        assert.deepEqual(aFiles, ["a.bin"]);
        assert.equal(NodeFS.readFileSync(entryFileOf(baseDir, "a"), "utf8"), "VALUE-A");
      }),
    );

    it.effect("a value in clear that starts like a sealed one is read as written", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        const value = Buffer.concat([
          Buffer.from([0x00, 0x54, 0x33, 0x53, 0x01]),
          NodeCrypto.randomBytes(40),
        ]);
        NodeFS.mkdirSync(secretsDirOf(baseDir), { recursive: true, mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(secretsDirOf(baseDir), "random-key.bin"), value);
        const read = yield* withStore(baseDir, (store) => store.get("random-key"));
        assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(value));
      }),
    );

    it.effect("a client beside a running Hub writes nothing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const baseDir = newBaseDir();
          yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
          seedPlaintext(baseDir, { legacy: "LEGACY" });
          const fresh = newBaseDir();
          for (const dir of [baseDir, fresh]) {
            NodeFS.mkdirSync(stateDirOf(dir), { recursive: true });
            // The Hub runs: it holds the server's ownership lock.
            yield* ServerOwnership.acquireServerOwnership(
              NodePath.join(stateDirOf(dir), "server-runtime.json"),
            ).pipe(Effect.provide(ProcessRunner.layer));
          }
          const before = filesUnder(secretsDirOf(baseDir));
          const client = (dir: string) =>
            Effect.exit(
              Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) => store.get("a")).pipe(
                Effect.provide(
                  ServerSecretStore.layerClient.pipe(Layer.provideMerge(configAt(dir))),
                ),
              ),
            );
          yield* client(baseDir);
          assert.deepEqual(filesUnder(secretsDirOf(baseDir)), before);
          yield* client(fresh);
          assert.isFalse(NodeFS.existsSync(keyFileOf(fresh)), "a client created a master key");
        }),
      ),
    );

    it.effect("T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1 opens a key others may read", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        NodeFS.chmodSync(keyFileOf(baseDir), 0o644);
        const [value] = yield* readAll(baseDir, ["a"]).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS: "1" } }),
            ),
          ),
        );
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );

    it.effect("drops expired replay markers and keeps the others' age when sealing", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { "dpop-proof-old": "1", "dpop-proof-new": "1" });
        const plainFile = (name: string) => NodePath.join(secretsDirOf(baseDir), `${name}.bin`);
        // Seconds, from the file system's own clock.
        const now = NodeFS.statSync(plainFile("dpop-proof-new")).mtimeMs / 1000;
        const twoDaysAgo = now - 2 * 24 * 60 * 60;
        const hourAgo = now - 60 * 60;
        NodeFS.utimesSync(plainFile("dpop-proof-old"), twoDaysAgo, twoDaysAgo);
        NodeFS.utimesSync(plainFile("dpop-proof-new"), hourAgo, hourAgo);
        yield* TestClock.setTime(now * 1000);
        yield* readAll(baseDir, []);
        const names = NodeFS.readdirSync(secretsDirOf(baseDir));
        assert.isFalse(names.some((name) => name.startsWith("dpop-proof-old")));
        const kept = NodeFS.statSync(entryFileOf(baseDir, "dpop-proof-new"));
        assert.approximately(kept.mtimeMs, hourAgo * 1000, 2000);
      }),
    );
  });

  describe("final review", () => {
    it.effect("a root-owned key passes only when others cannot read it", () =>
      Effect.sync(() => {
        assert.isTrue(MasterKeyFile.keyFilePermissionsAcceptable(0o600, 1000));
        assert.isTrue(MasterKeyFile.keyFilePermissionsAcceptable(0o440, 0));
        assert.isTrue(MasterKeyFile.keyFilePermissionsAcceptable(0o400, 0));
        assert.isFalse(MasterKeyFile.keyFilePermissionsAcceptable(0o444, 0));
        assert.isFalse(MasterKeyFile.keyFilePermissionsAcceptable(0o404, 0));
        assert.isFalse(MasterKeyFile.keyFilePermissionsAcceptable(0o460, 0));
        assert.isFalse(MasterKeyFile.keyFilePermissionsAcceptable(0o440, 1000));
      }),
    );

    it.effect("an entry the first encrypting build sealed into a .bin is not sealed twice", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* readAll(baseDir, []);
        const keyring = Option.getOrThrow(
          yield* Effect.map(ServerSecretStore.MasterKeyring, (ring) => ring.keyring).pipe(
            Effect.provide(storeAt(baseDir)),
          ),
        );
        NodeFS.writeFileSync(
          NodePath.join(secretsDirOf(baseDir), "old-sealed.bin"),
          SecretCipher.seal(keyring.current, "server-secret", "old-sealed", encoder.encode(SECRET)),
        );
        const [value] = yield* readAll(baseDir, ["old-sealed"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );

    it.effect("a command beside a running Hub ignores its replay markers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const baseDir = newBaseDir();
          yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
          // A marker the Hub has not pruned yet (in clear, and long expired).
          seedPlaintext(baseDir, { "dpop-proof-stale": "1" });
          NodeFS.utimesSync(NodePath.join(secretsDirOf(baseDir), "dpop-proof-stale.bin"), 1, 1);
          // The Hub runs: it holds the server's ownership lock.
          yield* ServerOwnership.acquireServerOwnership(
            NodePath.join(stateDirOf(baseDir), "server-runtime.json"),
          ).pipe(Effect.provide(ProcessRunner.layer));
          const value = yield* Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) =>
            store.get("a"),
          ).pipe(
            Effect.provide(
              ServerSecretStore.layerClient.pipe(Layer.provideMerge(configAt(baseDir))),
            ),
          );
          assert.equal(decoder.decode(Option.getOrThrow(value)), SECRET);
        }),
      ),
    );
  });

  describe("a joined machine", () => {
    it.effect("keeps its credential as its Hub wrote it, with no master key", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { "environment-credential": "joined-credential" });
        NodeFS.writeFileSync(NodePath.join(stateDirOf(baseDir), "joined-hub.json"), "{}");
        const [value] = yield* readAll(baseDir, ["environment-credential"]);
        assert.equal(Option.getOrThrow(value!), "joined-credential");
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(secretsDirOf(baseDir), "environment-credential.bin"),
            "utf8",
          ),
          "joined-credential",
        );
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)));
      }),
    );
  });
});
