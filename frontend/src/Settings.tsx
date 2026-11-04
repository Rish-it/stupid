import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { api, useLoad } from "./api";
import type { Account, AiModel, AiSettings, Fact, Persona } from "./api";
import { Load } from "./Load";
import { modelName } from "./Trace";
import OnYourWhatsApp from "./OwnerChannel";
import Setup from "./Setup";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** One part of a section: what it is, then its controls. */
function Row({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="settings-row">
      <VStack gap={1}>
        <Heading level={3} id={id}>{title}</Heading>
        {description && <Text as="p" type="supporting" size="sm">{description}</Text>}
      </VStack>
      <VStack gap={3}>{children}</VStack>
    </section>
  );
}

const sections = ["On your WhatsApp", "Your work", "Connections", "Your agent", "AI model", "Muse", "Account"] as const;
type Section = typeof sections[number];

const focusRail = () => document.querySelector<HTMLElement>(".rail-me")?.focus();

/** Settings is a window over the app: sections on the left, the chosen one on the right. Nothing scrolls the page. */
export default function Settings({ name, persona, account, onAccount, onConnect, onPersona, onSignedOut, onClose }: {
  name: string; persona: Persona | null; account: Account; onAccount: (next: Account) => void; onConnect: () => void;
  onPersona: (persona: Persona) => Promise<void>; onSignedOut: () => void; onClose: () => void;
}) {
  const [section, setSection] = useState<Section>("On your WhatsApp");
  // Closing hands focus back to the rail's Settings link, which opened it.
  // A closing transition waits for this unmount: the page behind is then in place (rAF doesn't run during one).
  const closed = useRef<() => void>(undefined);
  useEffect(() => () => { closed.current?.(); requestAnimationFrame(focusRail); }, []);
  const tabs = useRef<HTMLDivElement>(null);
  // Arrow keys move between sections, as in any tab list.
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = sections.indexOf(section);
    const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: sections.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = sections[(to + sections.length) % sections.length];
    setSection(next);
    tabs.current?.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
  };
  // The chosen tab stays in view on the phone's tab row.
  useEffect(() => { tabs.current?.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [section]);
  // Opening lands on the chosen tab, not on the list around it.
  useEffect(() => void requestAnimationFrame(() => tabs.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus()), []);
  // Closing fades the window into the page behind it (a View Transition); without one, or with reduced motion, it just closes.
  const close = () => {
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
    // The transition's snapshot drops focus to the page; hand it back once the fade is over.
    void document.startViewTransition(() => new Promise<void>(done => { closed.current = done; onClose(); })).finished.then(focusRail);
  };
  const change = (open: boolean) => { if (!open) close(); };
  return (
    <Dialog isOpen onOpenChange={change} width="min(880px, calc(100vw - 16px))" maxHeight="none" padding={0} aria-label="Settings">
      <div className="prefs">
        <div className="prefs-side">
          <Heading level={2} className="prefs-title">Settings</Heading>
          <div ref={tabs} role="tablist" aria-label="Settings sections" aria-orientation="vertical" className="prefs-tabs" onKeyDown={move}>
            {sections.map(s => (
              <button key={s} type="button" role="tab" id={`tab-${s}`} data-section={s} aria-selected={s === section} aria-controls="prefs-panel"
                tabIndex={s === section ? 0 : -1} className="prefs-tab" onClick={() => setSection(s)}>{s}</button>
            ))}
          </div>
        </div>
        <div className="prefs-main">
          <HStack align="center" justify="between" gap={2} className="prefs-head">
            <Heading level={2}>{section}</Heading>
            <Button variant="ghost" label="Close settings" isIconOnly icon={<Icon icon="close" />} onClick={close} />
          </HStack>
          <div key={section} id="prefs-panel" role="tabpanel" aria-labelledby={`tab-${section}`} className="prefs-panel">
            {section === "On your WhatsApp" && <OnYourWhatsApp />}
            {section === "Your work" && <Path persona={persona} onPersona={onPersona} />}
            {section === "Connections" && <Row id="setup-heading" title="Apps and accounts" description="Which accounts Stupid reads, and anything Meta still needs.">
              <Setup state={account} persona={persona} onChange={onAccount} onConnect={onConnect} embedded />
            </Row>}
            {section === "Your agent" && <AgentRules />}
            {section === "AI model" && <AiAccess />}
            {section === "Muse" && <UseFromMuse />}
            {section === "Account" && <YourAccount name={name} onSignedOut={onSignedOut} />}
          </div>
        </div>
      </div>
    </Dialog>
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
    <Row id="agent-heading" title="Drafting and rules" description="When it drafts, and the rules it follows.">
      <Load state={home}>{h => <VStack gap={6}>
        <AgentForm proactive={h.proactive} rules={h.rules} onSaved={saved => home.setData(d => d && { ...d, ...saved })} />
        <YourStyle />
        <Facts facts={h.facts} onChange={facts => home.setData(d => d && { ...d, facts })} />
      </VStack>}</Load>
    </Row>
  );
}

