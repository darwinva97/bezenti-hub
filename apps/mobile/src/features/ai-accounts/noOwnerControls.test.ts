import { MOBILE_FORBIDDEN_AI_METHODS } from "@t3tools/client-runtime/ai-accounts-view";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Signing in to subscriptions and updating the gateway stay on web and desktop (spec 4, «Clientes»).
const FORBIDDEN_ATOMS =
  /aiGatewayEnvironment\s*\.\s*(startAccountLogin|completeAccountLogin|importVertexAccount|createAccount|updateAccount|deleteAccount|reorderAccounts|update|rollback|setEnabled)\b|aiGatewayEnvironment\s*\[/;

const sourceRoot = NodePath.resolve(__dirname, "../..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/noOwnerControls\.test\.ts$/.test(entry.name))
      yield full;
  }
}

describe("the mobile client never signs in to an AI account or manages the AI gateway", () => {
  it("calls no Owner command of the AI gateway state", () => {
    const offenders = [...sourceFiles(sourceRoot)].flatMap((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return FORBIDDEN_ATOMS.test(text) ? [NodePath.relative(sourceRoot, file)] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("names no forbidden RPC method", () => {
    const offenders = [...sourceFiles(sourceRoot)].flatMap((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return MOBILE_FORBIDDEN_AI_METHODS.filter((method) => text.includes(`"${method}"`)).map(
        (method) => `${NodePath.relative(sourceRoot, file)}: ${method}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
