import { useState } from "react";
import type { ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { api, useLoad } from "./api";
import { Load } from "./Load";
import { Page } from "./Surface";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** One settings row: what it is on the left, its controls on the right (stacked on phones). */
function Row({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="settings-row">
      <VStack gap={1}>
        <Heading level={2} id={id}>{title}</Heading>
        {description && <Text as="p" type="supporting" size="sm">{description}</Text>}
      </VStack>
      <VStack gap={3}>{children}</VStack>
    </section>
  );
}

export default function Settings({ name, onSignedOut }: { name: string; onSignedOut: () => void }) {
  return (
    <Page title="Settings">
      <VStack gap={4} maxWidth={960}>
        <Row id="setup-heading" title="Connections" description="Which accounts Stupid reads, and anything Meta still needs.">
          <HStack><Button label="Open setup" href="#setup" /></HStack>
        </Row>
        <AgentRules />
        <AiAccess />
        <Account name={name} onSignedOut={onSignedOut} />
      </VStack>
    </Page>
  );
}

function AgentRules() {
  const home = useLoad("agent", api.agent);
  return (
    <Row id="agent-heading" title="Your agent" description="When it drafts, and the rules it follows.">
      <Load state={home}>{h => <AgentForm proactive={h.proactive} rules={h.rules} onSaved={saved => home.setData(d => d && { ...d, ...saved })} />}</Load>
    </Row>
  );
}

function AgentForm({ proactive, rules, onSaved }: { proactive: boolean; rules: string; onSaved: (s: { proactive: boolean; rules: string }) => void }) {
  const [on, setOn] = useState(proactive);
  const [text, setText] = useState(rules);
  const [status, setStatus] = useState<{ type: "error" | "success"; message: string }>();
  const save = (nextOn: boolean, nextText: string) => api.agentSettings(nextOn, nextText).then(
    saved => { setStatus({ type: "success", message: "Saved." }); onSaved(saved); },
    (cause: unknown) => setStatus({ type: "error", message: message(cause) }));
  return (
    <VStack gap={4}>
      <Switch label="Draft replies when new messages arrive" value={on} changeAction={v => { setOn(v); return save(v, text); }}
        description="Each new message gets a reply draft, or one question for you, within about a minute. Nothing is sent without your tap." />
      <TextArea label="Rules for your agent" value={text} onChange={v => { setText(v); setStatus(undefined); }} rows={4} maxLength={2000} isOptional
        description="Plain words it follows, like your hours, prices, delivery areas or what to leave alone." />
      <div aria-live="polite">{status && <Text as="p" color={status.type === "error" ? "primary" : "secondary"}>{status.message}</Text>}</div>
      <HStack><Button label="Save rules" isDisabled={text.trim() === rules} clickAction={() => save(on, text)} /></HStack>
    </VStack>
  );
}

function AiAccess() {
  const ai = useLoad("settings-ai", api.aiSettings);
  const [key, setKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<{ type: "error" | "success"; message: string }>();
  const save = async (next: string) => {
    try {
      const saved = await api.setAiKey(next, consent);
      ai.setData(d => d && { ...d, ...saved });
      setKey("");
      setConsent(false);
      setStatus({ type: "success", message: next ? "Key saved. It's kept on Stupid's server and never shown again." : "Your key is removed." });
    } catch (cause) {
      setStatus({ type: "error", message: message(cause) });
    }
  };
  return (
    <Row id="ai-heading" title="AI access" description="What runs your agents.">
      <Load state={ai}>{s => (
        <VStack gap={4}>
          <Text as="p">
            {s.has_key ? `Agents run on ${s.model} with your own Baseten API key.`
              : s.workspace_ai ? `Agents run on ${s.model} using Stupid's shared allowance. Add your own Baseten API key to run them on your account instead.`
              : "Add your own Baseten API key so agents can run."}
          </Text>
          {s.has_key && s.key_saved_at && <Text as="p" type="supporting" size="sm">Saved <Timestamp value={s.key_saved_at} format="relative" /></Text>}
          <TextInput type="password" label={s.has_key ? "Replace your own Baseten API key" : "Your own Baseten API key"} value={key} onEnter={() => key.trim() && consent && void save(key.trim())}
            onChange={v => { setKey(v); setStatus(undefined); }} description="We check it with one small test call, then store it encrypted. It never comes back to this page." />
          <CheckboxInput label="Send the messages agents read to my own AI account" value={consent} onChange={setConsent}
            description="Agents send message text and first names, captions and campaign totals to your Baseten account, never phone numbers or IDs." />
          <div aria-live="polite">{status && <Text as="p" color={status.type === "error" ? "primary" : "secondary"}>{status.message}</Text>}</div>
          <HStack gap={2} wrap="wrap">
            <Button variant="primary" label="Save key" isDisabled={!key.trim() || !consent} clickAction={() => save(key.trim())} />
            {s.has_key && <Button variant="ghost" label="Remove my key" clickAction={() => save("")} />}
          </HStack>
        </VStack>
      )}</Load>
    </Row>
  );
}

function Account({ name, onSignedOut }: { name: string; onSignedOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const act = (call: () => Promise<unknown>) => async () => {
    try {
      await call();
      onSignedOut();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const remove = async () => {
    setDeleting(true);
    await act(api.disconnect)();
    setDeleting(false);
    setConfirming(false);
  };
  return (
    <Row id="account-heading" title="Your account" description={`Signed in with Facebook as ${name}.`}>
      <HStack gap={2} wrap="wrap">
        <Button label="Sign out" clickAction={act(api.signOut)} />
        <Button variant="destructive" label="Disconnect and delete my data" onClick={() => setConfirming(true)} />
      </HStack>
      <Text as="p" type="supporting" size="sm">Deleting removes Stupid's access to your Meta apps and deletes your messages, numbers and agent results from Stupid.</Text>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
      <AlertDialog isOpen={confirming} onOpenChange={setConfirming} title="Delete everything?"
        description="This can't be undone. Stupid loses access to your Meta apps and deletes your messages, numbers and agent results."
        actionLabel="Yes, delete everything" onAction={() => void remove()} isActionLoading={deleting} />
    </Row>
  );
}
