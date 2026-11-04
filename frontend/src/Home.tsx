import { lazy, Suspense, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { ago, api, drafts, jobNames, sample, sampleSend, senderName, useLoad } from "./api";
import type { AgentHome, AgentId, AgentResult, AgentRun, Connections, Need, Persona } from "./api";
import { Check } from "./Icons";
import Trace from "./Trace";
import { Result } from "./Agents";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal } from "./Surface";

const Numbers = lazy(() => import("./Numbers"));
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
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The agent's desk: what it's watching, what needs the person, and what it made. Not a dashboard. */
export default function Home({ state, persona, onSetup }: { state: Connections; persona: Persona | null; onSetup: () => void }) {
  const home = useLoad("agent", api.agent);
  const runs = useLoad("agents", api.agents);
  // Shared with the onboarding card, so a closed card still leaves a way back while a required step is left.
  const setup = useLoad("setup-next", api.setupNext);
  const unfinished = setup.data?.persona && !setup.data.done && setup.data.step;
  const [today] = useState(() => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date()));
  return (
    <div className="page home">
      <VStack gap={8}>
        <VStack as="header" gap={2} hAlign="center">
          {home.data && <Status data={home.data} />}
          <Heading level={1} justify="center" tabIndex={-1}><VisuallyHidden>Home, </VisuallyHidden>{today}</Heading>
          {unfinished && <HStack gap={2} align="center" wrap="wrap" justify="center">
            <Text type="supporting" size="sm">{`Setup isn't finished: ${unfinished.title}`}</Text>
            <Button size="sm" variant="ghost" label="Finish setup" onClick={onSetup} />
          </HStack>}
        </VStack>
        <div className="home-panels">
          <Load state={home}>{data => <NeedsYou data={data} reload={home.reload} />}</Load>
          <Load state={runs}>{data => <ReadyForYou runs={data.runs} order={data.order} persona={persona} />}</Load>
        </div>
        <Suspense fallback={null}><Numbers state={state} /></Suspense>
      </VStack>
    </div>
  );
}

function Status({ data }: { data: AgentHome }) {
  const watching = data.watching.map(w => apps[w] ?? w);
  return (
    <Text as="p" type="supporting" size="sm" className="status-line">
      <span className="live-dot" data-on={watching.length > 0 || undefined} aria-hidden />
      {watching.length ? `Watching ${list(watching)}` : "Not watching any messages yet"}
      {data.last_checked ? ` · last checked ${ago(data.last_checked)}` : ""}
    </Text>
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
  const done = async (index: number) => {
    await reload();
    requestAnimationFrame(() => {
      const cards = list.current?.querySelectorAll<HTMLElement>(":scope > li");
      (cards?.[Math.min(index, cards.length - 1)] ?? document.getElementById("needs-heading"))?.focus();
    });
  };
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
      <div className="bubble bubble-out"><Text as="p">{need.text}</Text></div>
      <Trace match={need.matched_post} used={need.used} styled={need.styled} source={need.source} />
      <HStack gap={2}>
        {sent ? <span role="status" className="sent"><Check /> Sent</span>
          : <Button variant="primary" size="sm" label={sample ? sampleSend : "Send"} isDisabled={sample} clickAction={send} />}
        <Button variant="ghost" size="sm" label="Edit" onClick={edit} />
      </HStack>
      <div aria-live="polite">{error && <Text as="p" size="sm">{error}</Text>}</div>
    </VStack>
  );
}

function ReadyForYou({ runs, order, persona }: { runs: AgentRun[]; order: AgentId[]; persona: Persona | null }) {
  const [open, setOpen] = useState<AgentRun>();
  const done = order.map(id => runs.find(r => r.agent === id && r.status === "done" && r.result && !("empty" in r.result))).filter(r => r !== undefined);
  // The path's first three agents nudge when they have nothing yet.
  const quiet = order.slice(0, persona === "business" ? 2 : 3).filter(id => !done.some(r => r.agent === id));
  return (
    <Panel id="ready-heading" title="Ready for you" count={done.length}>
      {done.length > 0 && <ul className="rows">{done.map(r => <li key={r.agent} className="row"><Made run={r} onOpen={() => setOpen(r)} /></li>)}</ul>}
      {quiet.map(id => <Text key={id} as="p" type="supporting" size="sm">{jobNames[id]}: {nudges[id]}</Text>)}
      {open?.result && (
        <Modal isOpen onClose={() => setOpen(undefined)} title={jobNames[open.agent]} subtitle={open.models?.length ? `Made with ${list(open.models)}` : undefined}>
          <Result result={open.result} onLeave={() => setOpen(undefined)} />
        </Modal>
      )}
    </Panel>
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

function Preview({ result }: { result: Exclude<AgentResult, { empty: true }> }) {
  if ("scripts" in result) {
    const s = result.scripts[0];
    return s ? <VStack gap={1}><Text as="p" weight="semibold">{s.title}</Text><Text as="p" type="supporting" size="sm">Hook: {s.hook} · {s.shots.length} shots</Text></VStack> : null;
  }
  if ("ideas" in result) return <VStack gap={1}>{result.ideas.slice(0, 2).map((idea, i) => <Text key={i} as="p">{idea.hook} <Text type="supporting" size="sm">· {idea.format}</Text></Text>)}</VStack>;
  if ("leads" in result) return result.leads.length ? <VStack gap={1}>{result.leads.slice(0, 2).map((l, i) => <Text key={i} as="p"><strong>{l.who}</strong> <Text type="supporting">said “{l.said}”</Text></Text>)}</VStack> : <Text as="p" type="supporting">No one ready to buy yet.</Text>;
  if ("replies" in result) return <Text as="p">{result.replies.length} {result.replies.length === 1 ? "reply" : "replies"} drafted. Send {result.replies.length === 1 ? "it" : "them"} from Needs you or the Inbox.</Text>;
  return <Text as="p">{result.summary}</Text>;
}
