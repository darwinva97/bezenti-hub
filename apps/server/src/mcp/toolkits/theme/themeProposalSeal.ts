// @effect-diagnostics-next-line nodeBuiltinImport:off -- projection is synchronous; Effect's Mac is effectful.
import * as NodeCrypto from "node:crypto";

import {
  THEME_PROPOSAL_SEAL_PATTERN,
  themeProposalColors,
  themeProposalSealMessage,
  type ThemeProposal,
} from "@t3tools/shared/themeProposal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";

/**
 * Proves a proposal's CSS came from this Hub's `t3_theme_propose`; no tool name can (a provider may
 * run its own server named t3-code, ACP reports bare names). HMAC-SHA256, key in module state because
 * WireProjection is a plain function. Without a key CSS is refused on proposing, dropped on projection.
 */
const SEAL_SECRET_NAME = "theme-proposal-seal";

let sealKey: Uint8Array | null = null;

export function installThemeProposalSealKey(key: Uint8Array | null): void {
  sealKey = key === null ? null : Uint8Array.from(key);
}

function mac(key: Uint8Array, proposal: ThemeProposal): Buffer {
  return NodeCrypto.createHmac("sha256", key).update(themeProposalSealMessage(proposal)).digest();
}

/** The seal for a proposal this Hub accepted, or null while there is no key. */
export function sealThemeProposal(proposal: ThemeProposal): string | null {
  return sealKey === null ? null : mac(sealKey, proposal).toString("base64url");
}

export function themeProposalSealValid(proposal: ThemeProposal, seal: unknown): boolean {
  if (sealKey === null || typeof seal !== "string" || !THEME_PROPOSAL_SEAL_PATTERN.test(seal)) {
    return false;
  }
  const given = Buffer.from(seal, "base64url");
  const expected = mac(sealKey, proposal);
  return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
}

/** A compact tool output as clients get it: a proposal keeps its CSS only under a valid seal. */
export function keepSealedThemeProposalCss<
  Output extends { themeProposal?: ThemeProposal; themeProposalSeal?: string },
>(output: Output | undefined): Output | undefined {
  const proposal = output?.themeProposal;
  if (output === undefined || proposal?.css === undefined) return output;
  if (themeProposalSealValid(proposal, output.themeProposalSeal)) return output;
  const { themeProposalSeal: _seal, ...rest } = output;
  return { ...rest, themeProposal: themeProposalColors(proposal) } as Output;
}

/** Loads the key at startup, so cards stored before a restart keep their CSS. Creates it once. */
export const layerInstallKey = Layer.effectDiscard(
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* secrets.getOrCreateRandom(SEAL_SECRET_NAME, 32);
    installThemeProposalSealKey(key);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("theme proposal seal key unavailable; proposals cannot carry CSS", {
        cause,
      }),
    ),
  ),
);
