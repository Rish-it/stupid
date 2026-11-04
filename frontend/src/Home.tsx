import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { ago, api, chatUrl, drafts, jobNames, mediaImage, ownerPlace, sample, sampleSend, senderName, useLoad, whatsappBlock } from "./api";
import type { AgentHome, AgentId, AgentResult, AgentRun, Connections, CustomResult, Need, Persona } from "./api";
import { Check } from "./Icons";
import Trace from "./Trace";
import { Result } from "./Agents";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal } from "./Surface";

const Numbers = lazy(() => import("./Numbers"));
// Sample desk only: the owner's own WhatsApp, and drawn stand-ins for customers' photos.
const SamplePhone = lazy(() => import("./Sample"));
const SamplePhoto = lazy(() => import("./Sample").then(m => ({ default: m.SamplePhoto })));
const apps: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };
const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
/** What an agent says when it has nothing yet: a nudge, never "nothing to read". */
const nudges: Record<AgentId, string> = {
  reels: "Post a Reel and I'll direct the next one.",
  ideas: "Once you've posted a few times, I'll write your next posts.",
  leads: "When someone asks to buy or to work with you, I'll bring them here.",
  replies: "When a message arrives, I'll draft the answer here.",
  ads: "Run an ad and I'll say what to keep, grow or pause.",
};
const workingOn: Record<AgentId, string> = {
  reels: "is watching your Reels…", ideas: "is looking at your posts…", leads: "is reading your messages…", replies: "is drafting replies…", ads: "is checking your ads…",
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The agent's desk: what it's watching, what needs the person, and what it made. Not a dashboard. */
export default function Home({ state, persona }: { state: Connections; persona: Persona | null }) {
  const home = useLoad("agent", api.agent);
  const runs = useLoad("agents", api.agents);
  const [today] = useState(() => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date()));
  return (
    <div className="page home">
      <VStack gap={8}>
        <VStack as="header" gap={2} hAlign="center">
          {/* The status line's space is kept while it loads, so the date below never moves. */}
          {home.data ? <Status data={home.data} state={state} /> : <Text as="p" type="supporting" size="sm" className="status-line status-wait" aria-hidden>{"\u00a0"}</Text>}
          <Heading level={1} justify="center" tabIndex={-1}><VisuallyHidden>Home, </VisuallyHidden>{today}</Heading>
        </VStack>
        <div className="home-panels">
          <Load state={home}>{data => <NeedsYou data={data} reload={home.reload} />}</Load>
          <Load state={runs}>{data => <ReadyForYou runs={data.runs} order={data.order} persona={persona} waiting={home.data?.needs.length ?? 0} />}</Load>
          {sample && persona && <Suspense fallback={null}><SamplePhone persona={persona} /></Suspense>}
        </div>
        {home.data && <AgentChat needs={home.data.needs} />}
        <Suspense fallback={null}><Numbers state={state} /></Suspense>
      </VStack>
    </div>
  );
}

function Status({ data, state }: { data: AgentHome; state: Connections }) {
  const watching = data.watching.map(w => apps[w] ?? w);
  // The owner's own WhatsApp: say so while the agent can ping them there, else one quiet tap to set it up.
  const owner = useLoad("owner-channel", api.ownerChannel).data;
  const pinging = owner?.linked && owner.window_until !== null && owner.window_until > Date.now() / 1000;
  // Calm on purpose: anything to fix or finish sits with the agent's head, bottom right.
  const blocked = owner?.channel !== "messenger" && whatsappBlock(state, owner?.asset_id);
  return (
    <Text as="p" type="supporting" size="sm" className="status-line">
      {watching.length ? `Watching ${list(watching)}` : "Not watching any messages yet"}
      {data.last_checked ? ` · checked ${ago(data.last_checked)}` : ""}
      {owner && pinging && !blocked ? ` · Pinging you on ${ownerPlace(owner)}` : ""}
    </Text>
  );
}

