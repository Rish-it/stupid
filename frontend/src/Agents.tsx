import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextArea } from "@astryxdesign/core/TextArea";
import { characterCount } from "@astryxdesign/core/utils";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Heading } from "@astryxdesign/core/Heading";
import { ago, api, drafts, jobNames, lastReport, mediaImage, senderName, useLoad } from "./api";
import type { AgentControl, AgentId, AgentMode, AgentResult, AgentRun, AssetKind, Connections, ReelScript, Ticket } from "./api";
import { objectPosition, ratios, savePng } from "./crop";
import type { Crop } from "./crop";
import { Load } from "./Load";
import OwnAgents from "./OwnAgents";
import SourceIcon from "./SourceIcon";
import { modelName } from "./Trace";
import { Modal, Page } from "./Surface";

const agents: { id: AgentId; name: string; does: string; needs: AssetKind[] }[] = [
  { id: "leads", name: "Lead finder", does: "Reads your comments and messages, spots people ready to buy, and says what to send them.", needs: ["instagram", "whatsapp", "messenger"] },
  { id: "ideas", name: "Post ideas", does: "Looks at what worked for you lately and drafts posts in your voice.", needs: ["instagram"] },
  { id: "reels", name: "Reel director", does: "Muse Wonder watches your best Reels, says what works and where people may stop watching, and writes three new scripts with shot lists.", needs: ["instagram"] },
  { id: "replies", name: "Reply drafts", does: "Drafts answers to new messages. Nothing is sent until you tap send in the Inbox.", needs: ["whatsapp", "messenger", "instagram"] },
  { id: "ads", name: "Ad watcher", does: "Checks your ads and says which to pause, keep, grow or fix, and why.", needs: ["ads"] },
];
const marks: Partial<Record<string, { label: string; color?: "green" | "red" | "yellow" | "blue" }>> = {
  progress: { label: "Working", color: "blue" }, waiting: { label: "Needs you" }, ready: { label: "Ready", color: "green" },
  blocked: { label: "Stopped", color: "yellow" }, failed: { label: "Didn't finish", color: "red" },
};
function ReportMark({ kind }: { kind?: string }) {
  const mark = kind ? marks[kind] : undefined;
  return mark ? <Token size="sm" label={mark.label} color={mark.color} /> : null;
}

const appNames: Record<AssetKind, string> = { instagram: "Instagram", whatsapp: "WhatsApp", messenger: "your Facebook Page", ads: "Meta Ads" };
// Before a run, a tile names the model it will use: the Reel director watches with Muse Wonder.
const plannedModel = (id: AgentId, model: string) => id === "reels" ? "Muse Wonder" : model && modelName(model);

const verbs = { pause: "Pause", keep: "Keep", scale: "Grow", fix: "Fix" } as const;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line for the tile: what the last run found. */
function found(result: AgentResult) {
  if ("empty" in result) return result.why ? "No posts yet." : "Nothing new to look at yet.";
  if ("leads" in result) return result.leads.length ? `Found ${plural(result.leads.length, "lead", "leads")}.` : "No one ready to buy yet.";
  if ("ideas" in result) return `Drafted ${plural(result.ideas.length, "post idea", "post ideas")}${result.looked_at ? ` after looking at ${result.looked_at} of your pictures` : ""}.`;
  if ("replies" in result) return `Drafted ${plural(result.replies.length, "reply", "replies")}.`;
  if ("scripts" in result) return result.from_captions_only
    ? `Wrote ${plural(result.scripts.length, "Reel script", "Reel scripts")} from your captions. No Reels to watch yet.`
    : `Watched ${plural(result.watched.length, "Reel", "Reels")} and wrote ${plural(result.scripts.length, "script", "scripts")}.`;
  return result.summary;
}

