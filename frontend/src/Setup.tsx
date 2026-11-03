import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { api, apps, appStatus, oauthStartUrl, setupDone } from "./api";
import type { Account, AssetKind, Issue } from "./api";
import { Modal, Page, Tile } from "./Surface";

const labels = { ready: ["Ready", "green"], step: ["Needs one step", "yellow"], off: ["Not connected", "default"] } as const;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function Setup({ state, onChange, onConnect }: { state: Account; onChange: (next: Account) => void; onConnect: () => void }) {
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState<AssetKind>();
  const done = setupDone(state);
  const check = async () => {
    try {
      onChange(await api.refresh());
      setError("");
      setChecked(true);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const toggle = async (key: string, on: boolean) => {
    try {
      onChange(await api.select(on ? [...state.selected, key] : state.selected.filter(k => k !== key)));
      setError("");
    } catch (cause) {
      setError(message(cause));
    }
  };
  // People fix things in Meta's tabs; look again when they come back, until everything is ready.
  useEffect(() => {
    if (done) return;
    const onFocus = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  });
  const connect = <Button variant="primary" label="Connect again" href={oauthStartUrl} onClick={onConnect} />;
  const app = apps.find(a => a.kind === open);

  return (
    <Page title={done ? "You're set" : "Set up Stupid"}
      description={done ? "New messages arrive in your inbox as they come in." : "One step at a time. Open a card to see what to do next."}
      actions={done && <Button variant="primary" label="Go to Inbox" href="#inbox" />}>
      <div aria-live="polite">
        {error && <Banner status="warning" title="That didn't go through" description={`${error} Try again in a moment.`} />}
        {checked && !error && !done && <Text as="p" type="supporting">Checked just now. Meta can take a minute to catch up.</Text>}
      </div>
      {state.problems?.map(problem => (
        <Banner key={problem} status="warning" title="Meta didn't share everything" description={problem} endContent={connect} />
      ))}
      <div className="bento">
        {apps.map(app => {
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
        const { status, on, refused } = appStatus(state, app.kind);
        const accounts = state.assets.filter(a => a.kind === app.kind);
        const fixable = on.some(a => a.issues?.length);
        const step = !accounts.length ? 0 : !on.length ? 1 : status === "step" ? 2 : 3;
        const close = () => setOpen(undefined);
        return (
          <Modal isOpen onClose={close} title={`Connect ${app.name}`} width={620}
            footer={step === 0 ? <>
              <Button variant="ghost" label="Cancel" onClick={close} />
              <Button variant="primary" label="Continue with Facebook" href={oauthStartUrl} onClick={onConnect} />
            </> : <>
              {fixable && <Button label="Check again" clickAction={check} />}
              <Button variant="primary" label={step === 3 ? "Done" : "Close"} onClick={close} />
            </>}>
            <Stepper activeStep={step} label={`${app.name} setup`} density="compact">
              <Step step={0} label="Connect" />
              <Step step={1} label="Choose" />
              <Step step={2} label="Fix in Meta" />
            </Stepper>
            {step === 0 ? (
              <VStack gap={3}>
                <Text as="p">{app.why}</Text>
                <ol className="steps">
                  <li>Continue with Facebook. Meta opens its own window.</li>
                  <li>{app.pick}</li>
                  <li>Come back here and switch it on.</li>
                </ol>
                {app.kind === "instagram" && (
                  <Text as="p" type="supporting" size="sm">
                    Instagram must be a Professional account linked to your Facebook Page.{" "}
                    <Link hasUnderline isExternalLink href="https://help.instagram.com/502981923235522">How to switch</Link>
                  </Text>
                )}
              </VStack>
            ) : (
              <VStack gap={3}>
                {!on.length && <Text as="p">Switch on the account you use.</Text>}
                {accounts.map(a => (
                  <VStack key={a.key} gap={3}>
                    
                    <Switch label={a.name} labelPosition="start" labelSpacing="spread" width="100%"
                      value={state.selected.includes(a.key)} changeAction={next => toggle(a.key, next)} />
                    {state.selected.includes(a.key) && a.issues?.map(issue => <Problem key={issue.text} issue={issue} />)}
                  </VStack>
                ))}
                {refused.length > 0 && (
                  <Banner status="warning" title={`Meta wasn't allowed to share ${refused.join(", ")}.`} description={`Connect again and allow ${refused.length > 1 ? "them" : "it"}.`} endContent={connect} />
                )}
                {step === 3 && <Text as="p" type="supporting">{app.name} is ready.</Text>}
              </VStack>
            )}
          </Modal>
        );
      })()}
    </Page>
  );
}

function Problem({ issue }: { issue: Issue }) {
  const open = issue.link && <Button size="sm" variant={issue.blocking ? "primary" : "ghost"} label="Open in Meta" href={issue.link} target="_blank" rel="noopener noreferrer" />;
  if (issue.blocking) return <Banner status="warning" title={issue.text} description={issue.fix} endContent={open} />;
  return (
    <HStack gap={2} align="center" justify="between" wrap="wrap">
      <Text as="p" type="supporting" size="sm">{issue.text} {issue.fix}</Text>
      {open}
    </HStack>
  );
}
