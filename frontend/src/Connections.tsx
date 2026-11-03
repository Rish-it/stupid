import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { api, apps, oauthStartUrl } from "./api";
import type { Connections as State } from "./api";
import SourceIcon from "./SourceIcon";

export default function Connections({ state, onChange }: { state: State; onChange: (next: State) => void }) {
  const [error, setError] = useState("");
  const toggle = async (key: string, on: boolean) => {
    try {
      onChange(await api.select(on ? [...state.selected, key] : state.selected.filter(k => k !== key)));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={1}>Connections</Heading>
        <Text as="p" type="supporting">Connect one app at a time. Switch an account off and Secnd stops reading it.</Text>
      </VStack>
      {error && <Banner status="error" title="That change didn't save" description={error} />}
      <Grid columns={{ minWidth: 280 }} gap={4}>
        {apps.map(app => {
          const accounts = state.assets.filter(a => a.kind === app.kind);
          return (
            <Card key={app.kind} variant="muted">
              <VStack gap={4}>
                <HStack gap={3} align="center">
                  <SourceIcon source={app.kind} />
                  <Heading level={2}>{app.name}</Heading>
                </HStack>
                <Text as="p" type="supporting">{app.does}</Text>
                {accounts.length > 0 && (
                  <VStack gap={2}>
                    {accounts.map(a => (
                      <Switch key={a.key} label={a.name} labelPosition="start" labelSpacing="spread" width="100%"
                        value={state.selected.includes(a.key)} changeAction={on => toggle(a.key, on)} />
                    ))}
                  </VStack>
                )}
                <Button href={oauthStartUrl} variant={accounts.length ? "ghost" : "primary"}
                  label={accounts.length ? `Add another ${app.name} account` : `Connect ${app.name}`} />
              </VStack>
            </Card>
          );
        })}
      </Grid>
    </VStack>
  );
}
