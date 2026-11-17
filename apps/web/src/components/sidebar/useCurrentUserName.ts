import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { fetchAccount } from "../../environments/primary/userAccounts";

const currentUserNameAtom = Atom.make(
  Effect.promise(() =>
    fetchAccount().then(
      (account) => account.user.displayName,
      () => null,
    ),
  ),
).pipe(
  Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
  Atom.setIdleTTL(5 * 60_000),
  Atom.withLabel("primary-environment:user-name"),
);

/** The signed-in User's name, once it is loaded. Mount it only for a session with a User. */
export function useCurrentUserName(): string | null {
  return AsyncResult.getOrElse(useAtomValue(currentUserNameAtom), () => null);
}