/** Once paired: the agent is one WhatsApp message away, for the same things this desk does. */
function AgentChat({ needs }: { needs: Need[] }) {
  const owner = useLoad("owner-channel", api.ownerChannel).data;
  if (!owner?.linked || !owner.business_number) return null;
  // The example names someone actually waiting, when someone is.
  const waiting = needs.find(n => n.message)?.message;
  return (
    <section aria-labelledby="agent-chat" className="agent-chat">
      <VStack gap={1}>
        <Heading level={2} id="agent-chat" className="panel-title">Your agent on WhatsApp</Heading>
        <Text type="supporting" size="sm">{`Message your agent anytime: "what's pending?" or "reply to ${waiting ? senderName(waiting).split(" ")[0] : "a customer"}…"`}</Text>
      </VStack>
      <Button label="Open the chat" href={chatUrl(owner.business_number)} target="_blank" rel="noopener noreferrer" />
    </section>
  );
}

/** A panel on the desk: a quiet title row, then its rows. */
function Panel({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="panel">
      <VStack gap={4}>
        <HStack gap={2} align="center">
          <Heading level={2} id={id} tabIndex={-1} className="panel-title">{title}</Heading>
          {count ? <span key={count} className="count">{count}</span> : null}
        </HStack>
        {children}
      </VStack>
    </section>
  );
}

function NeedsYou({ data, reload }: { data: AgentHome; reload: () => Promise<void> }) {
  const list = useRef<HTMLUListElement>(null);
  // After an answer or a send, focus moves to the next card, or to the heading when none is left.
  // Focus moves once the reloaded list is on screen, not on a timer that can beat React's commit.
  const next = useRef<number>(undefined);
  const done = async (index: number) => { next.current = index; await reload(); };
  useEffect(() => {
    const index = next.current;
    if (index === undefined) return;
    next.current = undefined;
    const cards = list.current?.querySelectorAll<HTMLElement>(":scope > li");
    (cards?.[Math.min(index, cards.length - 1)] ?? document.getElementById("needs-heading"))?.focus();
  }, [data.needs]);
  return (
    <Panel id="needs-heading" title="Needs you" count={data.needs.length}>
      {data.needs.length ? (
        <ul ref={list} className="rows">
          {data.needs.map((n, i) => <li key={`${n.type}${n.id}`} tabIndex={-1} className="row">{n.type === "question" ? <Question need={n} onDone={() => done(i)} /> : <Draft need={n} onDone={() => done(i)} />}</li>)}
        </ul>
      ) : <Text as="p" type="supporting">{data.proactive ? "Nothing waits for you. New messages get a draft here within a minute." : "Drafting on new messages is off in Settings."}</Text>}
    </Panel>
  );
}

function Who({ message: m, label, when }: { message: Need["message"]; label: string; when: number }) {
  return (
    <HStack gap={2} align="center" wrap="wrap">
      {m && <SourceIcon source={m.kind} size={14} />}
      <Text weight="semibold" size="sm">{m ? senderName(m) : "Your agent"}</Text>
      <Text type="supporting" size="sm">{label} · {ago(when)}</Text>
    </HStack>
  );
}

