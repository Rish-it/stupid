import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { ago, api, chatUrl, jobNames, lastReport, ownerPlace, refetch, sample, sampleSend, senderName, useLoad, whatsappBlock } from "./api";
import type { AgentHome, AgentId, AgentResult, AgentRun, Connections, CustomResult, InboxItem, InboxKind, Need, Persona } from "./api";
import { Check, Logo } from "./Icons";
import Trace from "./Trace";
import { Result } from "./Agents";
import SourceIcon from "./SourceIcon";

const Numbers = lazy(() => import("./Numbers"));
// Sample desk only: the owner's own WhatsApp, and drawn stand-ins for customers' photos.
const SamplePhone = lazy(() => import("./Sample"));
const SamplePhoto = lazy(() => import("./Sample").then(m => ({ default: m.SamplePhoto })));
const apps: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", instagram_comment: "Instagram" };
const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
const workingOn: Record<AgentId, string> = {
  reels: "is watching your Reels…", ideas: "is looking at your posts…", leads: "is reading your messages…", replies: "is drafting replies…", ads: "is checking your ads…",
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const working = { voice: "Transcribing the voice note…", photo: "Looking at the photo…", video: "Watching the video…" } as const;

/** Today as "14:05", any other day as "4 Nov": the list's time column. */
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const short = (unix: number) => {
  const d = new Date(unix * 1000);
  return d.toDateString() === new Date().toDateString() ? time.format(d) : date.format(d);
};

const groups = { all: "Everything", needs: "Needs you", working: "Agents working", done: "Done" } as const;
type Group = Exclude<keyof typeof groups, "all">;
/** One thing in the shared space: a person's conversation, or an agent's question, work or result. */
type Row = { key: string; group: Group; who: string; tag: string; source?: string; agent?: boolean; preview: string; when: number; state: string; pane: ReactNode };

/** A result with nothing in it (no leads, no ideas) isn't ready work. */
const thin = (result: AgentResult) => "empty" in result || ("leads" in result && !result.leads.length) || ("ideas" in result && !result.ideas.length)
  || ("replies" in result && !result.replies.length) || ("scripts" in result && !result.scripts.length);

/** What a finished agent left, in one line. */
function gist(result: AgentResult) {
  if ("empty" in result) return result.why ?? "Nothing new to look at yet.";
  if ("scripts" in result) return result.scripts[0] ? `${result.scripts[0].title}: “${result.scripts[0].hook}”` : "No scripts this time.";
  if ("ideas" in result) return result.ideas[0]?.hook ?? "No ideas this time.";
  if ("leads" in result) return result.leads[0] ? `${result.leads[0].who} said “${result.leads[0].said}”` : "No one ready to buy yet.";
  if ("replies" in result) return result.replies[0] ? `To ${result.replies[0].to || "a customer"}: ${result.replies[0].draft}` : "No replies to draft.";
  return result.summary;
}

/**
 * Home: one space for the person and their agents. Everything that needs someone, in one stream (people's messages,
 * drafts waiting for a tap, agents' questions, work and results); the chosen one opens beside it with its actions.
 */
export default function Home({ state, persona }: { state: Connections; persona: Persona | null }) {
  const home = useLoad("agent", api.agent);
  const runs = useLoad("agents", api.agents);
  const inbox = useLoad("inbox", api.inbox);
  const owner = useLoad("owner-channel", api.ownerChannel).data;
  const [group, setGroup] = useState<keyof typeof groups>("all");
  const [picked, setPicked] = useState<string>();
  // On a phone the list fills the screen and a chosen row opens over it; wider, the first row is open beside the list.
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState(false);
  const ask = owner?.linked && owner.business_number ? owner.business_number : undefined;

  const rows: Row[] = [];
  const needs = home.data?.needs ?? [];
  // One conversation per person and app, newest message first, with the draft the agent left for it.
  const threads = new Map<string, InboxItem[]>();
  for (const item of inbox.data?.items ?? []) threads.set(`${item.kind}:${item.sender}`, [...threads.get(`${item.kind}:${item.sender}`) ?? [], item]);
  const drafted = new Map<string, Extract<Need, { type: "draft" }>>(needs.flatMap(n => n.type === "draft" ? [[`${n.message.kind}:${n.message.sender}`, n] as const] : []));
  for (const key of drafted.keys()) if (!threads.has(key)) threads.set(key, []);
  for (const [key, thread] of threads) {
    const need = drafted.get(key);
    const last = thread[0];
    const kind = (last?.kind ?? need?.message.kind) as InboxKind;
    const who = last ? senderName(last) : senderName(need!.message);
    const failed = last && !last.replied && last.reply_error;
    const state = need ? "Draft ready" : !last ? "" : last.replied ? "Replied" : failed ? "Not delivered" : last.transcribing ? working[last.transcribing] : last.draft ? "Draft ready" : "New";
    rows.push({
      key: `t:${key}`, group: last?.replied && !need ? "done" : last?.transcribing && !need ? "working" : "needs", who, tag: apps[kind] ?? kind, source: kind,
      preview: last ? (last.transcribing ? working[last.transcribing] : last.text) : need?.message.text ?? "", when: Math.max(last?.created ?? 0, need?.created ?? 0), state,
      pane: <Conversation key={key} who={who} kind={kind} thread={thread} need={need} />,
    });
  }
  for (const need of needs) if (need.type === "question") rows.push({
    key: `q:${need.id}`, group: "needs", who: "Your agent", tag: need.message ? `About ${senderName(need.message)}` : "Agent", agent: true,
    preview: need.question, when: need.created, state: need.ask_first ? "Asks first" : "Question",
    pane: <Pane who="Your agent" tag="Question" when={need.created} agent><Question key={need.id} need={need} onDone={() => refetch("agent")} /></Pane>,
  });
  // Agent work still going: a job on a ticket that isn't waiting on the person.
  const asked = new Set(needs.map(n => n.id));
  for (const t of home.data?.tickets ?? []) if (t.state === "open" && !asked.has(t.id)) {
    const report = lastReport(t);
    const name = jobNames[t.job] ?? "Your agent";
    rows.push({ key: `k:${t.id}`, group: "working", who: name, tag: t.message ? `For ${senderName(t.message)}` : "Agent", agent: true,
      preview: report?.text ?? "Working…", when: report?.created ?? t.created, state: "Working",
      pane: <Pane who={name} tag="Working" when={report?.created ?? t.created} agent>
        <VStack gap={2}>{t.reports.filter(r => r.kind !== "question").map((r, i) => <Text key={i} as="p" size="sm"><Text type="supporting" size="sm">{short(r.created)}</Text> {r.text}</Text>)}</VStack>
      </Pane> });
  }
  for (const run of runs.data?.runs ?? []) {
    const own = run.agent.startsWith("custom:");
    const result = run.result;
    const name = own && result ? (result as unknown as CustomResult).name : jobNames[run.agent] ?? "Your agent";
    const when = run.finished ?? run.created;
    if (run.status === "running") rows.push({ key: `r:${run.agent}`, group: "working", who: name, tag: "Agent", agent: true,
      preview: own ? "is working…" : workingOn[run.agent as AgentId], when, state: "Working",
      pane: <Pane who={name} tag="Working" when={when} agent><Text as="p" className="shimmer">{own ? "Working…" : `${name} ${workingOn[run.agent as AgentId]}`}</Text></Pane> });
    else if (run.status === "failed") rows.push({ key: `r:${run.agent}`, group: "done", who: name, tag: "Agent", agent: true,
      preview: run.error ?? "Didn't finish.", when, state: "Didn't finish",
      pane: <Pane who={name} tag="Didn't finish" when={when} agent actions={<Again run={run} ask={ask} name={name} />}><Text as="p">{run.error ?? "This run didn't finish."}</Text></Pane> });
    else if (result) rows.push({ key: `r:${run.agent}`, group: "done", who: name, tag: run.models?.length ? list(run.models) : "Agent", agent: true,
      preview: own ? (result as unknown as CustomResult).summary : gist(result), when, state: own || !thin(result) ? "Ready" : "Nothing new",
      pane: <Pane who={name} tag={run.models?.length ? `Made with ${list(run.models)}` : "Agent"} when={when} agent actions={<Again run={run} ask={ask} name={name} />}>
        {own ? <VStack gap={2}>
          <Text as="p">{(result as unknown as CustomResult).summary}</Text>
          {(result as unknown as CustomResult).drafts > 0 && <Text as="p" type="supporting" size="sm">Its drafts wait in Needs you.</Text>}
        </VStack> : <Result result={result} onLeave={() => undefined} />}
      </Pane> });
  }
  rows.sort((a, b) => b.when - a.when);
  const counts = { all: rows.length, needs: 0, working: 0, done: 0 };
  for (const r of rows) counts[r.group]++;
  const shown = rows.filter(r => group === "all" || r.group === group);
  const current = numbers ? undefined : shown.find(r => r.key === picked) ?? shown[0];
  const loading = (!home.data && !home.error) || (!runs.data && !runs.error) || (!inbox.data && !inbox.error);
  const failed = [home, runs, inbox].find(l => l.error && !l.data)?.error;

  // A calm hand-off between rows; none with reduced motion or without View Transitions.
  const go = (change: () => void) => {
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
    document.startViewTransition(() => flushSync(change));
  };
  const pick = (key: string) => go(() => { setPicked(key); setNumbers(false); setOpen(true); });
  const back = () => go(() => setOpen(false));

  return (
    <div className="page home">
      <div className="space" data-open={open || numbers || undefined}>
        <nav aria-label="Show" className="space-filters">
          {(Object.keys(groups) as (keyof typeof groups)[]).map(g => (
            <button key={g} type="button" className="space-filter" aria-pressed={group === g && !numbers}
              onClick={() => { setGroup(g); setNumbers(false); setOpen(false); }}>
              {groups[g]}{counts[g] > 0 && <span className="space-filter-count">{counts[g]}</span>}
            </button>
          ))}
          <button type="button" className="space-filter" aria-pressed={numbers} onClick={() => go(() => { setNumbers(true); setOpen(true); })}>Your numbers</button>
        </nav>
        <section aria-labelledby="space-heading" className="space-list">
          <VStack gap={1} className="space-head">
            <Heading level={1} id="space-heading" tabIndex={-1}>{numbers ? "Home" : groups[group]}</Heading>
            {home.data ? <Status data={home.data} state={state} /> : <Text as="p" type="supporting" size="sm" className="status-line status-wait" aria-hidden>{" "}</Text>}
          </VStack>
          {failed && <VStack gap={2}><Text as="p" type="supporting">{failed.message}</Text><HStack><Button size="sm" label="Try again" clickAction={() => Promise.all([home.reload(), runs.reload(), inbox.reload()]).then(() => undefined)} /></HStack></VStack>}
          {shown.length ? (
            <ul className="space-rows">
              {shown.map(r => (
                <li key={r.key}>
                  <button type="button" className="space-row" aria-current={r === current || undefined} onClick={() => pick(r.key)}>
                    <Face row={r} />
                    <span className="space-row-who">{r.who}</span>
                    <span className="space-row-when">{r.when ? short(r.when) : ""}</span>
                    <span className="space-row-text">{r.preview}</span>
                    <span className="space-row-meta"><span>{r.tag}</span>{r.state && <span data-state={r.state}>{(r.state === "Replied" || r.state === "Ready") && <Check />}{r.state}</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : loading ? <Center minHeight={96}><Spinner aria-label="Loading" /></Center>
            : <Text as="p" type="supporting" className="space-empty">{empty(group, home.data)}</Text>}
        </section>
        <section aria-label={numbers ? "Your numbers" : current ? current.who : "Nothing open"} className="space-detail">
          <div className="space-back"><Button variant="ghost" size="sm" label="Back" onClick={back} /></div>
          {numbers ? <Suspense fallback={null}><Numbers state={state} /></Suspense>
            : current ? current.pane
            : <Center minHeight={160}><Text type="supporting">{loading ? "" : "Pick something from the list to open it here."}</Text></Center>}
        </section>
      </div>
      {sample && persona && <Suspense fallback={null}><SamplePhone persona={persona} /></Suspense>}
    </div>
  );
}

/** What an empty list says, true to why it's empty. */
function empty(group: keyof typeof groups, data?: AgentHome) {
  if (group === "working") return "No agent is working right now.";
  if (group === "done") return "Nothing finished yet.";
  if (group === "needs") return data && !data.proactive ? "Nothing waits for you. Drafting on new messages is off in Settings." : "Nothing waits for you. New messages get a draft here within a minute.";
  return "Nothing here yet. Messages and your agents' work show up here as they arrive.";
}

/** A person by their initials with the app they wrote on; an agent by Stupid's mark. */
function Face({ row }: { row: Row }) {
  return (
    <span className="space-face" aria-hidden>
      {row.agent ? <span className="space-agent"><Logo size={20} /></span> : <Avatar name={row.who} size={36} tooltip={false} />}
      {row.source && <span className="space-app"><SourceIcon source={row.source} size={12} /></span>}
    </span>
  );
}

/** The open item: who it's from, then its content, then what can be done with it. */
function Pane({ who, tag, when, agent, source, actions, children }: { who: string; tag: string; when: number; agent?: boolean; source?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <VStack gap={5}>
      <HStack gap={3} align="center">
        <Face row={{ who, agent, source } as Row} />
        <VStack gap={0}>
          <Text weight="semibold">{who}</Text>
          <Text type="supporting" size="sm">{tag}{when ? ` · ${ago(when)}` : ""}</Text>
        </VStack>
      </HStack>
      {children}
      {actions && <HStack gap={2} wrap="wrap">{actions}</HStack>}
    </VStack>
  );
}

/** Run an agent again, or ask it about this on the owner's own chat with it. */
function Again({ run, ask, name }: { run: AgentRun; ask?: string; name: string }) {
  const [error, setError] = useState("");
  const again = () => (run.agent.startsWith("custom:") ? api.runAgent(Number(run.agent.slice(7))) : api.run(run.agent as AgentId))
    .then(() => refetch("agents"), (cause: unknown) => setError(message(cause)));
  return <>
    <Button size="sm" label="Run again" clickAction={again} />
    {ask && <Button variant="ghost" size="sm" label="Ask your agent" href={chatUrl(ask, `About ${name}: `)} target="_blank" rel="noopener noreferrer" />}
    {error && <Text as="p" size="sm" role="alert">{error}</Text>}
  </>;
}

/** A person's conversation, oldest first, with the agent's draft ready to send, change or write from scratch. */
function Conversation({ who, kind, thread, need }: { who: string; kind: InboxKind; thread: InboxItem[]; need?: Extract<Need, { type: "draft" }> }) {
  const last = thread[0];
  const draft = need?.text ?? (last && !last.replied ? last.draft?.text : undefined);
  const [text, setText] = useState(draft ?? "");
  const [editing, setEditing] = useState(!draft);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const id = need?.event_id ?? last?.id;
  const canReply = id && last ? !last.replied && !sent : Boolean(need) && !sent;
  // The tap on Send is the person's approval; nothing goes out before it.
  const send = () => api.reply(id!, text.trim()).then(() => { setSent(true); refetch("inbox"); refetch("agent"); }, (cause: unknown) => setError(message(cause)));
  const kept = need ?? last?.draft ?? undefined;
  const failed = last && !last.replied && !sent ? last.reply_error : undefined;
  return (
    <Pane who={who} tag={apps[kind] ?? kind} when={last?.created ?? need?.created ?? 0} source={kind}>
      <VStack gap={2}>
        {(thread.length ? [...thread].reverse() : [{ id: need!.event_id, text: need!.message.text ?? "", replied: false } as InboxItem]).map(m => <VStack key={m.id} gap={2}>
          <div className="bubble"><Text as="p">{m.transcribing ? working[m.transcribing] : m.text}</Text></div>
          {sample && m.photo && <Suspense fallback={null}><SamplePhoto id={m.id} /></Suspense>}
          {m.replied && m.reply_text && <div className="bubble bubble-mine"><Text as="p">{m.reply_text}</Text></div>}
        </VStack>)}
        {sent && <VStack gap={1} hAlign="end"><div className="bubble bubble-mine"><Text as="p">{text}</Text></div><Text size="sm" type="supporting"><Check /> Sent</Text></VStack>}
      </VStack>
      {failed && <Text as="p" size="sm" className="space-warn">Your last reply didn't arrive: {failed}</Text>}
      {canReply && <VStack gap={3}>
        {draft && !editing && <VStack gap={2}>
          <Text type="supporting" size="sm">{kept?.source === "muse" ? "From Muse · check before sending" : "Your agent's draft · check before sending"}</Text>
          <div className="bubble bubble-out"><Text as="p">{text}</Text></div>
          {need && <Trace voice={need.message.voice ? need.message.voice.model ?? need.models?.described_by ?? null : undefined}
            photo={need.message.photo ? need.message.photo.model ?? need.models?.described_by ?? null : undefined}
            drafted={need.models?.drafted_by} match={need.matched_post} used={need.used} styled={need.styled} source={need.source} />}
        </VStack>}
        {editing && <TextArea label={`Reply to ${who}`} value={text} onChange={v => { setText(v); setError(""); }} rows={4} maxLength={1000} hasAutoFocus={Boolean(draft)}
          description={kind === "instagram_comment" ? "Replies publicly under the comment." : "Meta allows replies within 24 hours of their last message."} />}
        <HStack gap={2}>
          <Button variant="primary" size="sm" label={sample ? sampleSend : "Send"} isDisabled={sample || !text.trim()} clickAction={send} />
          {draft && !editing && <Button variant="ghost" size="sm" label="Edit" onClick={() => setEditing(true)} />}
        </HStack>
        <div aria-live="polite">{error && <Text as="p" size="sm">{error}</Text>}</div>
      </VStack>}
    </Pane>
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

function Question({ need, onDone }: { need: Extract<Need, { type: "question" }>; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const send = (skip: boolean, answer = text.trim()) => api.answer(need.id, answer, skip).then(onDone, (cause: unknown) => setError(message(cause)));
  const head = <>
    {need.message?.text && <div className="bubble"><Text as="p">{need.message.text}</Text></div>}
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
