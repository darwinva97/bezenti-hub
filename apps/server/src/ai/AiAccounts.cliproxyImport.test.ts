/**
 * Spec 4 ticket 15: CLIProxyAPI auth files from an old proxy become subscription AI accounts, as a
 * sign-in would leave them (sealed, disabled until the Owner confirms who they are signed in as,
 * allowed only to the Owner's Personal space), once per identity, by the Owner alone; turned on,
 * a request goes through the gateway under the account's prefix.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the fake gateway's folder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type AiAccountError, type AiAccountId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { call, hub, type Hub, messages, platform, posix } from "./AiGatewayRoute.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);

/** Every token in these files starts so: none may show outside the store and the gateway. */
const mentionsAToken = (text: string) => /fake-(access|refresh|idtoken)-/u.test(text);

/** Auth files as CLIProxyAPI 8.0.3 wrote them (fake values), keys as the Owner's old proxy has. */
const antigravityFile = {
  access_token: "fake-access-ag-1",
  disabled: false,
  email: "owner@gmail.example",
  expired: "2026-11-14T10:00:00Z",
  expires_in: 3599,
  project_id: "proj-ag-123",
  refresh_token: "fake-refresh-ag-1",
  timestamp: 1763000000000,
  type: "antigravity",
};
const claudeFile = {
  access_token: "fake-access-cl-1",
  account_uuid: "uuid-cl-1",
  claude_device_ids: ["device-1"],
  disabled: false,
  email: "owner@claude.example",
  expired: "2026-11-14T10:00:00Z",
  id_token: "fake-idtoken-cl-1",
  last_refresh: "2026-11-13T10:00:00Z",
  organization_name: "Owner's Org",
  organization_uuid: "org-uuid-1",
  priority: 0,
  refresh_token: "fake-refresh-cl-1",
  type: "claude",
  // Never kept: an imported file does not choose where requests or its token go.
  base_url: "https://evil.example",
  proxy_url: "http://evil.example:8080",
  prefix: "evil",
};
const codexFile = {
  access_token: "fake-access-cx-1",
  account_id: "acc-cx-1",
  disabled: true,
  email: "owner@openai.example",
  expired: "2026-11-14T10:00:00Z",
  id_token: "fake-idtoken-cx-1",
  last_refresh: "2026-11-13T10:00:00Z",
  refresh_token: "fake-refresh-cx-1",
  type: "codex",
};

const fileOf = (fileName: string, contents: unknown) => ({
  fileName,
  contents: Redacted.make(typeof contents === "string" ? contents : JSON.stringify(contents)),
});

const THREE = [
  fileOf("antigravity-owner@gmail.example.json", antigravityFile),
  fileOf("claude-1-owner@claude.example.json", claudeFile),
  fileOf("codex-1-owner@openai.example.json", codexFile),
];