function Question({ need, onDone }: { need: Extract<Need, { type: "question" }>; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const send = (skip: boolean, answer = text.trim()) => api.answer(need.id, answer, skip).then(onDone, (cause: unknown) => setError(message(cause)));
  const head = <>
    <Who message={need.message} label="Question" when={need.created} />
    {need.message?.text && <Text as="p" type="supporting" size="sm">“{need.message.text}”</Text>}
    <Text as="p" weight="semibold">{need.question}</Text>
  </>;
  // An agent set to "Ask me first" asks before drafting: a yes or a skip, nothing to type.
  if (need.ask_first) return (
    <VStack gap={3}>
      {head}
      <HStack gap={2}>
        <Button variant="primary" size="sm" label="Draft it" clickAction={() => send(false, "Yes, draft a reply.")} />
        <Button variant="ghost" size="sm" label="Skip" clickAction={() => send(true)} />
      </HStack>
      <div aria-live="polite">{error && <Text as="p" size="sm">{error}</Text>}</div>
    </VStack>
  );
  return (
    <VStack gap={3}>
      {head}
      <TextArea label="Your answer" isLabelHidden placeholder="Your answer" value={text} onChange={v => { setText(v); setError(""); }} rows={2} maxLength={1000}
        status={error ? { type: "error", message: error } : undefined} />
      <HStack gap={2}>
        <Button variant="primary" size="sm" label="Answer" isDisabled={!text.trim()} clickAction={() => send(false)} />
        <Button variant="ghost" size="sm" label="Skip" clickAction={() => send(true)} />
      </HStack>
    </VStack>
  );
}

function Draft({ need, onDone }: { need: Extract<Need, { type: "draft" }>; onDone: () => void }) {
  const [error, setError] = useState("");
  const edit = () => { drafts.set(need.event_id, { text: need.text, source: need.source === "muse" ? "muse" : "agent" }); location.hash = "#inbox"; };
  // The tap on Send is the person's approval; nothing goes out before it.
  const [sent, setSent] = useState(false);
  // A moment for the check to draw before the row leaves.
  const send = () => api.reply(need.event_id, need.text).then(() => { setSent(true); setTimeout(onDone, 450); }, (cause: unknown) => setError(message(cause)));
  return (
    <VStack gap={3}>
      <Who message={need.message} label={need.source === "muse" ? "From Muse" : "Drafted by AI"} when={need.created} />
      {need.message.text && <Text as="p" type="supporting" size="sm">“{need.message.text}”</Text>}
      {sample && need.message.photo && <Suspense fallback={null}><SamplePhoto id={need.event_id} /></Suspense>}
      <div className="bubble bubble-out"><Text as="p">{need.text}</Text></div>
      <Trace voice={need.message.voice ? need.message.voice.model ?? need.models?.described_by ?? null : undefined}
        photo={need.message.photo ? need.message.photo.model ?? need.models?.described_by ?? null : undefined}
        drafted={need.models?.drafted_by} match={need.matched_post} used={need.used} styled={need.styled} source={need.source} />
      <HStack gap={2}>
        {sent ? <span role="status" className="sent"><Check /> Sent</span>
          : <Button variant="primary" size="sm" label={sample ? sampleSend : "Send"} isDisabled={sample} clickAction={send} />}
        <Button variant="ghost" size="sm" label="Edit" onClick={edit} />
      </HStack>
      <div aria-live="polite">{error && <Text as="p" size="sm">{error}</Text>}</div>
    </VStack>
  );
}

const thin = (result: AgentResult) => "empty" in result || ("leads" in result && !result.leads.length) || ("ideas" in result && !result.ideas.length)
  || ("replies" in result && !result.replies.length) || ("scripts" in result && !result.scripts.length);

function ReadyForYou({ runs, order, persona, waiting }: { runs: AgentRun[]; order: AgentId[]; persona: Persona | null; waiting: number }) {
  const [open, setOpen] = useState<AgentRun>();
  // A result with nothing in it (no leads, no ideas) isn't ready work; its agent nudges instead.
  // Reply drafts already sent or dropped aren't ready work: they show only while Needs you still holds some.
  const done = order.map(id => runs.find(r => r.agent === id && r.status === "done" && r.result && !thin(r.result) && (id !== "replies" || waiting > 0))).filter(r => r !== undefined);
  const own = runs.filter(r => r.agent.startsWith("custom:") && r.status === "done" && r.result).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
  const working = order.filter(id => runs.some(r => r.agent === id && r.status === "running"));
  // The path's first three agents nudge when they have nothing yet.
  const quiet = order.slice(0, persona === "business" ? 2 : 3).filter(id => !done.some(r => r.agent === id) && !working.includes(id));
  return (
    <Panel id="ready-heading" title="Ready for you" count={done.length + own.length}>
      {working.length > 0 && <ul className="rows">{working.map(id => <li key={id} className="row">
        <Text as="p" size="sm"><Text weight="semibold" size="sm">{jobNames[id]}</Text> <span className="shimmer">{workingOn[id]}</span></Text>
      </li>)}</ul>}
      {done.length + own.length > 0 && <ul className="rows">
        {own.map(r => <li key={r.agent} className="row"><Own run={r} /></li>)}
        {done.map(r => <li key={r.agent} className="row"><Made run={r} onOpen={() => setOpen(r)} /></li>)}
      </ul>}
      {quiet.map(id => <Text key={id} as="p" type="supporting" size="sm">{jobNames[id]}: {nudges[id]}</Text>)}
      {open?.result && (
        <Modal isOpen onClose={() => setOpen(undefined)} title={jobNames[open.agent]} subtitle={open.models?.length ? `Made with ${list(open.models)}` : undefined}>
          <Result result={open.result} onLeave={() => setOpen(undefined)} />
        </Modal>
      )}
    </Panel>
  );
}

/** What an agent the owner wrote found, in its own words. */
function Own({ run }: { run: AgentRun }) {
  const result = run.result as unknown as CustomResult;
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text weight="semibold" size="sm">{result.name}</Text>
        {run.models?.length ? <span className="kind">{list(run.models)}</span> : null}
        {run.finished && <Text type="supporting" size="sm">{ago(run.finished)}</Text>}
      </HStack>
      <Text as="p">{result.summary}</Text>
      {result.drafts > 0 && <Text as="p" type="supporting" size="sm">{result.drafts === 1 ? "Its draft waits" : "Its drafts wait"} in Needs you.</Text>}
    </VStack>
  );
}

