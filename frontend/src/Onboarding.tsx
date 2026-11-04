import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { api, oauthStartUrl, refetch, sample, sampleSignIn, useLoad } from "./api";
import type { Account, Persona, SetupNext, SetupStep } from "./api";
import { Modal } from "./Surface";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
// The muted track is the card's own colour, so an empty bar vanished; a faint grey keeps it in view.
const track = { "--color-background-muted": "var(--color-text-disabled)" } as CSSProperties;
/** When the card closes and focus fell to the page itself (nothing opened the card), start at the page heading. */
const focusPage = () => requestAnimationFrame(() => requestAnimationFrame(() => {
  if (document.activeElement === document.body || !document.activeElement) document.querySelector<HTMLElement>("main h1, h1")?.focus();
}));

/**
 * Onboarding is one card over Home: the single next step from GET /api/setup/next, the same for both paths.
 * It closes by itself once the server has no step left.
 */
export default function Onboarding({ persona, onPersona, onAccount, onConnect, onClose }: {
  persona: Persona | null; onPersona: (persona: Persona) => Promise<void>; onAccount: (next: Account) => void;
  onConnect: () => void; onClose: () => void;
}) {
  const next = useLoad("setup-next", api.setupNext);
  const { reload } = next;
  // A path chosen elsewhere (the door, Settings) changes the steps.
  useEffect(() => { void reload(); }, [persona, reload]);
  const data = next.data;
  const step = data?.persona ? data.step : undefined;
  // After the server's steps, one optional step of our own: pings on the owner's own WhatsApp, once there's a number to link.
  const owner = useLoad("owner-channel", api.ownerChannel).data;
  const ping = Boolean(data?.persona && !step && owner?.business_number && !owner.linked);
  // Closes when no step is left; done with only an optional step still offers it, with Skip for now.
  const open = Boolean(data && !next.error && (!data.persona || step || ping));
  const box = useRef<HTMLDivElement>(null);
  // A new step replaces the old one in the same card: its heading takes focus, as on opening.
  useEffect(() => {
    if (open) box.current?.closest("dialog, [role=dialog]")?.querySelector<HTMLElement>("h2")?.focus();
  }, [open, step?.id]);
  useEffect(() => { if (open) return () => void focusPage(); }, [open]);
  if (!data || !open) return null;
  return (
    <Modal isOpen onClose={onClose} title={step?.title ?? (ping ? "Get pinged on your own WhatsApp" : "What do you do on Meta?")} purpose="form">
      <div ref={box}>
        {step ? <Step data={data} step={step} reload={reload} onAccount={onAccount} onConnect={onConnect} onSkip={onClose} />
          : ping ? <Ping onSkip={onClose} /> : <Choose onPersona={onPersona} />}
      </div>
    </Modal>
  );
}

/** Optional: the agent pings the owner on their own WhatsApp. Set up in Settings, where the number and times live. */
function Ping({ onSkip }: { onSkip: () => void }) {
  return (
    <VStack gap={4}>
      <Text as="p">Your agent messages you on your own WhatsApp about big orders, complaints and anything only you can answer, and sends a short summary each evening. Customers still get nothing without your tap.</Text>
      <HStack gap={2} wrap="wrap">
        <Button variant="primary" label="Set it up" href="#settings" />
        <Button variant="ghost" label="Skip for now" onClick={onSkip} />
      </HStack>
    </VStack>
  );
}

const choices: { id: Persona; label: string; what: string }[] = [
  { id: "creator", label: "I create content", what: "Instagram first: Reel scripts, post ideas, comment replies and brand deals." },
  { id: "business", label: "I run a business", what: "WhatsApp and your Page first: reply drafts, leads and ad advice." },
];