/** How the owner writes, learned from replies they sent, or why there's nothing yet. */
function YourStyle() {
  const state = useLoad("style", api.style);
  const [error, setError] = useState("");
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4}>How you write</Heading>
        <Text as="p" type="supporting" size="sm">Learned from replies you sent, at most once a day. Drafts written this way say so.</Text>
      </VStack>
      <Load state={state}>{s => s.style ? (
        <HStack gap={3} align="start" hAlign="between">
          <VStack gap={1}>
            <Text as="p">{s.style.note}</Text>
            <Text as="p" type="supporting" size="sm">From {s.from} sent {s.from === 1 ? "reply" : "replies"}{s.built && <>, <Timestamp value={s.built} format="relative" /></>}</Text>
          </VStack>
          <Button size="sm" variant="ghost" label="Forget" aria-label="Forget how you write"
            clickAction={() => api.forgetStyle().then(() => { setError(""); return state.reload(); }, (cause: unknown) => setError(message(cause)))} />
        </HStack>
      ) : <Text as="p" type="supporting">{s.message}</Text>}</Load>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
    </VStack>
  );
}

/** What the owner answered once, which the agent now uses instead of asking again. */
function Facts({ facts, onChange }: { facts: Fact[]; onChange: (facts: Fact[]) => void }) {
  const [error, setError] = useState("");
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4}>What you've told it</Heading>
        <Text as="p" type="supporting" size="sm">{facts.length ? "Your answers to its questions. It uses them instead of asking again." : "Nothing yet. When you answer one of its questions, it remembers the answer here."}</Text>
      </VStack>
      {facts.length > 0 && <VStack as="ul" gap={3}>
        {facts.map(f => <HStack as="li" key={f.id} gap={3} align="start" hAlign="between">
          <VStack gap={1}>
            <Text as="p" type="supporting" size="sm">{f.question}</Text>
            <Text as="p">{f.answer}</Text>
            <Text as="p" type="supporting" size="sm">Told <Timestamp value={f.created} format="relative" /></Text>
          </VStack>
          <Button size="sm" variant="ghost" label="Forget" aria-label={`Forget: ${f.answer}`}
            clickAction={() => api.forgetFact(f.id).then(r => { setError(""); onChange(r.facts); }, (cause: unknown) => setError(message(cause)))} />
        </HStack>)}
      </VStack>}
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
    </VStack>
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
          {s.models?.length > 0 && <Models s={s} onSaved={next => ai.setData(next)} />}
          {s.brain === "meta" ? <Text as="p">Agents run on {modelName(s.model)} through Meta's Model API, using Stupid's shared allowance.</Text> : <Text as="p">
            {s.has_key ? `Agents run on ${modelName(s.model)} with your own Baseten API key.`
              : s.workspace_ai ? `Agents run on ${modelName(s.model)} using Stupid's shared allowance. Add your own Baseten API key to run them on your account instead.`
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

/** Every Meta chat model this server can run, one tap to switch. */
function Models({ s, onSaved }: { s: AiSettings; onSaved: (next: AiSettings) => void }) {
  const [error, setError] = useState("");
  const provider = (m: AiModel) => m.provider === "meta" ? "Meta Model API · Stupid's key" : `Baseten · ${s.has_key ? "your key" : "Stupid's key"}`;
  return (
    <VStack gap={2}>
      <RadioList label="Model that runs your agents" value={s.model} containerClassName="model-list"
        onChange={v => void api.setModel(v).then(next => { setError(""); onSaved(next); }, (cause: unknown) => setError(message(cause)))}>
        {s.models.map(m => <RadioListItem key={m.id} value={m.id} label={m.label.split(" · ")[0]} description={provider(m)}
          endContent={m.open_weights ? <Badge label="open weights" /> : undefined} />)}
      </RadioList>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
      <Text as="p" type="supporting" size="sm">All see pictures and use the same tools.</Text>
      {s.meta_brain && <Text as="p" type="supporting" size="sm">Also used: Muse Wonder (videos), Muse Voice Transcribe (voice notes), SAM 3.1 (ad crops).</Text>}
    </VStack>
  );
}

function YourAccount({ name, onSignedOut }: { name: string; onSignedOut: () => void }) {
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