/** The actual result, not a count: the words, the script, the lead. */
function Made({ run, onOpen }: { run: AgentRun; onOpen: () => void }) {
  const result = run.result as Exclude<AgentResult, { empty: true }>;
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text weight="semibold" size="sm">{jobNames[run.agent]}</Text>
        {run.models?.length ? <span className="kind">{list(run.models)}</span> : null}
        {run.finished && <Text type="supporting" size="sm">{ago(run.finished)}</Text>}
      </HStack>
      <Preview result={result} />
      <HStack><Button size="sm" label="Open" onClick={onOpen} /></HStack>
    </VStack>
  );
}

/** Up to four of the creator's own posts the agent looked at, small. */
function Looked({ posts }: { posts: { id?: string; permalink?: string; caption?: string }[] }) {
  const shown = posts.filter(p => p.id).slice(0, 4);
  return shown.length ? <HStack gap={1} align="center" wrap="wrap">
    <Text type="supporting" size="sm">Looked at</Text>
    {shown.map(p => <img key={p.id} className="trace-thumb ready-thumb" src={mediaImage(p.id!)} alt={p.caption?.split("\n")[0] || "Your post"} title={p.caption} width={28} height={28} loading="lazy" />)}
  </HStack> : null;
}

function Preview({ result }: { result: Exclude<AgentResult, { empty: true }> }) {
  if ("scripts" in result) {
    const s = result.scripts[0];
    return s ? <VStack gap={2}>
      <Text as="p" weight="semibold">{s.title}</Text>
      <Text as="p" size="sm">“{s.hook}”</Text>
      <Text as="p" type="supporting" size="sm">{s.shots.length} shots{result.scripts.length > 1 ? ` · ${result.scripts.length - 1} more ${result.scripts.length === 2 ? "script" : "scripts"}` : ""}{result.from_captions_only ? " · from your captions, no Reels to watch yet" : ""}</Text>
      <Looked posts={result.watched} />
    </VStack> : null;
  }
  if ("ideas" in result) {
    const idea = result.ideas[0];
    return idea ? <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{idea.hook}</Text><span className="kind">{idea.format}</span></HStack>
      <Text as="p" size="sm" className="ready-clamp">{idea.caption}</Text>
      {result.ideas.length > 1 && <Text as="p" type="supporting" size="sm">{`${result.ideas.length - 1} more ${result.ideas.length === 2 ? "idea" : "ideas"}`}</Text>}
      {result.looked_at_posts?.length ? <Looked posts={result.looked_at_posts} />
        : result.looked_at ? <Text as="p" type="supporting" size="sm">{`After looking at ${result.looked_at} of your pictures.`}</Text>
        : <Text as="p" type="supporting" size="sm">Written without seeing your pictures: Instagram shared none this time.</Text>}
    </VStack> : null;
  }
  if ("leads" in result) return <VStack gap={1}>{result.leads.slice(0, 2).map((l, i) => <Text key={i} as="p"><strong>{l.who}</strong> <Text type="supporting">said “{l.said}”</Text></Text>)}</VStack>;
  if ("replies" in result) {
    const first = result.replies[0];
    return <VStack gap={1}>
      {first && <Text as="p" size="sm" className="ready-clamp"><strong>To {first.to || "a customer"}:</strong> {first.draft}</Text>}
      <Text as="p" type="supporting" size="sm">{result.replies.length === 1 ? "Send it from Needs you or the Inbox." : `${result.replies.length} replies drafted. Send them from Needs you or the Inbox.`}</Text>
    </VStack>;
  }
  return <VStack gap={1}>
    <Text as="p" className="ready-clamp">{result.summary}</Text>
    {result.actions.length > 0 && <Text as="p" type="supporting" size="sm">{`${result.actions.length} ${result.actions.length === 1 ? "suggestion" : "suggestions"} for your ads`}</Text>}
  </VStack>;
}
