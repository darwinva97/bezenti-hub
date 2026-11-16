// @effect-diagnostics nodeBuiltinImport:off - AES-256-GCM, HKDF and the CSPRNG come from node:crypto.
/**
 * The master key and the sealed format of every encrypted value (AES-256-GCM, an HKDF subkey per
 * purpose, a random nonce per seal, header + purpose + name as associated data). Pure; which files
 * are sealed is told by their name, never by their bytes. See docs/internals/secrets.md.
 */
import * as NodeCrypto from "node:crypto";

const MASTER_KEY_BYTES = 32;
const KEY_ID_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from([0x00, 0x54, 0x33, 0x53]);
const FORMAT_V1 = 0x01;
/** Magic, format and key id: all a startup reads of an entry it does not rewrite. */
export const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES;
const KEY_TEXT_PREFIX = "t3-master-key-v1:";
/** How many characters of the key an Owner types back to show they saved the backup. */
const PROOF_LENGTH = 8;

/** What a sealed value is for: each gets its own subkey. */
export type SealPurpose =
  | "server-secret"
  | "key-check"
  | "backup-record"
  | "secret-file"
  | "vault-value"
  /** An AI account's credential (spec 4): `secrets/ai-accounts/`. */
  | "ai-account-credential"
  /** A subscription AI account's OAuth token (spec 4 ticket 03): `secrets/ai-account-tokens/`. */
  | "ai-account-oauth-token"
  /** A value read from a Secret provider and delivered to a Thread, kept only to mask it. */
  | "delivered-value";

const hkdf = (key: Buffer, info: string, length: number) =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", key, Buffer.alloc(0), info, length));

/** The key characters of a backup's text (after `t3-master-key-v1:`), or undefined. */
const encodedPart = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith(KEY_TEXT_PREFIX) ? trimmed.slice(KEY_TEXT_PREFIX.length) : undefined;
};

/** The first characters of a backup's key, which the Owner types back to confirm it. */
export const backupProofOf = (text: string) => (encodedPart(text) ?? "").slice(0, PROOF_LENGTH);

/**
 * A master key. Its bytes stay in a private field: logging, inspecting or serialising one shows
 * only its id.
 */
export class MasterKey {
  readonly #bytes: Buffer;
  readonly #subkeys = new Map<SealPurpose, Buffer>();
  /** The key's fingerprint in hex: safe to show, store and log. */
  readonly id: string;
  readonly idBytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
    this.idBytes = hkdf(bytes, "t3code master key id v1", KEY_ID_BYTES);
    this.id = this.idBytes.toString("hex");
  }

  static generate(): MasterKey {
    return new MasterKey(NodeCrypto.randomBytes(MASTER_KEY_BYTES));
  }

  /** The key file's and the backup's text, or undefined when `text` is not one. */
  static parse(text: string): MasterKey | undefined {
    const encoded = encodedPart(text);
    if (encoded === undefined || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
    const bytes = Buffer.from(encoded, "base64url");
    return bytes.length === MASTER_KEY_BYTES ? new MasterKey(bytes) : undefined;
  }

  /** The text written to the key file and handed out as a backup: the key itself. */
  exportText(): string {
    return `${KEY_TEXT_PREFIX}${this.#bytes.toString("base64url")}\n`;
  }

  /** Whether `proof` is this key's first characters, compared in constant time. */
  matchesProof(proof: string): boolean {
    const expected = Buffer.from(backupProofOf(this.exportText()));
    const given = Buffer.from(proof);
    return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
  }

  subkey(purpose: SealPurpose): Buffer {
    let subkey = this.#subkeys.get(purpose);
    if (subkey === undefined) {
      subkey = hkdf(this.#bytes, `t3code ${purpose} v1`, MASTER_KEY_BYTES);
      this.#subkeys.set(purpose, subkey);
    }
    return subkey;
  }

  toString(): string {
    return `MasterKey(${this.id})`;
  }

  toJSON(): { readonly id: string } {
    return { id: this.id };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

const associatedData = (header: Buffer, purpose: SealPurpose, name: string) =>
  Buffer.concat([header, Buffer.from(`${purpose}\u0000${name}`, "utf8")]);

export const seal = (
  key: MasterKey,
  purpose: SealPurpose,
  name: string,
  plaintext: Uint8Array,
): Uint8Array => {
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_V1]), key.idBytes]);
  const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key.subkey(purpose), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(header, purpose, name));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]));
};

/** The header of a value stored as sealed: the key that sealed it, or a format not known here. */
export type SealedHeader =
  | { readonly _tag: "sealed"; readonly keyId: string }
  | { readonly _tag: "unknown-format" };

export const parseHeader = (stored: Uint8Array): SealedHeader => {
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  if (
    bytes.length < HEADER_BYTES ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    bytes[MAGIC.length] !== FORMAT_V1
  ) {
    return { _tag: "unknown-format" };
  }
  return {
    _tag: "sealed",
    keyId: bytes.subarray(MAGIC.length + 1, HEADER_BYTES).toString("hex"),
  };
};

export type OpenResult =
  | { readonly _tag: "opened"; readonly plaintext: Uint8Array }
  /** Not a sealed value of a format this version knows. */
  | { readonly _tag: "unknown-format" }
  /** Sealed by a key not among those given. */
  | { readonly _tag: "unknown-key"; readonly keyId: string }
  /** The key matches but the value does not open: altered, or stored under another name. */
  | { readonly _tag: "rejected" };

export const open = (
  keys: ReadonlyArray<MasterKey>,
  purpose: SealPurpose,
  name: string,
  stored: Uint8Array,
): OpenResult => {
  const header = parseHeader(stored);
  if (header._tag !== "sealed") return header;
  const key = keys.find((candidate) => candidate.id === header.keyId);
  if (key === undefined) return { _tag: "unknown-key", keyId: header.keyId };
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  if (bytes.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) return { _tag: "rejected" };
  const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key.subkey(purpose), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(bytes.subarray(0, HEADER_BYTES), purpose, name));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { _tag: "opened", plaintext: new Uint8Array(plaintext) };
  } catch {
    return { _tag: "rejected" };
  }
};
