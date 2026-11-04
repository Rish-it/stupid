import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { Heading } from "@astryxdesign/core/Heading";
import { api, drafts, jobNames, lastReport, senderName, useLoad } from "./api";
import type { AgentId, AgentResult, AgentRun, AssetKind, Connections, ReelScript, Ticket } from "./api";
import { ReportMark } from "./Attention";
import { Load } from "./Load";
import { Modal, Page, Tile } from "./Surface";

const agents: { id: AgentId; name: string; does: string; needs: AssetKind[] }[] = [
  { id: "leads", name: "Lead finder", does: "Reads your comments and messages, spots people ready to buy, and says what to send them.", needs: ["instagram", "whatsapp", "messenger"] },
  { id: "ideas", name: "Post ideas", does: "Looks at what worked for you lately and drafts posts in your voice.", needs: ["instagram"] },
  { id: "reels", name: "Reel director", does: "Muse Wonder watches your best Reels, says what works and where people may stop watching, and writes three new scripts with shot lists.", needs: ["instagram"] },
  { id: "replies", name: "Reply drafts", does: "Drafts answers to new messages. Nothing is sent until you tap send in the Inbox.", needs: ["whatsapp", "messenger", "instagram"] },
  { id: "ads", name: "Ad watcher", does: "Checks your ads and says which to pause, keep, grow or fix, and why.", needs: ["ads"] },
];
const verbs = { pause: "Pause", keep: "Keep", scale: "Grow", fix: "Fix" } as const;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line for the tile: what the last run found. */
function found(result: AgentResult) {
  if ("empty" in result) return "Nothing new to look at yet.";
  if ("leads" in result) return result.leads.length ? `Found ${plural(result.leads.length, "lead", "leads")}.` : "No one ready to buy yet.";
  if ("ideas" in result) return `Drafted ${plural(result.ideas.length, "post idea", "post ideas")}.`;
  if ("replies" in result) return `Drafted ${plural(result.replies.length, "reply", "replies")}.`;
  if ("scripts" in result) return result.from_captions_only
    ? `Wrote ${plural(result.scripts.length, "Reel script", "Reel scripts")} from your captions. No Reels to watch yet.`
    : `Watched ${plural(result.watched.length, "Reel", "Reels")} and wrote ${plural(result.scripts.length, "script", "scripts")}.`;
  return result.summary;
}

export default function Agents({ state }: { state: Connections }) {
  const list = useLoad("agents", api.agents);
  const running = list.data?.runs.some(r => r.status === "running");
  const { reload } = list;
  // ponytail: polls while a run is working, as a fallback for servers without /api/stream; drop once the stream is live everywhere.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [running, reload]);
  const [open, setOpen] = useState<AgentId>();
  // A run started here opens its results once it finishes.
  const [waiting, setWaiting] = useState<AgentId>();
  const runs = list.data?.runs;
  const shownId = open ?? (waiting && runs?.find(r => r.agent === waiting)?.status === "done" ? waiting : undefined);
  const close = () => { setOpen(undefined); setWaiting(undefined); };

  const on = (kinds: AssetKind[]) => state.assets.some(a => kinds.includes(a.kind) && state.selected.includes(a.key));
  const shown = agents.find(a => a.id === shownId);
  const shownRun = runs?.find(r => r.agent === shownId);
  return (
    <Page title="Agents" description="They prepare the work in the background. Nothing is sent or changed until you tap.">
      <Load state={list}>{data => (
        <VStack gap={4}>
          {!data.ai_ready && <Banner status="info" title="Agents need AI access" description="Add an AI key in Settings to start running agents." endContent={<Button size="sm" label="Open Settings" href="#settings" />} />}
          <div className="bento">
            {agents.map(agent => (
              <Agent key={agent.id} agent={agent} run={data.runs.find(r => r.agent === agent.id)} ready={data.ai_ready} connected={on(agent.needs)}
                onOpen={() => setOpen(agent.id)}
                onStarted={() => {
                  setWaiting(agent.id);
                  list.setData(d => d && { ...d, runs: [...d.runs.filter(r => r.agent !== agent.id), { agent: agent.id, status: "running", result: null, error: null, cost_usd: null, created: Date.now() / 1000, finished: null }] });
                }} />
            ))}
          </div>
          {data.model && <Text as="p" type="supporting" size="sm">Agents run on {data.model}{data.own_key ? " with your own key" : ""}.</Text>}
        </VStack>
      )}</Load>
      <RecentWork />
      {shown && shownRun?.result && (
        <Modal isOpen onClose={close} title={shown.name}
          subtitle={shownRun.finished ? <>Finished <Timestamp value={shownRun.finished} format="relative" />{shownRun.cost_usd != null && ` · cost $${shownRun.cost_usd.toFixed(3)}`}</> : undefined}
          footer={<Button label="Close" onClick={close} />}>
          <Result result={shownRun.result} onLeave={close} />
        </Modal>
      )}
    </Page>
  );
}

