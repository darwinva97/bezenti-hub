import { createGrantsEnvironmentAtoms } from "@t3tools/client-runtime/state/grants";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Loans (Grants) over the Hub's WebSocket, from the one client-runtime source web uses: the lists,
 * rejecting, giving back, taking back and lending links. Accepting goes over HTTP
 * (`features/grants/acceptLoan.ts`); a machine's needs a strong factor mobile does not ask for.
 */
export const grantsEnvironment = createGrantsEnvironmentAtoms(connectionAtomRuntime);
