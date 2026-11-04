import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { api, oauthStartUrl, passed, refetch, sample, sampleSignIn, useLoad } from "./api";
import type { Account, Persona, SetupNext, SetupStep } from "./api";
import { Modal } from "./Surface";
import SourceIcon from "./SourceIcon";
import "./flow.css";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** Meta's words without its error numbers: "(#131042)" or "code 131042" mean nothing to the person. */
// The muted track is the card's own colour, so an empty bar vanished; a faint grey keeps it in view.
const track = { "--color-background-muted": "var(--color-text-disabled)" } as CSSProperties;
const plain = (text: string) => text.replace(/\s*\(?(?:#|(?:error )?code:?\s*)\d{2,}\)?/gi, "").trim();
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
  // The last step passed while the card was up: it stays for one calm "you're set" before it goes.
  const [seen, setSeen] = useState(false);
  if (open && step && !seen) setSeen(true);
  const finished = seen && !open && Boolean(data?.done) && !next.error;
  const shown = open || finished;
  const box = useRef<HTMLDivElement>(null);
  // A new step replaces the old one in the same card: its heading takes focus, as on opening.
  useEffect(() => {
    if (shown) box.current?.closest("dialog, [role=dialog]")?.querySelector<HTMLElement>("h2")?.focus();
  }, [shown, step?.id, finished]);
  useEffect(() => { if (shown) return () => void focusPage(); }, [shown]);
  if (!data || !shown) return null;
  const { done, total } = data.progress;
  return (
    <Modal isOpen onClose={onClose} title={finished ? "You're set" : step ? plain(step.title) : ping ? "Get pinged on your own WhatsApp" : "What do you do on Meta?"} purpose="form">
      <div ref={box} className="flow">
        {data.persona && total > 0 && <Progress done={finished ? total : done} total={total} />}
        <div key={finished ? "finished" : step?.id ?? (ping ? "ping" : "choose")} className="flow-step">
          {finished ? <Finished onClose={onClose} />
            : step ? <Step data={data} step={step} reload={reload} onAccount={onAccount} onConnect={onConnect} onSkip={onClose} />
            : ping ? <Ping onSkip={onClose} /> : <Choose onPersona={onPersona} />}
        </div>
      </div>
    </Modal>
  );
}

const check = <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength="1" /></svg>;

/** One dot per step: passed ones checked, the fill running up to the one you're on. Steps passed while the card is up draw their check. */
function Progress({ done, total }: { done: number; total: number }) {
  // Back from Facebook, the dots start where they were before it and then catch up, so the steps it passed get their check.
  const [before] = useState(() => { const kept = passed.get(); return kept !== null && kept < done ? kept : done; });
  const [shown, setShown] = useState(before);
  useEffect(() => passed.drop(), []);
  useEffect(() => {
    if (shown === done) return;
    const timer = setTimeout(() => setShown(done), shown < done ? 400 : 0);
    return () => clearTimeout(timer);
  }, [done, shown]);
  const at = Math.min(shown, total - 1);
  return (
    <div className="flow-progress">
      <Text type="supporting" size="sm" hasTabularNumbers>{done >= total ? `All ${total} steps done` : `Step ${done + 1} of ${total}`}</Text>
      <div className="flow-dots">
        <div className="flow-track"><ProgressBar value={total > 1 ? (shown >= total ? total - 1 : at) : 1} max={Math.max(total - 1, 1)} label="Setup progress" isLabelHidden style={track} /></div>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} aria-hidden className="flow-dot" data-state={i < shown ? "done" : i === shown ? "now" : "later"} data-fresh={i < shown && i >= before || undefined}>
            {i < shown ? check : i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every step passed in this visit: say so once, then the card goes by itself. */
function Finished({ onClose }: { onClose: () => void }) {
  const latest = useRef(onClose);
  useEffect(() => { latest.current = onClose; });
  useEffect(() => {
    const timer = setTimeout(() => latest.current(), 2000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <VStack gap={5} hAlign="center">
      <span className="flow-finish" aria-hidden><svg viewBox="0 0 28 28" width="56" height="56" fill="none"><path d="m7 14.5 4.5 4.5L21 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" pathLength="1" /></svg></span>
      <Text as="p" justify="center">Your agents work from Home now. Nothing is sent or posted without your tap.</Text>
      <Button variant="primary" size="lg" width="100%" label="Go to Home" onClick={onClose} />
    </VStack>
  );
}

/** Optional: the agent pings the owner on their own WhatsApp. Set up in Settings, where the number and times live. */
function Ping({ onSkip }: { onSkip: () => void }) {
  return (
    <VStack gap={4}>
      <Text as="p">Your agent messages you on your own WhatsApp about big orders, complaints and anything only you can answer, and sends a short summary each evening. Customers still get nothing without your tap.</Text>
      <VStack gap={2}>
        <Button variant="primary" size="lg" width="100%" label="Set it up" href="#settings" />
        <Button variant="ghost" width="100%" label="Skip for now" onClick={onSkip} />
      </VStack>
    </VStack>
  );
}

const choices: { id: Persona; label: string; what: string; apps: string[] }[] = [
  { id: "creator", label: "I create content", what: "Instagram first: Reel scripts, post ideas, comment replies and brand deals.", apps: ["instagram"] },
  { id: "business", label: "I run a business", what: "WhatsApp and your Page first: reply drafts, leads and ad advice.", apps: ["whatsapp", "messenger"] },
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
          <button key={c.id} type="button" className="choice flow-choice" onClick={() => void pick(c.id)}>
            <span className="flow-apps" aria-hidden>{c.apps.map(app => <SourceIcon key={app} source={app} size={20} />)}</span>
            <span className="flow-choice-text">
              <Text weight="semibold">{c.label}</Text>
              <Text type="supporting" size="sm">{c.what}</Text>
            </span>
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
  const fix = step.fix && plain(step.fix);
  return (
    <VStack gap={5}>
      <HStack gap={3} align="center">
        {step.app !== "agent" && <span className="flow-app" aria-hidden><SourceIcon source={step.app} size={20} /></span>}
        <Text as="p">{plain(step.why)}</Text>
      </HStack>
      {step.action === "tell_agent" ? <Facts step={step} creator={data.persona === "creator"} onSaved={reload} onSkip={onSkip} /> : <>
        {fix && <div className="flow-fix"><Text as="p" size="sm" weight="semibold">In Meta</Text><Text as="p" size="sm">{fix}</Text></div>}
        <VStack gap={2}>
          {step.action === "connect"
            ? sample ? <Button variant="primary" size="lg" width="100%" label={sampleSignIn} isDisabled /> : <Button variant="primary" size="lg" width="100%" label={step.button} href={oauthStartUrl} onClick={() => { passed.keep(data.progress.done); onConnect(); }} />
            : <Button variant="primary" size="lg" width="100%" label={step.button} href={step.link} target="_blank" rel="noopener noreferrer" />}
          {step.action === "fix_in_meta" && <Button width="100%" label="I've done it" isLoading={checking} onClick={() => void check()} />}
          {step.optional && <Button variant="ghost" width="100%" label="Skip for now" onClick={onSkip} />}
        </VStack>
        <div aria-live="polite">
          {checking && <Text as="p" type="supporting" size="sm" className="shimmer">Checking with Meta…</Text>}
          {error && <Text as="p" size="sm">{`That didn't go through. ${plain(error)} Try again in a moment.`}</Text>}
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
      <TextArea label="About you" isLabelHidden value={text} onChange={v => { setText(v); setError(""); }} rows={3} maxLength={2000}
        status={error ? { type: "error", message: error } : undefined} description="Your agent uses this when it drafts. Change it any time in Settings." />
      <VStack gap={2}>
        <Button variant="primary" size="lg" width="100%" label={step.button} isDisabled={!text.trim()} clickAction={save} />
        {step.optional && <Button variant="ghost" width="100%" label="Skip for now" onClick={() => { start(); onSkip(); }} />}
      </VStack>
      {creator && <Text as="p" type="supporting" size="sm">Next, Reel director and Post ideas start reading your posts. Their work lands on Home.</Text>}
    </VStack>
  );
}