// The page shows three apps, each an album cover; its agents open from the cover.
type AppId = "whatsapp" | "instagram" | "meta";
const apps: { id: AppId; name: string; icon: AssetKind; does: string; agents: AgentId[]; kinds: AssetKind[]; stops: string[] }[] = [
  { id: "whatsapp", name: "WhatsApp", icon: "whatsapp", does: "Drafts replies to your customers' messages.", agents: ["replies"], kinds: ["whatsapp"], stops: ["#03261F", "#075E54", "#128C7E", "#25D366"] },
  { id: "instagram", name: "Instagram", icon: "instagram", does: "Directs Reels, drafts posts and finds brand deals and buyers.", agents: ["reels", "ideas", "leads"], kinds: ["instagram"], stops: ["#F9CE34", "#EE2A7B", "#C13584", "#6228D7", "#2A1260"] },
  { id: "meta", name: "Meta", icon: "ads", does: "Watches your ads, Facebook Page and Messenger.", agents: ["ads"], kinds: ["ads", "messenger"], stops: ["#020B24", "#0A2A6B", "#0064E0", "#5AA9FF"] },
];
// Ordered (Bayer 8x8) dither of a diagonal gradient, drawn once per app and scaled up without smoothing.
const bayer = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const covers: Partial<Record<AppId, string>> = {};
function dither(id: AppId, stops: string[]) {
  if (covers[id] !== undefined) return covers[id];
  const n = 72, canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const g = canvas.getContext("2d");
  if (!g) return covers[id] = "";
  const rgb = stops.map(s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)));
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    // Bottom-left to top-right, with a soft glow in the middle where the mark sits.
    const glow = 1 - Math.hypot(x - n / 2, y - n / 2) / (n * .7);
    const t = Math.min(1, Math.max(0, .8 * (x + n - 1 - y) / (2 * n - 2) + .2 * glow));
    const p = t * (stops.length - 1), i = Math.min(Math.floor(p), stops.length - 2);
    const [r, gr, b] = rgb[p - i > (bayer[(y % 8) * 8 + x % 8] + .5) / 64 ? i + 1 : i];
    img.data.set([r, gr, b, 255], (y * n + x) * 4);
  }
  g.putImageData(img, 0, 0);
  return covers[id] = `url(${canvas.toDataURL()})`;
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
  const [app, setApp] = useState<AppId>();
  const [open, setOpen] = useState<AgentId>();
  const [work, setWork] = useState(false);
  // A run started here opens its results once it finishes.
  const [waiting, setWaiting] = useState<AgentId>();
  const runs = list.data?.runs;
  const shownId = open ?? (waiting && runs?.find(r => r.agent === waiting)?.status === "done" ? waiting : undefined);
  // Leaving results keeps their app's window open behind them.
  const back = () => { if (current) setApp(current.id); setOpen(undefined); setWaiting(undefined); };
  const close = () => { back(); setApp(undefined); };

  const on = (kinds: AssetKind[]) => state.assets.some(a => kinds.includes(a.kind) && state.selected.includes(a.key));
  const shown = agents.find(a => a.id === shownId);
  const shownRun = runs?.find(r => r.agent === shownId);
  const result = shown && shownRun?.result ? shownRun.result : undefined;
  const current = apps.find(a => a.id === app) ?? (result ? apps.find(a => a.agents.includes(shownId!)) : undefined);
  return (
    <Page title="Agents" description="Each one prepares work in the background. Nothing is sent, posted or changed until you tap."
      actions={<><OwnAgents runs={runs ?? []} ready={list.data?.ai_ready ?? false} onStarted={() => void reload()} /><RecentWork open={work} onOpen={() => setWork(true)} onClose={() => setWork(false)} /></>}>
      <Load state={list}>{data => {
        const rank = (id: AgentId) => { const i = data.order.indexOf(id); return i < 0 ? Infinity : i; };
        const sorted = [...apps].sort((a, b) => Math.min(...a.agents.map(rank)) - Math.min(...b.agents.map(rank)));
        const inApp = current ? data.order.filter(id => current.agents.includes(id)).map(id => agents.find(a => a.id === id)).filter(a => a !== undefined) : [];
        return (
          <VStack gap={4}>
            {!data.ai_ready && <Banner status="info" title="Agents need AI access" description="Add an AI key in Settings to start running agents." endContent={<Button size="sm" label="Open Settings" href="#settings" />} />}
            <div className="covers">
              {sorted.map(a => (
                <article key={a.id} className="cover" data-app={a.id} aria-labelledby={`app-${a.id}`}>
                  <div className="cover-art" style={{ backgroundImage: dither(a.id, a.stops) }}><SourceIcon source={a.icon} size={96} /></div>
                  <VStack gap={1}>
                    <Heading level={2} id={`app-${a.id}`} className="cover-name"><button type="button" className="cover-open" onClick={() => setApp(a.id)}>{a.name}</button></Heading>
                    <Text as="p" type="supporting" size="sm">{a.does}</Text>
                    <Text as="p" size="sm" className="cover-state" data-on={on(a.kinds) || undefined}>{on(a.kinds) ? "Connected" : "Not connected"}</Text>
                  </VStack>
                </article>
              ))}
            </div>
            {data.model && <Text as="p" type="supporting" size="sm">Agents run on {modelName(data.model)}{data.own_key ? " with your own key" : ""}.</Text>}
            {/* Results open over their app's window; Escape steps back one level at a time. */}
            {current && <Modal isOpen onClose={close} title={current.name} subtitle={current.does} width={inApp.length > 1 ? 960 : 560}>
                <div className="agent-list">
                  {inApp.map(agent => (
                    <Agent key={agent.id} agent={agent} run={data.runs.find(r => r.agent === agent.id)} control={data.controls?.[agent.id]}
                      onControl={next => list.setData(d => d && { ...d, controls: { ...d.controls, [agent.id]: next } })} model={plannedModel(agent.id, data.model)} ready={data.ai_ready} connected={on(agent.needs)}
                      onOpen={() => setOpen(agent.id)}
                      onStarted={() => {
                        setWaiting(agent.id);
                        list.setData(d => d && { ...d, runs: [...d.runs.filter(r => r.agent !== agent.id), { agent: agent.id, status: "running", result: null, error: null, cost_usd: null, created: Date.now() / 1000, finished: null, models: [] }] });
                      }} />
                  ))}
                </div>
              </Modal>}
            {current && result && shown && shownRun && <Modal isOpen onClose={back} title={shown.name} width={720}
                subtitle={shownRun.finished ? `Finished ${ago(shownRun.finished)}${shownRun.models.length ? ` · made with ${shownRun.models.join(", ")}` : ""}${shownRun.cost_usd != null ? ` · cost $${shownRun.cost_usd.toFixed(3)}` : ""}` : undefined}
                footer={<><Button label={`Back to ${current.name}`} onClick={back} /><Button label="Close" onClick={close} /></>}>
                <Result result={result} onLeave={close} />
              </Modal>}
          </VStack>
        );
      }}</Load>
    </Page>
  );
}