const reasonOf = <A, R>(effect: Effect.Effect<A, AiAccountError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const tokensOf = (setup: Hub) =>
  Context.get(setup.server.services, ServerSecretStore.AiAccountTokenStore);

const rowsOf = (setup: Hub) =>
  setup.server.sql<{
    readonly accountId: string;
    readonly name: string;
    readonly credentialId: string | null;
  }>`SELECT account_id AS "accountId", name, credential_id AS "credentialId" FROM ai_accounts
     WHERE type = 'subscription' ORDER BY priority`;

const sealedOf = (setup: Hub, tokenId: string) =>
  tokensOf(setup)
    .get(tokenId)
    .pipe(
      Effect.map((value) =>
        Option.isNone(value)
          ? undefined
          : (JSON.parse(new TextDecoder().decode(value.value)) as Record<string, unknown>),
      ),
    );

live(
  "imports CLIProxyAPI auth files as disabled subscriptions signed in as their account, once each",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const result = yield* setup.accounts.importCliproxy({ files: THREE }).pipe(setup.asOwner);
      assert.deepEqual(
        result.files.map((file) => [file.fileName, file.outcome, file.name, file.signedInAs]),
        [
          [
            "antigravity-owner@gmail.example.json",
            "imported",
            "Antigravity (owner@gmail.example)",
            "owner@gmail.example",
          ],
          [
            "claude-1-owner@claude.example.json",
            "imported",
            "Claude (owner@claude.example)",
            "owner@claude.example",
          ],
          [
            "codex-1-owner@openai.example.json",
            "imported",
            "ChatGPT (owner@openai.example)",
            "owner@openai.example",
          ],
        ],
      );
      assert.isFalse(mentionsAToken(JSON.stringify(result)), "a token in the answer");

      const listed = yield* setup.accounts.list.pipe(setup.asOwner);
      for (const file of result.files) {
        const account = listed.accounts.find((one) => one.id === file.accountId);
        assert.isDefined(account, file.fileName);
        assert.equal(account!.type, "subscription");
        assert.isTrue(account!.disabled, `${file.fileName} enabled`);
        assert.include(account!.statusMessage ?? "", `Signed in as ${file.signedInAs}`);
        assert.equal(account!.details?.signedInAs, file.signedInAs);
        // The Owner's own: usable in their Personal space without a loan (Grants ticket 02).
        assert.deepEqual(account!.owner, { kind: "user", userId: setup.ownerId });
      }
      assert.deepEqual(
        listed.accounts.filter((one) => one.type === "subscription").map((one) => one.provider),
        ["antigravity", "claude", "codex"],
      );

      // Sealed as the file was, without what only steers CLIProxyAPI or where it sends things.
      const rows = yield* rowsOf(setup);
      const claudeRow = rows.find((row) => row.name === "Claude (owner@claude.example)")!;
      const {
        base_url: _base,
        proxy_url: _proxy,
        prefix: _prefix,
        disabled: _disabled,
        ...kept
      } = claudeFile;
      assert.deepEqual(yield* sealedOf(setup, claudeRow.credentialId!), kept);

      // Audited as an import, with no token anywhere in the database's rows.
      const audits = yield* setup.server.sql<{ readonly action: string; readonly text: string }>`
        SELECT action, CAST(detail_json AS TEXT) AS text FROM audit_log
        WHERE action = 'ai_account.create'
      `;
      assert.equal(audits.length, 3);
      for (const audit of audits) assert.include(audit.text, '"via":"import"');
      const everything = yield* setup.server.sql<Record<string, unknown>>`
        SELECT * FROM ai_accounts
      `;
      const auditRows = yield* setup.server.sql<Record<string, unknown>>`SELECT * FROM audit_log`;
      assert.isFalse(mentionsAToken(JSON.stringify([everything, auditRows])), "a token in the DB");
      // Not in the gateway either, until the Owner turns one on.
      const authDir = NodePath.join(setup.memory, "auth");
      const inGateway = NodeFS.existsSync(authDir) ? NodeFS.readdirSync(authDir) : [];
      for (const row of rows) {
        assert.isUndefined(inGateway.find((name) => name.startsWith(`acct-${row.accountId}-`)));
      }

      // Again (the same files, and the same identity twice in one go): nothing new.
      const again = yield* setup.accounts
        .importCliproxy({
          files: [...THREE, fileOf("claude-copy.json", { ...claudeFile, access_token: "x" })],
        })
        .pipe(setup.asOwner);
      assert.deepEqual(
        again.files.map((file) => file.outcome),
        ["skipped", "skipped", "skipped", "skipped"],
      );
      assert.include(again.files[1]!.reason ?? "", "Claude (owner@claude.example)");
      assert.equal((yield* rowsOf(setup)).length, 3);

      const fresh = yield* setup.accounts
        .importCliproxy({
          files: [
            fileOf("a.json", { ...claudeFile, email: "second@claude.example", account_uuid: "u2" }),
            fileOf("b.json", { ...claudeFile, email: "second@claude.example", account_uuid: "u2" }),
          ],
        })
        .pipe(setup.asOwner);
      assert.deepEqual(
        fresh.files.map((file) => file.outcome),
        ["imported", "skipped"],
      );
    }).pipe(Effect.scoped),
);

live("keeps only the keys CLIProxyAPI's sign-ins carry: headers and routing variants go", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const {
      base_url: _base,
      proxy_url: _proxy,
      prefix: _prefix,
      disabled: _disabled,
      ...kept
    } = claudeFile;
    const result = yield* setup.accounts
      .importCliproxy({
        files: [
          fileOf("claude.json", {
            ...claudeFile,
            headers: { "X-Exfiltrate": "1" },
            "header:X-Exfiltrate": "1",
            PROXY_URL: "http://evil.example:8080",
            "proxy-url": "http://evil.example:8080",
            "base-url": "https://evil.example",
            Base_Url: "https://evil.example",
            label: "anything else",
          }),
        ],
      })
      .pipe(setup.asOwner);
    assert.equal(result.files[0]!.outcome, "imported");
    const row = (yield* rowsOf(setup))[0]!;
    assert.deepEqual(yield* sealedOf(setup, row.credentialId!), kept);
  }).pipe(Effect.scoped),
);

