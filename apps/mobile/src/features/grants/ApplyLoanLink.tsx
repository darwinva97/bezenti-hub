import {
  grantOfferTokenOf,
  limitsText,
  offerSpaceLabel,
  offerWarnings,
  spaceLabel,
} from "@t3tools/client-runtime/grants-view";
import type { EnvironmentId, GrantOfferPreview, SpaceId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "../ai-accounts/failureMessage";

type Valid = Extract<GrantOfferPreview, { status: "valid" }>;

/** What a link that no longer works says (web's words). */
const DEAD =
  "This lending link no longer works. A lending link works once, for 7 days, until its lender cancels it. Ask them for a new one.";

const NOT_A_LINK =
  "That is not a lending link. Paste the whole link you were sent, ending in #token=…";

const MACHINE_LINK_NOTE =
  "Applying a machine's link needs a passkey or authenticator code: open the link on the web or desktop app.";

/** The read link, with its token kept only here, in memory, until it is applied or replaced. */
interface ReadLink {
  readonly token: string;
  readonly offer: Valid;
}

/**
 * «Apply a lending link» on a phone: the User pastes a link, sees what is lent, by whom, with
 * which limits and warnings, picks a Space where they decide on loans and applies it (accepting
 * the loan there). A machine's link needs the strong factor: that stays on web and desktop. The
 * token is never logged nor stored.
 */
export function ApplyLoanLink(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const readOffer = useAtomCommand(grantsEnvironment.readOffer, {
    label: "read a lending link",
    reportFailure: false,
    reportDefect: false,
  });
  const claimOffer = useAtomCommand(grantsEnvironment.claimOffer, {
    label: "apply a lending link",
    reportFailure: false,
    reportDefect: false,
  });
  const [link, setLink] = useState("");
  const [read, setRead] = useState<ReadLink | null>(null);
  const [dead, setDead] = useState(false);
  const [spaceId, setSpaceId] = useState<SpaceId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const check = async () => {
    setError(null);
    setDone(null);
    setDead(false);
    setRead(null);
    setSpaceId(null);
    const token = grantOfferTokenOf(link);
    if (token === null) {
      setError(NOT_A_LINK);
      return;
    }
    setPending(true);
    try {
      const result = await readOffer({ environmentId, input: { token } });
      if (result._tag !== "Success") {
        setError(commandFailureMessage(result, "Could not read this link."));
        return;
      }
      // The token now lives only in `read`; the field is cleared.
      setLink("");
      if (result.value.status === "invalid") setDead(true);
      else setRead({ token, offer: result.value });
    } finally {
      setPending(false);
    }
  };

  const offer = read?.offer ?? null;
  const machine = offer?.resource.kind === "environment";
  const chosen = offer?.spaces.find((space) => space.spaceId === spaceId);

  const apply = async () => {
    if (read === null || chosen === undefined || chosen.alreadyGranted || machine) return;
    setPending(true);
    setError(null);
    try {
      const result = await claimOffer({
        environmentId,
        input: { token: read.token, spaceId: chosen.spaceId },
      });
      if (result._tag !== "Success") {
        setError(commandFailureMessage(result, "The link did not apply."));
        return;
      }
      setRead(null);
      setSpaceId(null);
      setDone(`Lent to ${spaceLabel(chosen)}: its Threads can use it now.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <View className="gap-6">
      <ListSection
        title="Paste the link"
        footer="Someone who lends you a resource can send you a link. It works once, for 7 days."
      >
        <View className="gap-2 px-4 py-3">
          <TextInput
            accessibilityLabel="Lending link"
            placeholder="https://…/grants/offer#token=…"
            value={link}
            onChangeText={setLink}
            editable={!pending}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          <Button
            label="Read link"
            tone="primary"
            size="compact"
            disabled={pending || link.trim().length === 0}
            onPress={() => void check()}
          />
        </View>
      </ListSection>
      {dead ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground-muted">
          {DEAD}
        </Text>
      ) : null}
      {offer === null ? null : (
        <ListSection title={`${offer.lender.name ?? "Someone"} lends you ${offer.resource.name}`}>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground">
              {machine
                ? "A machine: your Space gets a Sandbox of its own on it"
                : offer.resource.kind === "vault-group"
                  ? "A Vault group for your Threads"
                  : "An AI account for your Threads, through the AI gateway"}{" "}
              · {limitsText(offer.limits)}. The link works once, until{" "}
              {new Date(offer.expiresAt).toLocaleString()}.
            </Text>
            {offerWarnings(offer).map((warning) => (
              <Text key={warning} className="text-sm text-warning-foreground">
                {warning}
              </Text>
            ))}
            {machine ? (
              <Text className="text-sm text-foreground-muted">{MACHINE_LINK_NOTE}</Text>
            ) : offer.spaces.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                You decide on loans in none of your Spaces here: only an Organization's Admins, or a
                Personal space's owner, accept one.
              </Text>
            ) : null}
          </View>
          {machine
            ? null
            : offer.spaces.map((space, index) => (
                <ListChoiceRow
                  key={space.spaceId}
                  label={offerSpaceLabel(space)}
                  selected={spaceId === space.spaceId}
                  disabled={space.alreadyGranted || pending}
                  separated={index > 0}
                  onPress={() => setSpaceId(space.spaceId)}
                />
              ))}
        </ListSection>
      )}
      {offer !== null && !machine && offer.spaces.length > 0 ? (
        <Button
          label="Accept the loan"
          tone="primary"
          loading={pending}
          disabled={pending || chosen === undefined || chosen.alreadyGranted}
          onPress={() => void apply()}
          fullWidth
        />
      ) : null}
      {done === null ? null : (
        <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-foreground">
          {done}
        </Text>
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}
