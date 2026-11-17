/** Owned-resources 03 and 04: a User's Vault is made with the User, its `default` in the same write. */
import { assert, it } from "@effect/vitest";
import { UserId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as Users from "./Users.ts";

const layer = Users.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const defaultsOf = (sql: SqlClient.SqlClient, userId: string) =>
  sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM vault_groups
    WHERE owner_kind = 'user' AND owner_id = ${userId} AND is_default = 1 AND name = 'default'
  `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));

it.effect("the Owner and every User get their own `default` group when they are made", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const users = yield* Users.UserRepository;
    const createdAt = yield* DateTime.now;
    const passkey = {
      credentialId: "key-1",
      publicKey: "public",
      signCount: 0,
      transports: [] as ReadonlyArray<string>,
      rpId: "127.0.0.1",
    };
    assert.isTrue(
      yield* users.createOwner({
        userId: UserId.make("owner"),
        displayName: "Owner",
        createdAt,
        passkey,
        recoveryCodeHashes: [],
      }),
    );
    assert.isTrue(
      yield* sql.withTransaction(
        users.createUser({
          userId: UserId.make("ana"),
          displayName: "Ana",
          createdAt,
          passkey: { ...passkey, credentialId: "key-2" },
          password: null,
          totp: null,
        }),
      ),
    );
    assert.equal(yield* defaultsOf(sql, "owner"), 1);
    assert.equal(yield* defaultsOf(sql, "ana"), 1);
  }).pipe(Effect.provide(layer)),
);