live("a token without the provider's account id is the same account as one with it", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { account_uuid: _uuid, ...withoutId } = claudeFile;
    // As a sign-in may have left it: no account_uuid. The old proxy's file names one.
    const first = yield* setup.accounts
      .importCliproxy({ files: [fileOf("signed-in.json", withoutId)] })
      .pipe(setup.asOwner);
    assert.equal(first.files[0]!.outcome, "imported");
    const second = yield* setup.accounts
      .importCliproxy({
        files: [
          fileOf("old-proxy.json", claudeFile),
          fileOf("other-org.json", { ...claudeFile, account_uuid: "uuid-cl-2" }),
          fileOf("again-other-org.json", { ...claudeFile, account_uuid: "uuid-cl-2" }),
        ],
      })
      .pipe(setup.asOwner);
    assert.deepEqual(
      second.files.map((file) => file.outcome),
      // The id-less account matches any id, so the second org is held already, as it may be.
      ["skipped", "skipped", "skipped"],
    );
    // The other way round: an id-less file matches an account that has an id.
    const setup2 = yield* hub;
    yield* setup2.accounts
      .importCliproxy({ files: [fileOf("old-proxy.json", claudeFile)] })
      .pipe(setup2.asOwner);
    const reverse = yield* setup2.accounts
      .importCliproxy({
        files: [
          fileOf("signed-in.json", withoutId),
          fileOf("other-org.json", { ...claudeFile, account_uuid: "uuid-cl-2" }),
        ],
      })
      .pipe(setup2.asOwner);
    assert.deepEqual(
      reverse.files.map((file) => file.outcome),
      ["skipped", "imported"],
    );
    assert.equal((yield* rowsOf(setup2)).length, 2);
  }).pipe(Effect.scoped),
);

live("skips what is not a subscription it knows, with a reason, and seals nothing", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const before = (yield* tokensOf(setup).list).length;
    const result = yield* setup.accounts
      .importCliproxy({
        files: [
          fileOf("gemini.json", { ...antigravityFile, type: "gemini-cli" }),
          fileOf("vertex.json", { ...antigravityFile, type: "vertex" }),
          fileOf("broken.json", "{not json fake-refresh-broken"),
          fileOf("no-email.json", { ...claudeFile, email: "" }),
          fileOf("no-refresh.json", { ...codexFile, refresh_token: "" }),
          fileOf("array.json", [claudeFile]),
        ],
      })
      .pipe(setup.asOwner);
    assert.deepEqual(
      result.files.map((file) => file.outcome),
      ["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"],
    );
    for (const file of result.files) assert.isNotNull(file.reason, file.fileName);
    assert.include(result.files[0]!.reason ?? "", "gemini-cli");
    assert.isFalse(mentionsAToken(JSON.stringify(result)));
    assert.equal((yield* tokensOf(setup).list).length, before);
    assert.equal((yield* rowsOf(setup)).length, 0);
  }).pipe(Effect.scoped),
);

live("only the Owner imports: not a Member, an Admin, nor the Owner's agent bound to a Space", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    for (const actor of [
      CommandActor.actAs(setup.people.member),
      CommandActor.actAs(setup.people.admin),
      CommandActor.actAsResolved({
        _tag: "User",
        userId: setup.ownerId,
        spaceLimit: setup.acmeId,
      }),
    ]) {
      assert.equal(
        yield* reasonOf(setup.accounts.importCliproxy({ files: THREE }).pipe(actor)),
        "forbidden",
      );
    }
    assert.equal((yield* rowsOf(setup)).length, 0);
    assert.equal((yield* tokensOf(setup).list).length, 0);
  }).pipe(Effect.scoped),
);

live(
  "an imported subscription, turned on, serves a turn through the gateway under its prefix",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const result = yield* setup.accounts
        .importCliproxy({ files: [THREE[1]!] })
        .pipe(setup.asOwner);
      const accountId = result.files[0]!.accountId as AiAccountId;
      yield* setup.accounts.update({ accountId, disabled: false }).pipe(setup.asOwner);

      const authDir = NodePath.join(setup.memory, "auth");
      const file = NodeFS.readdirSync(authDir).find((name) =>
        name.startsWith(`acct-${accountId}-tok-`),
      );
      assert.isDefined(file, "the token is not in the gateway");
      const inGateway = JSON.parse(
        NodeFS.readFileSync(NodePath.join(authDir, file!), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(inGateway.prefix, `acct-${accountId}`);
      assert.isUndefined(inGateway.base_url);
      assert.isUndefined(inGateway.proxy_url);

      const personal = SpaceDirectory.personalSpaceIdOf(setup.ownerId);
      const thread = yield* setup.thread(setup.ownerId, personal);
      const answer = yield* call(setup, "/api/ai/anthropic/v1/messages", {
        key: thread.key,
        body: messages(),
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${accountId}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);