/** Signed in without picking a door: ask once. */
function Choose({ onPersona }: { onPersona: (persona: Persona) => Promise<void> }) {
  const [error, setError] = useState("");
  const pick = (persona: Persona) => onPersona(persona).catch((cause: unknown) => setError(message(cause)));
  return (
    <VStack gap={4}>
      <Text as="p" type="supporting">Stupid sets up the apps and the agents for your kind of work. You can change this in Settings.</Text>
      <VStack gap={2}>
        {choices.map(c => (
          <button key={c.id} type="button" className="choice" onClick={() => void pick(c.id)}>
            <Text weight="semibold">{c.label}</Text>
            <Text type="supporting" size="sm">{c.what}</Text>
          </button>
        ))}
      </VStack>
      <div aria-live="polite">{error && <Text as="p">{error}</Text>}</div>
    </VStack>
  );
}

function Step({ data, step, reload, onAccount, onConnect, onSkip }: {
  data: SetupNext; step: SetupStep; reload: () => Promise<void>; onAccount: (next: Account) => void; onConnect: () => void; onSkip: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  // Back from Meta's tab: ask Meta again, then read the next step.
  const check = async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try { onAccount(await api.refresh()); setError(""); } catch (cause) { setError(message(cause)); }
    await reload();
    busy.current = false;
    setChecking(false);
  };
  useEffect(() => {
    if (step.action !== "fix_in_meta") return;
    const back = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  });
  const { done, total } = data.progress;
  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <Text type="supporting" size="sm" hasTabularNumbers>Step {Math.min(done + 1, total)} of {total}</Text>
        <ProgressBar value={done} max={total} label="Setup progress" isLabelHidden style={track} />
      </VStack>
      <Text as="p">{step.why}</Text>
      {step.action === "tell_agent" ? <Facts step={step} creator={data.persona === "creator"} onSaved={reload} onSkip={onSkip} /> : <>
        {step.fix && <Text as="p" type="supporting">{step.fix}</Text>}
        <HStack gap={2} wrap="wrap">
          {step.action === "connect"
            ? sample ? <Button variant="primary" label={sampleSignIn} isDisabled /> : <Button variant="primary" label={step.button} href={oauthStartUrl} onClick={onConnect} />
            : <Button variant="primary" label={step.button} href={step.link} target="_blank" rel="noopener noreferrer" />}
          {step.action === "fix_in_meta" && <Button label="I've done it" isLoading={checking} onClick={() => void check()} />}
          {step.optional && <Button variant="ghost" label="Skip for now" onClick={onSkip} />}
        </HStack>
        <div aria-live="polite">
          {checking && <Text as="p" type="supporting">Checking with Meta…</Text>}
          {error && <Text as="p">{`That didn't go through. ${error} Try again in a moment.`}</Text>}
        </div>
      </>}
    </VStack>
  );
}

/** A sentence or two for the agent's rules. Saving keeps the drafting switch as it is; Home and Settings read the new rules. */
function Facts({ step, creator, onSaved, onSkip }: { step: SetupStep; creator: boolean; onSaved: () => Promise<void>; onSkip: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  // A creator's last step: Reel director and Post ideas start on their real posts, so Home has work on it.
  const start = () => {
    if (!creator || sample) return;
    void Promise.allSettled([api.run("reels"), api.run("ideas")]).then(() => refetch("agents"));
  };
  const save = async () => {
    try {
      const home = await api.agent();
      await api.agentSettings(home.proactive, text.trim());
      refetch("agent");
      start();
      await onSaved();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <VStack gap={4}>
      <TextArea label="About you" isLabelHidden value={text} placeholder={creator ? "What you post about, who watches, and which brand deals you take or turn down." : "Your prices, opening hours and where you deliver."} onChange={v => { setText(v); setError(""); }} rows={3} maxLength={2000}
        status={error ? { type: "error", message: error } : undefined} description="Your agent uses this when it drafts. Change it any time in Settings." />
      <HStack gap={2} wrap="wrap">
        <Button variant="primary" label={step.button} isDisabled={!text.trim()} clickAction={save} />
        {step.optional && <Button variant="ghost" label="Skip for now" onClick={() => { start(); onSkip(); }} />}
      </HStack>
      {creator && <Text as="p" type="supporting" size="sm">Next, Reel director and Post ideas start reading your posts. Their work lands on Home.</Text>}
    </VStack>
  );
}
