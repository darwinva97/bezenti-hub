import { ConnectionsSettings } from "./ConnectionsSettings";

/** The User's sessions, pairing links and the permissions of this session. */
export function UserSessionsSettings() {
  return <ConnectionsSettings view="sessions" />;
}