function Agent({ agent, run, control, onControl, model, ready, connected, onStarted, onOpen }: {
  agent: (typeof agents)[number]; run?: AgentRun; control?: AgentControl; onControl: (next: AgentControl) => void;
  model: string; ready: boolean; connected: boolean; onStarted: () => void; onOpen: () => void;
}) {
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
    <article className="agent-tile" data-agent={agent.id} data-mode={control?.mode} aria-labelledby={`agent-${agent.id}`}>
      <VStack gap={1}>
        <Heading level={3} id={`agent-${agent.id}`} className="agent-name">{agent.name}</Heading>
        {run?.models.length ? <Text size="sm" type="supporting">{run.models.join(" · ")}</Text> : model ? <Text size="sm" type="supporting">{model}</Text> : null}
      </VStack>
      <div aria-live="polite" className="agent-says">
        {error && <Text as="p" size="sm">{error}</Text>}
        {running && <Text as="p" size="sm" className="shimmer">Working on it. This usually takes under a minute.</Text>}
        {run?.status === "failed" && <Text as="p" size="sm">This run didn't finish: {run.error ?? "no reason given"}</Text>}
        {run?.status === "done" && run.result && <Text as="p" size="sm">{found(run.result)}</Text>}
        {run?.finished && !running && <Text as="p" size="sm" type="supporting">Last ran {ago(run.finished)}</Text>}
        {control?.mode === "off" ? <Text as="p" size="sm">Off. It won't run until you choose Ask me first or Draft for me.</Text>
          : !run && <Text as="p" size="sm">{agent.does}</Text>}
      </div>
      <HStack gap={2} wrap="wrap">
        {connected
          ? <Button variant="primary" size="sm" label={running ? "Working…" : "Run now"} isLoading={running} isDisabled={!ready || control?.mode === "off"} clickAction={start}
            aria-label={running ? `${agent.name} is working` : run ? `Run again: ${agent.name}` : `Run ${agent.name}`} />
          : <Button size="sm" label={`Connect ${appNames[agent.needs[0]]}`} href="#setup" />}
        {run?.status === "done" && run.result && <Button size="sm" label="See results" aria-label={`See results: ${agent.name}`} onClick={onOpen} />}
      </HStack>
      {control && <Control agent={agent} control={control} onSaved={onControl} />}
    </article>
  );
}

