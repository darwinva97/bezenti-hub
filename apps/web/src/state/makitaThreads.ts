import type { MakitaThread } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "./environments";
import { makitaEnvironment } from "./makita";
import { useEnvironmentQuery } from "./query";

const NONE: ReadonlyMap<string, MakitaThread> = new Map();

/**
 * The Makita tasks of the Threads this person may see, by Thread id (Makita ticket 07): the
 * Thread header's «Makita · repo#n» and the Thread list's «Makita» filter. Empty when none.
 */
export function useMakitaThreads(): ReadonlyMap<string, MakitaThread> {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : makitaEnvironment.threads({ environmentId, input: {} }),
  );
  const threads = query.data?.threads;
  return threads === undefined || threads.length === 0
    ? NONE
    : new Map(threads.map((thread) => [thread.threadId, thread]));
}
