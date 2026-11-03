import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { api, useLoad } from "./api";
import { Load } from "./Load";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function Settings({ name, onSignedOut }: { name: string; onSignedOut: () => void }) {
  return (
    <VStack gap={10} maxWidth={640}>
      <Heading level={1}>Settings</Heading>
      <VStack gap={2} as="section" aria-labelledby="setup-heading">
        <Heading level={2} id="setup-heading">Setup</Heading>
        <Text as="p" type="supporting">Which accounts Secnd reads, and anything Meta still needs. <Link hasUnderline href="#setup">Open setup</Link></Text>
      </VStack>
      <AiAccess />
      <Account name={name} onSignedOut={onSignedOut} />
    </VStack>
  );
}

function AiAccess() {
  const ai = useLoad("settings-ai", api.aiSettings);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{ type: "error" | "success"; message: string }>();
  const save = async (next: string) => {
    try {
      const saved = await api.setAiKey(next);
      ai.setData(d => d && { ...d, ...saved });
      setKey("");
      setStatus({ type: "success", message: next ? "Key saved. It's kept on Secnd's server and never shown again." : "Your key is removed." });
    } catch (cause) {
      setStatus({ type: "error", message: message(cause) });
    }
  };
  return (
    <VStack gap={4} as="section" aria-labelledby="ai-heading">
      <Heading level={2} id="ai-heading">AI access</Heading>
      <Load state={ai}>{s => (
        <VStack gap={4}>
          <Text as="p" type="supporting">
            {s.has_key ? `Agents run on ${s.model} with your own key.`
              : s.workspace_ai ? `Agents run on ${s.model} using Secnd's shared allowance. Add your own key to run them on your account instead.`
              : "Add your Muse API key from Meta so agents can run."}
          </Text>
          <TextInput type="password" label={s.has_key ? "Replace your Muse API key" : "Your Muse API key"} value={key} onEnter={() => key.trim() && void save(key.trim())}
            onChange={v => { setKey(v); setStatus(undefined); }} description="We check it with one small test call, then store it encrypted. It never comes back to this page." />
          <div aria-live="polite">{status && <Text as="p" color={status.type === "error" ? "primary" : "secondary"}>{status.message}</Text>}</div>
          <HStack gap={2} wrap="wrap">
            <Button variant="primary" label="Save key" isDisabled={!key.trim()} clickAction={() => save(key.trim())} />
            {s.has_key && <Button variant="ghost" label="Remove my key" clickAction={() => save("")} />}
          </HStack>
        </VStack>
      )}</Load>
    </VStack>
  );
}

function Account({ name, onSignedOut }: { name: string; onSignedOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const act = (call: () => Promise<unknown>) => async () => {
    try {
      await call();
      onSignedOut();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <VStack gap={4} as="section" aria-labelledby="account-heading">
      <Heading level={2} id="account-heading">Your account</Heading>
      <Text as="p" type="supporting">Signed in with Facebook as {name}.</Text>
      <HStack gap={2}><Button label="Sign out" clickAction={act(api.signOut)} /></HStack>
      <VStack gap={3}>
        <Heading level={3}>Disconnect and delete</Heading>
        <Text as="p" type="supporting">Removes Secnd's access to your Meta apps and deletes your messages, numbers and agent results from Secnd.</Text>
        {confirming ? (
          <VStack gap={3} role="group" aria-label="Confirm deletion">
            <Text as="p" weight="semibold">This can't be undone. Delete everything now?</Text>
            <HStack gap={2} wrap="wrap">
              <Button variant="destructive" label="Yes, delete everything" clickAction={act(api.disconnect)} />
              <Button variant="ghost" label="Cancel" onClick={() => setConfirming(false)} />
            </HStack>
          </VStack>
        ) : <HStack gap={2}><Button variant="destructive" label="Disconnect and delete my data" onClick={() => setConfirming(true)} /></HStack>}
      </VStack>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
    </VStack>
  );
}