/** How far this agent goes on its own, and one sentence for it. Each change saves at once; the sentence saves when you leave it. */
function Control({ agent, control, onSaved }: { agent: (typeof agents)[number]; control: AgentControl; onSaved: (next: AgentControl) => void }) {
  const [note, setNote] = useState(control.note);
  const [status, setStatus] = useState("");
  const long = characterCount(note) > 280;
  const save = (mode: AgentMode, text: string) => api.control(agent.id, mode, text.trim())
    .then(({ mode, note }) => { onSaved({ mode, note }); setStatus("Saved"); }, (cause: unknown) => setStatus(cause instanceof Error ? cause.message : String(cause)));
  return (
    <VStack gap={2} className="agent-control">
      <SegmentedControl label={`What ${agent.name} does on its own`} size="sm" layout="fill" value={control.mode} onChange={v => void save(v as AgentMode, long ? control.note : note)}>
        <SegmentedControlItem value="off" label="Off" />
        <SegmentedControlItem value="ask" label="Ask me first" />
        <SegmentedControlItem value="draft" label="Draft for me" />
      </SegmentedControl>
      <TextArea label={`Tell ${agent.name}`} isLabelHidden placeholder="Tell this agent…" rows={2} maxLength={280} value={note}
        status={long ? { type: "error", message: "Keep it to 280 characters." } : undefined}
        onChange={v => { setNote(v); setStatus(""); }} onBlur={() => { if (!long && note.trim() !== control.note) void save(control.mode, note); }} />
      <Text as="p" size="sm" type="supporting" aria-live="polite">{status}</Text>
    </VStack>
  );
}

