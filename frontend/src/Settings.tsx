import { useState } from "react";
import type { ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { api, useLoad } from "./api";
import type { AiSettings, Persona } from "./api";
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

export default function Settings({ name, persona, onPersona, onSignedOut }: {
  name: string; persona: Persona | null; onPersona: (persona: Persona) => Promise<void>; onSignedOut: () => void;
}) {
  return (
    <Page title="Settings">
      <VStack gap={4} maxWidth={960}>
        <Path persona={persona} onPersona={onPersona} />
        <Row id="setup-heading" title="Connections" description="Which accounts Stupid reads, and anything Meta still needs.">
          <HStack><Button label="Open setup" href="#setup" /></HStack>
        </Row>
        <AgentRules />
        <AiAccess />
        <UseFromMuse />
        <Account name={name} onSignedOut={onSignedOut} />
      </VStack>
    </Page>
  );
}

/** Creator or business: which apps setup asks for and which agents come first. */
function Path({ persona, onPersona }: { persona: Persona | null; onPersona: (persona: Persona) => Promise<void> }) {
  const [error, setError] = useState("");
  return (
    <Row id="path-heading" title="Your work on Meta" description="Changes the setup steps and the order of your agents. Nothing you connected is removed.">
      <HStack>
        <SegmentedControl label="I mostly" value={persona ?? ""} onChange={v => void onPersona(v as Persona).then(() => setError(""), (cause: unknown) => setError(message(cause)))}>
          <SegmentedControlItem value="creator" label="Create content" />
          <SegmentedControlItem value="business" label="Run a business" />
        </SegmentedControl>
      </HStack>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
    </Row>
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

const connectorPrompt = (url: string) => `Create a custom connector called Stupid.
MCP server URL: ${url}
Authentication: Bearer token. I'll paste my Stupid access key when you ask.
It reads my Stupid inbox, ads, Instagram, leads, drafts and ad advice, watches my videos, can queue reply drafts, save post ideas and start Stupid's jobs. It can't send anything: I send from Stupid.`;

/** Muse Code's user settings, ~/.config/muse/settings.json. The key stays in an environment variable. */
const museCodeSettings = (url: string) => JSON.stringify({
  schema_version: 1,
  mcp_servers: { stupid: { transport: "streamable_http", url, headers: { Authorization: "${STUPID_MCP_AUTH}" }, mode: "optional" } },
}, null, 2);

/** A key for Muse's custom connector, shown once, with the URL and the words to paste into Muse. */
function UseFromMuse() {
  const status = useLoad("mcp-key", api.mcpKey);
  const [made, setMade] = useState<string>();
  const [error, setError] = useState("");
  const act = (call: () => Promise<unknown>) => () => call().then(() => status.reload(), (cause: unknown) => setError(message(cause)));
  return (
    <Row id="muse-heading" title="Use Stupid from Muse" description="Muse and Muse Code can read your inbox and queue reply drafts here, on your Muse subscription. Sending still needs your tap in Stupid.">
      <Load state={status}>{k => (
        <VStack gap={4}>
          <Text as="p">{k.has_key
            ? <>Muse has a key{k.created && <>, made <Timestamp value={k.created} format="relative" /></>}. {k.last_used ? <>Last used <Timestamp value={k.last_used} format="relative" />.</> : "Not used yet."}</>
            : "No key yet. Make one, then give Muse the URL and the key."}</Text>
          {made && <VStack gap={2}>
            <Text as="p" weight="semibold">Your key, shown once:</Text>
            <TextInput label="Access key" isLabelHidden value={made} onChange={() => undefined} />
            <HStack><Copy text={made} label="Copy key" /></HStack>
          </VStack>}
          <TextInput label="MCP server URL" value={k.url} onChange={() => undefined} />
          <TextArea label="Ask Muse to add Stupid" value={connectorPrompt(k.url)} onChange={() => undefined} rows={5} />
          <HStack gap={2} wrap="wrap">
            <Copy text={connectorPrompt(k.url)} label="Copy the words for Muse" />
            <Button variant="primary" label={k.has_key ? "Make a new key" : "Make a key"} clickAction={() => api.createMcpKey().then(r => { setMade(r.key); setError(""); return status.reload(); }, (cause: unknown) => setError(message(cause)))} />
            {k.has_key && <Button variant="ghost" label="Revoke the key" clickAction={act(() => api.revokeMcpKey().then(() => setMade(undefined)))} />}
          </HStack>
          <details>
            <summary>Use it from Muse Code</summary>
            <VStack gap={3}>
              <ol className="steps">
                <li>Add the stupid server to <code>~/.config/muse/settings.json</code>. If the file already exists, add only the <code>stupid</code> entry under <code>mcp_servers</code>.</li>
                <li>In your shell profile, set <code>export STUPID_MCP_AUTH="Bearer your-key"</code>, so the key never sits in the settings file.</li>
                <li>Start Muse Code and run <code>/mcp</code> to see Stupid's tools. Then ask, for example, "What's waiting in my Stupid inbox? Queue a reply to the newest message."</li>
              </ol>
              <TextArea label="Muse Code settings" value={museCodeSettings(k.url)} onChange={() => undefined} rows={9} />
              <HStack><Copy text={museCodeSettings(k.url)} label="Copy the settings" /></HStack>
            </VStack>
          </details>
          <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
        </VStack>
      )}</Load>
    </Row>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [shown, setShown] = useState(label);
  return <Button label={shown} clickAction={() => navigator.clipboard.writeText(text).then(() => setShown("Copied"), () => setShown("Couldn't copy"))} />;
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
          {s.meta_brain && (
            <VStack gap={2}>
              <SegmentedControl label="Model that runs your agents" value={s.brain}
                onChange={v => void api.setBrain(v as AiSettings["brain"]).then(next => ai.setData(next), (cause: unknown) => setStatus({ type: "error", message: message(cause) }))}>
                <SegmentedControlItem value="open" label="Muse Spark Open" />
                <SegmentedControlItem value="meta" label="Muse Spark 1.3 · Meta API" />
              </SegmentedControl>
              <Text as="p" type="supporting" size="sm">Both see pictures and use the same tools. Muse Spark 1.3 runs on Meta's Model API with Stupid's key.</Text>
            </VStack>
          )}
          {s.brain === "meta" ? <Text as="p">Agents run on {s.meta_model} through Meta's Model API, using Stupid's shared allowance.</Text> : <Text as="p">
            {s.has_key ? `Agents run on ${s.model} with your own Baseten API key.`
              : s.workspace_ai ? `Agents run on ${s.model} using Stupid's shared allowance. Add your own Baseten API key to run them on your account instead.`
              : "Add your own Baseten API key so agents can run."}
          </Text>}
          {s.has_key && s.key_saved_at && <Text as="p" type="supporting" size="sm">Saved <Timestamp value={s.key_saved_at} format="relative" /></Text>}
          <details className="more" open={s.has_key || undefined}>
            <summary>Use your own Baseten key</summary>
            <VStack gap={4}>
              <details>
                <summary>How to get, pay for and revoke a key</summary>
                <VStack gap={3}>
                  <Text as="p" type="supporting">Your own key is optional when Stupid's shared allowance is available. Baseten bills your account for model usage, including the small call that checks a key when you save it. Check the current model price and your Baseten billing before saving; Stupid's shared allowance does not cover your own key.</Text>
                  <ol className="steps">
                    <li>Open Baseten → Organization settings → <Link hasUnderline isExternalLink href="https://app.baseten.co/settings/api_keys">API keys</Link> → Create API key. Give it a name such as stupid-replies.</li>
                    <li>Choose Team → Next, select your team if asked, then Call Model APIs → Create API key. Copy the key now; Baseten shows it once. Ask your team admin if that option is unavailable.</li>
                    <li>Paste it below, read and tick the data-sharing consent, then tap Save key. The key is stored encrypted on Stupid's server.</li>
                  </ol>
                  <Text as="p" type="supporting">To stop Stupid using the key, tap Remove my key. To revoke it everywhere, open Baseten's API keys page and select the trash icon beside this key. Revocation is permanent. Baseten also revokes keys unused for 30 days; create a new key if needed.</Text>
                  <HStack gap={3} wrap="wrap">
                    <Link hasUnderline isExternalLink href="https://docs.baseten.co/inference/model-apis/pricing-and-limits">Check current prices</Link>
                    <Link hasUnderline isExternalLink href="https://docs.baseten.co/organization/api-keys">Baseten's key instructions</Link>
                  </HStack>
                </VStack>
              </details>
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
          </details>
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