function Agent({ agent, run, ready, connected, onStarted, onOpen }: { agent: (typeof agents)[number]; run?: AgentRun; ready: boolean; connected: boolean; onStarted: () => void; onOpen: () => void }) {
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
  const status = running ? <Token size="sm" color="blue" label="Working" />
    : run?.status === "done" ? <Token size="sm" color="green" label="Done" />
    : run?.status === "failed" ? <Token size="sm" color="red" label="Didn't finish" />
    : null;
  return (
    <Tile icon={agent.needs[0]} title={agent.name} status={status}>
      <Text as="p" type="supporting">{agent.does}</Text>
      <div aria-live="polite">
        {error && <Text as="p" size="sm">{error}</Text>}
        {running && <Text as="p" size="sm" className="shimmer">Working on it. This usually takes under a minute.</Text>}
        {run?.status === "failed" && <Text as="p" size="sm">This run didn't finish: {run.error ?? "no reason given"}</Text>}
        {run?.status === "done" && run.result && (
          <Text as="p" size="sm">{found(run.result)} {run.finished && <Text type="supporting" size="sm"><Timestamp value={run.finished} format="relative" size="sm" /></Text>}</Text>
        )}
      </div>
      <HStack gap={2} wrap="wrap">
        {connected
          ? <Button variant="primary" label={running ? "Working…" : run ? "Run again" : "Run"} isLoading={running} isDisabled={!ready} clickAction={start} />
          : <Button label="Connect an app first" href="#setup" />}
        {run?.status === "done" && run.result && <Button label="See results" onClick={onOpen} />}
      </HStack>
    </Tile>
  );
}

function Result({ result, onLeave }: { result: AgentResult; onLeave: () => void }) {
  if ("empty" in result) return <Text as="p">Nothing new to look at yet. Try again after more activity.</Text>;
  const items = (children: ReactNode[]) => <VStack gap={4} as="ul">{children.map((child, i) => <VStack key={i} as="li" gap={4}>{child}</VStack>)}</VStack>;
  if ("leads" in result) return result.leads.length ? items(result.leads.map((l, i) => (
    <VStack key={i} gap={1}>
      <Text weight="semibold">{l.who} <Text type="supporting">on {l.channel}</Text></Text>
      <div className="bubble"><Text as="p">{l.said}</Text></div>
      <Text as="p" type="supporting">{l.why}</Text>
      <Text as="p"><strong>Next:</strong> {l.next_step}</Text>
      <HStack><Link hasUnderline href="#inbox" onClick={onLeave}>Open their messages</Link></HStack>
    </VStack>
  ))) : <Text as="p">No one ready to buy yet. Try again after more messages come in.</Text>;
  if ("ideas" in result) return items(result.ideas.map((idea, i) => (
    <VStack key={i} gap={2}>
      <HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{idea.hook}</Text><Token size="sm" label={idea.format} /></HStack>
      <Text as="p">{idea.caption}</Text>
      <Text as="p" type="supporting">{idea.why}</Text>
      <HStack><Copy text={idea.caption} /></HStack>
    </VStack>
  )));
  if ("scripts" in result) return (
    <VStack gap={6}>
      {result.from_captions_only && <Text as="p" type="supporting">No Reels to watch yet, so these come from your captions. Post a Reel and run this again for notes on what works.</Text>}
      {result.watched.map(w => (
        <VStack key={w.video} gap={2}>
          {w.permalink ? <Link hasUnderline href={w.permalink} isExternalLink maxLines={1}>{w.caption?.split("\n")[0] || `Reel ${w.video}`}</Link> : <Text weight="semibold">Reel {w.video}</Text>}
          {w.works.map((n, i) => <Text key={i} as="p" size="sm"><Text weight="semibold" size="sm" hasTabularNumbers>{n.at}</Text> {n.what}</Text>)}
          {w.drop_off_guesses?.map((n, i) => <Text key={`g${i}`} as="p" size="sm" type="supporting"><Token size="sm" label="Guess" /> <Text size="sm" hasTabularNumbers>{n.at}</Text> {n.what.replace(/^Guess:\s*/i, "")}</Text>)}
        </VStack>
      ))}
      {items(result.scripts.map((sc, i) => (
        <VStack key={i} gap={2}>
          <Text weight="semibold">{sc.title}</Text>
          <Text as="p"><strong>Hook:</strong> {sc.hook}</Text>
          <VStack gap={1} as="ol">
            {sc.shots.map((shot, j) => <li key={j}><Text size="sm"><Text weight="semibold" size="sm" hasTabularNumbers>{shot.seconds}s</Text> {shot.shot} <Text type="supporting" size="sm">{shot.on_screen && shot.on_screen !== "No text" ? `Text: ${shot.on_screen}. ` : ""}Sound: {shot.sound}</Text></Text></li>)}
          </VStack>
          <Text as="p" type="supporting">{sc.caption}</Text>
          <HStack gap={2} wrap="wrap"><Copy text={sc.caption} /><Copy text={scriptText(sc)} label="Copy script" /></HStack>
        </VStack>
      )))}
      <Text as="p" type="supporting" size="sm">Nothing is posted. Film it, then post from Instagram.</Text>
    </VStack>
  );
  if ("replies" in result) return items(result.replies.map(r => (
    <VStack key={r.event_id} gap={2}>
      <Text weight="semibold">To {r.to}</Text>
      <div className="bubble"><Text as="p">{r.draft}</Text></div>
      <HStack><Button size="sm" variant="primary" label="Use this reply" href="#inbox" onClick={() => { drafts.set(r.event_id, { text: r.draft, source: "agent" }); onLeave(); }} /></HStack>
    </VStack>
  )));
  return (
    <VStack gap={4}>
      <Text as="p">{result.summary}</Text>
      {items(result.actions.map((a, i) => (
        <VStack key={i} gap={1}>
          <HStack gap={2} align="center"><Token size="sm" label={verbs[a.do]} color={a.do === "pause" ? "red" : a.do === "scale" ? "green" : a.do === "fix" ? "yellow" : "default"} /><Text weight="semibold">{a.campaign}</Text></HStack>
          <Text as="p" type="supporting">{a.why}</Text>
        </VStack>
      )))}
      <Text as="p" type="supporting" size="sm">Change your ads in Meta Ads Manager. Stupid doesn't edit them.</Text>
    </VStack>
  );
}

const said = { progress: "Working", waiting: "Waiting", ready: "Ready", blocked: "Stopped", failed: "Failed", dropped: "Nothing to do", question: "Asked you", answer: "You answered", idea: "Idea", advice: "Advice" } as const;

/** Every task the agent took on lately, with each step it reported. */
function RecentWork() {
  const home = useLoad("agent", api.agent);
  const tickets = home.data?.tickets ?? [];
  if (!tickets.length) return null;
  return (
    <section aria-labelledby="work-heading">
      <VStack gap={4}>
        <Heading level={2} id="work-heading">Recent work</Heading>
        <VStack gap={5} as="ul">
          {tickets.map((t: Ticket) => (
            <VStack key={t.id} as="li" gap={2}>
              <HStack gap={2} align="center" wrap="wrap">
                <Text weight="semibold">{t.message ? `Reply to ${senderName(t.message)}` : jobNames[t.job] ?? t.job}</Text>
                <ReportMark kind={lastReport(t)?.kind} />
              </HStack>
              <VStack gap={1} as="ol">
                {t.reports.map((r, i) => (
                  <li key={i}><Text size="sm"><Text type="supporting" size="sm">{said[r.kind] ?? r.kind} · <Timestamp value={r.created} format="relative" size="sm" /></Text> {r.kind === "idea" || r.kind === "advice" ? ideaLine(r.text) : r.text}</Text></li>
                ))}
              </VStack>
            </VStack>
          ))}
        </VStack>
      </VStack>
    </section>
  );
}

/** A saved idea or advice is JSON; show its headline. */
function ideaLine(text: string) {
  try {
    const v = JSON.parse(text) as { hook?: string; campaign?: string; do?: string; why?: string };
    return v.hook ?? `${v.do ?? ""} ${v.campaign ?? ""}: ${v.why ?? ""}`.trim();
  } catch {
    return text;
  }
}

/** A script as plain text to paste into notes or a teleprompter. */
const scriptText = (sc: ReelScript) => [sc.title, `Hook: ${sc.hook}`, ...sc.shots.map((s, i) => `${i + 1}. ${s.seconds}s · ${s.shot} · Text: ${s.on_screen} · Sound: ${s.sound}`), `Caption: ${sc.caption}`].join("\n");

function Copy({ text, label: idle = "Copy caption" }: { text: string; label?: string }) {
  const [label, setLabel] = useState(idle);
  return <Button size="sm" label={label} clickAction={() => navigator.clipboard.writeText(text).then(() => setLabel("Copied"), () => setLabel("Couldn't copy"))} />;
}