export function Result({ result, onLeave }: { result: AgentResult; onLeave: () => void }) {
  if ("empty" in result) return <Text as="p">{result.why ?? "Nothing new to look at yet. Try again after more activity."}</Text>;
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
  if ("ideas" in result) return (
    <VStack gap={4}>
      {result.looked_at_posts?.length ? (
        <VStack gap={2}>
          <Text size="sm" type="supporting">Looked at these posts of yours</Text>
          <HStack gap={2} wrap="wrap">{result.looked_at_posts.map(p => (
            <a key={p.id} href={p.permalink} target="_blank" rel="noreferrer" title={p.caption}><img className="match-thumb" src={mediaImage(p.id)} alt={p.caption || "Your post"} width={40} height={40} loading="lazy" /></a>
          ))}</HStack>
        </VStack>
      ) : result.looked_at === 0 && <Text size="sm" type="supporting">Written from your captions and numbers; your pictures couldn't be read this time.</Text>}
      {items(result.ideas.map((idea, i) => (
    <VStack key={i} gap={2}>
      <HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{idea.hook}</Text><Token size="sm" label={idea.format} /></HStack>
      <Text as="p">{idea.caption}</Text>
      <Text as="p" type="supporting">{idea.why}</Text>
      <HStack><Copy text={idea.caption} /></HStack>
    </VStack>
  )))}
    </VStack>
  );
  if ("scripts" in result) return (
    <VStack gap={6}>
      {result.from_captions_only && <Text as="p" type="supporting">No Reels to watch yet, so these come from your captions. Post a Reel and run this again for notes on what works.</Text>}
      {result.watched.map(w => (
        <VStack key={w.video} gap={2}>
          <HStack gap={3} align="center">
            {w.id && <img className="match-thumb" src={mediaImage(w.id)} alt="" width={40} height={40} loading="lazy" />}
            {w.permalink ? <Link hasUnderline href={w.permalink} isExternalLink maxLines={1}>{w.caption?.split("\n")[0] || `Reel ${w.video}`}</Link> : <Text weight="semibold">Reel {w.video}</Text>}
          </HStack>
          {w.works.map((n, i) => <Text key={i} as="p" size="sm"><Text weight="semibold" size="sm" hasTabularNumbers>{n.at}</Text> {n.what}</Text>)}
          {w.drop_off_guesses?.map((n, i) => <Text key={`g${i}`} as="p" size="sm" type="supporting"><Token size="sm" label="Guess" /> <Text size="sm" hasTabularNumbers>{n.at}</Text> {n.what.replace(/^Guess:\s*/i, "")}</Text>)}
        </VStack>
      ))}
      {result.skipped?.map((k, i) => (
        <Text key={`s${i}`} as="p" size="sm" type="supporting">Didn't watch {k.permalink ? <Link hasUnderline href={k.permalink} isExternalLink>{k.caption?.split("\n")[0] || "a Reel"}</Link> : k.caption?.split("\n")[0] || "a Reel"}: {k.why}</Text>
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
      {result.creative_pack && result.creative_pack.length > 0 && <CreativePack pack={result.creative_pack} />}
      <Text as="p" type="supporting" size="sm">Change your ads in Meta Ads Manager. Stupid doesn't edit them.</Text>
    </VStack>
  );
}

/** The creator's own best pictures, cropped around the subject SAM 3.1 found, one per ad placement. */
function CreativePack({ pack }: { pack: Crop[] }) {
  const [error, setError] = useState("");
  return (
    <VStack gap={4}>
      <Text weight="semibold">Ad creative pack</Text>
      <Text as="p" type="supporting" size="sm">Your own pictures, cropped around what SAM 3.1 found in each, for every ad placement. Nothing is uploaded to Ads; save the ones you want.</Text>
      {pack.map(p => {
        const src = mediaImage(p.id);
        return (
          <VStack key={p.id} gap={2}>
            <Text size="sm"><Text weight="semibold" size="sm">{p.subject}</Text>{p.permalink && <> · <Link hasUnderline href={p.permalink} isExternalLink>the post</Link></>}</Text>
            {p.note && <Text as="p" type="supporting" size="sm">{p.note}</Text>}
            <HStack gap={3} wrap="wrap" align="end">
              {ratios.map(r => (
                <VStack key={r.label} gap={1} hAlign="start">
                  <img className="crop" src={src} alt={`${p.subject}, ${r.label} crop for ${r.name}`} loading="lazy"
                    style={{ aspectRatio: `${r.a}`, objectPosition: objectPosition(r.a, p.box) }} />
                  <Button size="sm" label={`Save ${r.label}`} clickAction={() => savePng(src, r.a, p.box, `${p.subject.replace(/\W+/g, "-")}-${r.label.replace(":", "x")}.png`).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))} />
                </VStack>
              ))}
            </HStack>
          </VStack>
        );
      })}
      <div aria-live="polite">{error && <Text as="p" size="sm">{error}</Text>}</div>
    </VStack>
  );
}

const said = { progress: "Working", waiting: "Waiting", ready: "Ready", blocked: "Stopped", failed: "Failed", dropped: "Nothing to do", question: "Asked you", answer: "You answered", idea: "Idea", advice: "Advice" } as const;

/** Every task the agent took on lately, with each step it reported, in a window opened from the page heading. */
function RecentWork({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const home = useLoad("agent", api.agent);
  const tickets = home.data?.tickets ?? [];
  if (!tickets.length) return null;
  return (
    <>
      <Button label="Recent work" onClick={onOpen} />
      {open && <Modal isOpen onClose={onClose} title="Recent work" footer={<Button label="Close" onClick={onClose} />}>
        <VStack gap={5} as="ul">
          {tickets.map((t: Ticket) => (
            <VStack key={t.id} as="li" gap={2}>
              <HStack gap={2} align="center" wrap="wrap">
                <Text weight="semibold">{t.message ? `Reply to ${senderName(t.message)}` : jobNames[t.job] ?? t.job}</Text>
                <ReportMark kind={lastReport(t)?.kind} />
              </HStack>
              <VStack gap={1} as="ol">
                {t.reports.map((r, i) => (
                  <li key={i}><Text size="sm"><Text type="supporting" size="sm">{said[r.kind] ?? r.kind} · {ago(r.created)}</Text> {r.kind === "idea" || r.kind === "advice" ? ideaLine(r.text) : r.text}</Text></li>
                ))}
              </VStack>
            </VStack>
          ))}
        </VStack>
      </Modal>}
    </>
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
