import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { api, apps, appStatus, oauthStartUrl, sample, sampleSignIn, setupDone } from "./api";
import type { Account, AssetKind, Persona } from "./api";
import { Modal, Page, Tile } from "./Surface";
import MetaProblem from "./MetaProblem";

const Tutorial = lazy(() => import("./Tutorial"));

const labels = { ready: ["Ready", "green"], step: ["Needs one step", "yellow"], off: ["Not connected", "default"] } as const;
const phase = (state: Account, kind: AssetKind) => {
  const { status, on } = appStatus(state, kind);
  return !state.assets.some(a => a.kind === kind) ? 0 : !on.length ? 1 : status === "step" ? 2 : 3;
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function Setup({ state, onChange, onConnect, embedded, persona }: {
  state: Account; onChange: (next: Account) => void; onConnect: () => void; embedded?: boolean; persona?: Persona | null;
}) {
  // A business sees its WhatsApp and Page first, as in onboarding.
  const shown = persona === "business" ? [...apps].sort((a, b) => Number(b.kind === "whatsapp" || b.kind === "messenger") - Number(a.kind === "whatsapp" || a.kind === "messenger")) : apps;
  const [error, setError] = useState("");
  const checking = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState<AssetKind>();
  const done = setupDone(state);
  const apply = (next: Account) => {
    const update = () => onChange(next);
    if (open && phase(state, open) !== phase({ ...state, ...next }, open)
      && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      void document.startViewTransition(() => flushSync(update)).finished.catch(() => {});
    } else update();
  };
  const check = async () => {
    if (checking.current) return;
    checking.current = true;
    setWaiting(true);
    try {
      apply(await api.refresh());
      setError("");
      setChecked(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      checking.current = false;
      setWaiting(false);
    }
  };
  const toggle = async (key: string, on: boolean) => {
    try {
      apply(await api.select(on ? [...state.selected, key] : state.selected.filter(k => k !== key)));
      setError("");
    } catch (cause) {
      setError(message(cause));
    }
  };
  // People fix things in Meta's tabs; look again when they come back, until everything is ready.
  useEffect(() => {
    if (done && !open) return;
    const onFocus = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  });
  const connect = sample ? <Button variant="primary" label={sampleSignIn} isDisabled />
    : <Button variant="primary" label="Connect again" href={oauthStartUrl} onClick={onConnect} />;
  const app = apps.find(a => a.kind === open);
  const checkStatus = <div aria-live="polite">
    {error && <Banner status="warning" title="That didn't go through" description={`${error} Try again in a moment.`} />}
    {waiting && <Text as="p" type="supporting">Checking what Meta has shared…</Text>}
    {!waiting && checked && !error && !done && <Text as="p" type="supporting">Checked just now. Meta can take a minute to catch up. Your progress stays here while it does.</Text>}
  </div>;

  // Inside Settings > Connections the same cards show without the page's title.
  const frame = (children: ReactNode) => embedded ? <VStack gap={4}>{children}</VStack> : (
    <Page title={done ? "You're set" : "Set up Stupid"}
      description={done ? "New messages arrive in your inbox as they come in." : "One step at a time. Open a card to see what to do next."}
      actions={done && <Button variant="primary" label="Go to Inbox" href="#inbox" />}>{children}</Page>
  );
  return frame(<>
      {!open && checkStatus}
      {state.problems?.map(problem => (
        <VStack key={problem} gap={2}>
          <MetaProblem issue={problem} />
          <Text as="p" type="supporting" size="sm">{problem}</Text>
          <div>{connect}</div>
        </VStack>
      ))}
      <div className="bento">
        {shown.map(app => {
          const { status, on, refused } = appStatus(state, app.kind);
          const accounts = state.assets.filter(a => a.kind === app.kind);
          const [label, color] = labels[status];
          const steps = on.flatMap(a => a.issues?.filter(i => i.blocking) ?? []).length + (refused.length ? 1 : 0);
          return (
            <Tile key={app.kind} icon={app.kind} title={app.name} status={<Token size="sm" label={label} color={color} />}
              actions={<Button size="sm" variant={status === "ready" ? "ghost" : "primary"} label={!accounts.length ? "Connect" : status === "step" ? "Fix" : status === "off" ? "Choose" : "Manage"}
                aria-label={`${!accounts.length ? "Connect" : "Manage"} ${app.name}`} onClick={() => setOpen(app.kind)} />}>
              <VStack gap={1}>
                <Text as="p" maxLines={1}>{!accounts.length ? app.why : on.length ? on.map(a => a.name).join(", ") : "Switch on the account you use."}</Text>
                <Text as="p" type="supporting" size="sm">
                  {!accounts.length ? "Not shared with Stupid yet." : steps ? `${steps === 1 ? "One thing" : `${steps} things`} to fix in Meta.` : `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} shared.`}
                </Text>
              </VStack>
            </Tile>
          );
        })}
      </div>
      {app && (() => {
        const { on, refused } = appStatus(state, app.kind);
        const accounts = state.assets.filter(a => a.kind === app.kind);
        const step = phase(state, app.kind);
        const close = () => setOpen(undefined);
        return (
          <Modal isOpen onClose={close} title={`Connect ${app.name}`} width={620}
            footer={step === 0 ? <>
              <Button variant="ghost" label="Cancel" onClick={close} />
              <Button label="Check again" isLoading={waiting} onClick={() => void check()} />
              {sample ? <Button variant="primary" label={sampleSignIn} isDisabled />
                : <Button variant="primary" label="Continue with Facebook" href={oauthStartUrl} onClick={onConnect} />}
            </> : <>
              <Button label="Check again" isLoading={waiting} onClick={() => void check()} />
              <Button variant="primary" label={step === 3 ? "Done" : "Close"} onClick={close} />
            </>}>
            {checkStatus}
            <ProgressBar value={step} max={3} label={`${app.name} setup progress`} isLabelHidden />
            <Completion ready={step === 3} name={app.name} />
            <Stepper activeStep={step} label={`${app.name} setup`} density="compact">
              <Step step={0} label="Connect" />
              <Step step={1} label="Choose" />
              <Step step={2} label="Fix in Meta" />
            </Stepper>
            <div key={`${app.kind}-${step}`} className="tutorial-step" data-phase={step}>
            {step === 0 ? (
              <Suspense fallback={<Text as="p" role="status">Opening the steps…</Text>}><Tutorial kind={app.kind} /></Suspense>
            ) : (
              <VStack gap={3}>
                {!on.length && <Text as="p">Switch on the account you use. Only the accounts you choose are used in Stupid.</Text>}
                <details>
                  <summary>Review the setup steps</summary>
                  <Suspense fallback={<Text as="p">Opening the steps…</Text>}><Tutorial kind={app.kind} /></Suspense>
                </details>
                {accounts.map(a => (
                  <VStack key={a.key} gap={3}>
                    
                    <Switch label={a.name} labelPosition="start" labelSpacing="spread" width="100%"
                      value={state.selected.includes(a.key)} changeAction={next => toggle(a.key, next)} />
                    {state.selected.includes(a.key) && a.issues?.map(issue => <MetaProblem key={issue.text} issue={issue} />)}
                  </VStack>
                ))}
                {refused.length > 0 && (
                  <Banner status="warning" title={`Meta wasn't allowed to share ${refused.join(", ")}.`} description={`Connect again and allow ${refused.length > 1 ? "them" : "it"}. In Facebook Business Integrations → Stupid → View and Edit, tick the missing access and Save.`} endContent={connect} />
                )}
              </VStack>
            )}
            </div>
          </Modal>
        );
      })()}
  </>);
}

function Completion({ ready, name }: { ready: boolean; name: string }) {
  const [wasReady] = useState(ready);
  if (!ready) return null;
  return <HStack gap={2} align="center" className={wasReady ? "tutorial-complete" : "tutorial-complete tutorial-just-completed"} role="status">
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="14" fill="currentColor" opacity=".12" />
      <path d="m7 14 5 5 9-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" pathLength="1" />
    </svg>
    <Text as="p">{name} is ready.</Text>
  </HStack>;
}

