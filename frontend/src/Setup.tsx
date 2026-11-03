import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { api, apps, appStatus, oauthStartUrl, setupDone } from "./api";
import type { Account, Issue } from "./api";
import SourceIcon from "./SourceIcon";

const labels = { ready: ["Ready", "green"], step: ["Needs one step", "yellow"], off: ["Not connected", "default"] } as const;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function Setup({ state, onChange, onConnect }: { state: Account; onChange: (next: Account) => void; onConnect: () => void }) {
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
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

  return (
    <VStack gap={6}>
      <VStack gap={3}>
        <Heading level={1}>{done ? "You're set" : "Set up Secnd"}</Heading>
        <Text as="p" type="supporting">{done ? "New messages arrive in your inbox as they come in." : "One step at a time. Each card says what to do next."}</Text>
        {done && <HStack><Button variant="primary" label="Go to Inbox" href="#inbox" /></HStack>}
        <div aria-live="polite">
          {error && <Banner status="warning" title="That didn't go through" description={`${error} Try again in a moment.`} />}
          {checked && !error && !done && <Text as="p" type="supporting">Checked just now. Meta can take a minute to catch up.</Text>}
        </div>
      </VStack>
      {state.problems?.map(problem => (
        <Card key={problem} variant="muted">
          <VStack gap={3} hAlign="start">
            <Text as="p">Meta didn't share this when you signed in: {problem}</Text>
            {connect}
          </VStack>
        </Card>
      ))}
      <Grid columns={{ minWidth: 280 }} gap={4}>
        {apps.map(app => {
          const { status, on, refused } = appStatus(state, app.kind);
          const accounts = state.assets.filter(a => a.kind === app.kind);
          const [label, color] = labels[status];
          const fixable = on.some(a => a.issues?.length);
          return (
            <Card key={app.kind} variant="muted" height="100%">
              <VStack gap={4}>
                <HStack gap={3} align="center" wrap="wrap">
                  <SourceIcon source={app.kind} />
                  <Heading level={2}>{app.name}</Heading>
                  <Token size="sm" label={label} color={color} />
                </HStack>
                {!accounts.length ? (
                  <VStack gap={3} hAlign="start">
                    <Text as="p">{app.why}</Text>
                    <Button variant="primary" label={`Connect ${app.name}`} href={oauthStartUrl} onClick={onConnect} />
                    <Text as="p" type="supporting">{app.pick}</Text>
                    {app.kind === "instagram" && (
                      <Text as="p" type="supporting">
                        Instagram must be a Professional account linked to your Facebook Page.{" "}
                        <Link hasUnderline isExternalLink href="https://help.instagram.com/502981923235522">How to switch</Link>
                      </Text>
                    )}
                  </VStack>
                ) : (
                  <VStack gap={3}>
                    {!on.length && <Text as="p">Switch on the account you use.</Text>}
                    {accounts.map(a => (
                      <VStack key={a.key} gap={2}>
                        <Switch label={a.name} labelPosition="start" labelSpacing="spread" width="100%"
                          value={state.selected.includes(a.key)} changeAction={next => toggle(a.key, next)} />
                        {state.selected.includes(a.key) && a.issues?.map(issue => <Problem key={issue.text} issue={issue} />)}
                      </VStack>
                    ))}
                    {refused.length > 0 && (
                      <VStack gap={2} hAlign="start">
                        <Text as="p">Meta wasn't allowed to share {refused.join(", ")}. Connect again and allow {refused.length > 1 ? "them" : "it"}.</Text>
                        {connect}
                      </VStack>
                    )}
                    {fixable && <HStack><Button label="Check again" clickAction={check} /></HStack>}
                  </VStack>
                )}
              </VStack>
            </Card>
          );
        })}
      </Grid>
    </VStack>
  );
}

function Problem({ issue }: { issue: Issue }) {
  const open = issue.link && <Button size="sm" variant={issue.blocking ? "primary" : "ghost"} label="Open in Meta" href={issue.link} target="_blank" rel="noopener noreferrer" />;
  if (issue.blocking) return <Banner status="warning" title={issue.text} description={issue.fix} endContent={open} />;
  return (
    <VStack gap={1} hAlign="start">
      <Text as="p" type="supporting">{issue.text} {issue.fix}</Text>
      {open}
    </VStack>
  );
}
