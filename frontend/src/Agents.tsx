import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { api, drafts, useLoad } from "./api";
import type { AgentId, AgentRun, AssetKind, Connections } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";

const agents: { id: AgentId; name: string; does: string; needs: AssetKind[] }[] = [
  { id: "leads", name: "Lead finder", does: "Reads your comments and messages, spots people ready to buy, and says what to send them.", needs: ["instagram", "whatsapp", "messenger"] },
  { id: "ideas", name: "Post ideas", does: "Looks at what worked for you lately and drafts posts in your voice.", needs: ["instagram"] },
  { id: "replies", name: "Reply drafts", does: "Drafts answers to new messages. Nothing is sent until you tap send in the Inbox.", needs: ["whatsapp", "messenger", "instagram"] },
  { id: "ads", name: "Ad watcher", does: "Checks your ads and says which to pause, keep, grow or fix, and why.", needs: ["ads"] },
];
const verbs = { pause: "Pause", keep: "Keep", scale: "Grow", fix: "Fix" } as const;

export default function Agents({ state }: { state: Connections }) {
  const list = useLoad("agents", api.agents);
  const running = list.data?.runs.some(r => r.status === "running");
  const { reload } = list;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [running, reload]);

  const on = (kinds: AssetKind[]) => state.assets.some(a => kinds.includes(a.kind) && state.selected.includes(a.key));
  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={1}>Agents</Heading>
        <Text as="p" type="supporting">They prepare the work in the background. Nothing is sent or changed until you tap.</Text>
      </VStack>
      <Load state={list}>{data => (
        <VStack gap={4}>
          {!data.ai_ready && <Banner status="info" title="Agents need AI access" description="Add an AI key in Settings to start running agents." endContent={<Button size="sm" label="Open Settings" href="#settings" />} />}
          <Grid columns={{ minWidth: 300 }} gap={4}>
            {agents.map(agent => (
              <Agent key={agent.id} agent={agent} run={data.runs.find(r => r.agent === agent.id)} ready={data.ai_ready} connected={on(agent.needs)}
                onStarted={() => list.setData(d => d && { ...d, runs: [...d.runs.filter(r => r.agent !== agent.id), { agent: agent.id, status: "running", result: null, error: null, cost_usd: null, created: Date.now() / 1000, finished: null }] })} />
            ))}
          </Grid>
          {data.model && <Text as="p" type="supporting">Agents run on {data.model}{data.own_key ? " with your own key" : ""}.</Text>}
        </VStack>
      )}</Load>
    </VStack>
  );
}

function Agent({ agent, run, ready, connected, onStarted }: { agent: (typeof agents)[number]; run?: AgentRun; ready: boolean; connected: boolean; onStarted: () => void }) {
  const [error, setError] = useState("");
  const start = async () => {
    try {
      await api.run(agent.id);
      setError("");
      onStarted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const running = run?.status === "running";
  return (
    <Card variant="muted">
      <VStack gap={4}>
        <HStack gap={3} align="center"><SourceIcon source={agent.needs[0]} /><Heading level={2}>{agent.name}</Heading></HStack>
        <Text as="p" type="supporting">{agent.does}</Text>
        {connected
          ? <Button variant="primary" label={running ? "Working…" : run ? "Run again" : "Run"} isLoading={running} isDisabled={!ready} clickAction={start} />
          : <Button label="Connect an app first" href="#connections" />}
        <div aria-live="polite">
          {error && <Text as="p" color="secondary">{error}</Text>}
          {running && <Text as="p" type="supporting">Working on it. This usually takes under a minute.</Text>}
          {run?.status === "failed" && <Text as="p" type="supporting">This run didn't finish: {run.error ?? "no reason given"}</Text>}
        </div>
        {run?.status === "done" && run.result && <Result result={run.result} />}
        {run?.finished && (
          <Text as="p" type="supporting" size="xsm">
            Finished <Timestamp value={run.finished} format="relative" />{run.cost_usd != null && ` · cost $${run.cost_usd.toFixed(3)}`}
          </Text>
        )}
      </VStack>
    </Card>
  );
}

function Result({ result }: { result: NonNullable<AgentRun["result"]> }) {
  if ("empty" in result) return <Text as="p">Nothing new to look at yet. Try again after more activity.</Text>;
  if ("leads" in result) return (
    <VStack gap={4} as="ul">
      {result.leads.map((l, i) => (
        <VStack key={i} as="li" gap={1}>
          <Text weight="semibold">{l.who} <Text type="supporting">on {l.channel}</Text></Text>
          <Text as="p">“{l.said}”</Text>
          <Text as="p" type="supporting">{l.why}</Text>
          <Text as="p"><strong>Next:</strong> {l.next_step}</Text>
          <Link href="#inbox">Open their messages</Link>
        </VStack>
      ))}
    </VStack>
  );
  if ("ideas" in result) return (
    <VStack gap={4} as="ul">
      {result.ideas.map((idea, i) => (
        <VStack key={i} as="li" gap={1}>
          <HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{idea.hook}</Text><Token size="sm" label={idea.format} /></HStack>
          <Text as="p">{idea.caption}</Text>
          <Text as="p" type="supporting">{idea.why}</Text>
          <Copy text={idea.caption} />
        </VStack>
      ))}
    </VStack>
  );
  if ("replies" in result) return (
    <VStack gap={4} as="ul">
      {result.replies.map(r => (
        <VStack key={r.event_id} as="li" gap={1}>
          <Text weight="semibold">To {r.to}</Text>
          <Text as="p">{r.draft}</Text>
          <Button size="sm" label="Use this reply" href="#inbox" onClick={() => drafts.set(r.event_id, r.draft)} />
        </VStack>
      ))}
    </VStack>
  );
  return (
    <VStack gap={3}>
      <Text as="p">{result.summary}</Text>
      <VStack gap={3} as="ul">
        {result.actions.map((a, i) => (
          <VStack key={i} as="li" gap={1}>
            <Text><strong>{verbs[a.do]}</strong> {a.campaign}</Text>
            <Text as="p" type="supporting">{a.why}</Text>
          </VStack>
        ))}
      </VStack>
      <Text as="p" type="supporting">Change your ads in Meta Ads Manager. Secnd doesn't edit them.</Text>
    </VStack>
  );
}

function Copy({ text }: { text: string }) {
  const [label, setLabel] = useState("Copy caption");
  return <Button size="sm" label={label} clickAction={() => navigator.clipboard.writeText(text).then(() => setLabel("Copied"), () => setLabel("Couldn't copy"))} />;
}
