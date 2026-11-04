import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { api, factsPrompt, oauthStartUrl, useLoad } from "./api";
import type { Account, Persona, SetupNext, SetupStep } from "./api";
import { Modal } from "./Surface";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

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
  // Closes when no step is left; done with only an optional step still offers it, with Skip for now.
  if (!data || next.error) return null;
  const step = data.persona ? data.step : undefined;
  if (data.persona && !step) return null;
  return (
    <Modal isOpen onClose={onClose} title={step?.title ?? "What do you do on Meta?"} purpose="form">
      {step ? <Step data={data} step={step} reload={reload} onAccount={onAccount} onConnect={onConnect} onSkip={onClose} />
        : <Choose onPersona={onPersona} />}
    </Modal>
  );
}

/** Signed in without picking a door: ask once. */
function Choose({ onPersona }: { onPersona: (persona: Persona) => Promise<void> }) {
  const [error, setError] = useState("");
  const pick = (persona: Persona) => onPersona(persona).catch((cause: unknown) => setError(message(cause)));
  return (
    <VStack gap={4}>
      <Text as="p" type="supporting">Stupid sets up the apps and the agents for your kind of work. You can change this in Settings.</Text>
      <VStack gap={2}>
        <Button size="lg" variant="primary" label="I create content" clickAction={() => pick("creator")} />
        <Button size="lg" variant="primary" label="I run a business" clickAction={() => pick("business")} />
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
        <ProgressBar value={done} max={total} label="Setup progress" isLabelHidden />
      </VStack>
      <Text as="p">{step.why}</Text>
      {step.action === "tell_agent" ? <Facts step={step} hint={data.persona ? factsPrompt[data.persona] : step.why} onSaved={reload} onSkip={onSkip} /> : <>
        {step.fix && <Text as="p" type="supporting">{step.fix}</Text>}
        <HStack gap={2} wrap="wrap">
          {step.action === "connect"
            ? <Button variant="primary" label={step.button} href={oauthStartUrl} onClick={onConnect} />
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

/** A sentence or two for the agent's rules. Saving keeps the drafting switch as it is. */
function Facts({ step, hint, onSaved, onSkip }: { step: SetupStep; hint: string; onSaved: () => Promise<void>; onSkip: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      const home = await api.agent();
      await api.agentSettings(home.proactive, text.trim());
      await onSaved();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <VStack gap={4}>
      <TextArea label="About you" isLabelHidden value={text} onChange={v => { setText(v); setError(""); }} rows={3} maxLength={2000}
        placeholder={hint} status={error ? { type: "error", message: error } : undefined} description="Your agent uses this when it drafts. Change it any time in Settings." />
      <HStack gap={2} wrap="wrap">
        <Button variant="primary" label={step.button} isDisabled={!text.trim()} clickAction={save} />
        {step.optional && <Button variant="ghost" label="Skip for now" onClick={onSkip} />}
      </HStack>
    </VStack>
  );
}
