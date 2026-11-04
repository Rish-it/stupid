import { useEffect, useState } from "react";
import type { FocusEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { ago, api, drafts, sample, sampleSend, senderName, useLoad } from "./api";
import type { InboxItem } from "./api";
import { Check } from "./Icons";
import Match from "./Match";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal, Page } from "./Surface";
import MetaProblem from "./MetaProblem";

const filters = { all: "All", messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" } as const;
const where = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram DM", instagram_comment: "Instagram comment" } as const;
const working = { voice: "Transcribing the voice note…", photo: "Looking at the photo…", video: "Watching the video…" } as const;
type Mark = "Sending…" | "Sent";

export default function Inbox() {
  const inbox = useLoad("inbox", api.inbox);
  const [filter, setFilter] = useState<keyof typeof filters>("all");
  const [open, setOpen] = useState(() => [...drafts.keys()].at(-1));
  // The person whose recent messages show in a popover: on hover, on focus, or from the corner's button.
  const [peek, setPeek] = useState<string>();
  // Escape closes it, wherever focus is (a hover opens it without moving focus).
  useEffect(() => {
    if (!peek) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPeek(undefined); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [peek]);
  // What this screen knows about a reply before the server does. It lasts until the inbox is fetched again,
  // when the item's own `replied` or `reply_error` takes over.
  const [marks, setMarks] = useState<Record<string, { label: Mark; items: InboxItem[] }>>({});
  const items = inbox.data?.items;
  const mark = (item: InboxItem) => marks[item.id]?.items === items ? marks[item.id].label : undefined;
  const setMark = (id: string, label?: Mark) => setMarks(m => {
    const next = { ...m };
    if (label && items) next[id] = { label, items };
    else delete next[id];
    return next;
  });
  const current = items?.find(i => i.id === open);
  // Only the apps this inbox actually has messages from get a filter.
  const apps = (Object.keys(filters) as (keyof typeof filters)[]).filter(k => k === "all" || items?.some(i => i.kind.startsWith(k)));
  // Closing a thread puts focus back on its card, even when it was opened from Home.
  const close = (id: string) => {
    setOpen(undefined);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.person[data-id="${id}"]`)?.focus());
  };

  return (
    <Page title="Inbox" description="Every message and comment, newest first. Open one to reply."
      actions={apps.length > 2 &&
        <SegmentedControl label="Show messages from" value={filter} onChange={v => setFilter(v as keyof typeof filters)}>
          {apps.map(value => value === "all"
            ? <SegmentedControlItem key={value} value={value} label={filters[value]} />
            : <SegmentedControlItem key={value} value={value} label={filters[value]} isLabelHidden icon={<SourceIcon source={value} size={16} />} />)}
        </SegmentedControl>
      }>
      <Load state={inbox}>{({ items }) => {
        const shown = items.filter(i => filter === "all" || i.kind.startsWith(filter));
        if (!shown.length) return (
          <EmptyState headingLevel={2} title={items.length ? `Nothing from ${filters[filter]} yet` : "No messages yet"}
            description="New messages and comments show up here as they arrive." />
        );
        // One card per person: their newest message on the card, the rest in its popover.
        const threads = new Map<string, InboxItem[]>();
        for (const i of shown) threads.set(`${i.kind}:${i.sender}`, [...threads.get(`${i.kind}:${i.sender}`) ?? [], i]);
        const people = [...threads.values()];
        return (
          <ul className="people">
            {people.map(thread => {
              const item = thread[0];
              const label = mark(item);
              const status = item.replied ? "Replied" : label ?? (item.reply_error ? "Not delivered" : item.draft ? "Draft ready" : undefined);
              const note = noteLabel(item);
              const name = senderName(item);
              const peeking = peek === item.id;
              const leave = (event: FocusEvent<HTMLLIElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setPeek(undefined); };
              return (
                <li key={item.id} className="person-card" data-peek={peeking || undefined}
                  onMouseEnter={() => setPeek(item.id)} onMouseLeave={() => setPeek(undefined)} onBlur={leave}>
                  <button type="button" className="person" data-id={item.id} onClick={() => setOpen(item.id)} onFocus={() => setPeek(item.id)}
                    aria-describedby={peeking ? `history-${item.id}` : undefined}>
                    <span className="kind">{where[item.kind]}{thread.length > 1 ? ` · ${thread.length} messages` : ""}</span>
                    <span className="person-text">{item.transcribing ? working[item.transcribing] : item.text}</span>
                    <span className="person-foot">
                      <strong>{name}</strong>
                      <span className="person-meta">{note && <span>{note}</span>}<span>{ago(item.created)}</span>{status && <span data-status={status}>{(status === "Sent" || status === "Replied") && <Check />}{status}</span>}</span>
                    </span>
                  </button>
                  <span className="corner">
                    <button type="button" className="corner-button" aria-label={`Recent messages from ${name}`} aria-expanded={peeking} aria-controls={`history-${item.id}`}
                      onClick={() => setPeek(peeking ? undefined : item.id)}><HistoryGlyph /></button>
                    <button type="button" className="corner-button" aria-label={`Open the thread with ${name}`} onClick={() => setOpen(item.id)}><OpenGlyph /></button>
                  </span>
                  {peeking && <History id={`history-${item.id}`} name={name} thread={thread} />}
                </li>
              );
            })}
          </ul>
        );
      }}</Load>
      {current && <Conversation key={current.id} item={current} mark={mark(current)} onClose={() => close(current.id)}
        onStatus={label => { setMark(current.id, label); if (label === "Sent") close(current.id); }} />}
    </Page>
  );
}

/** A person's recent messages, oldest first, from the inbox they're already in. */
function History({ id, name, thread }: { id: string; name: string; thread: InboxItem[] }) {
  const recent = thread.slice(0, 5).reverse();
  return (
    <div id={id} role="region" aria-label={`Recent messages from ${name}`} className="history">
      <ol>
        {recent.map(m => (
          <li key={m.id}>
            <span className="history-text">{m.transcribing ? working[m.transcribing] : m.text}</span>
            <span className="history-meta">{ago(m.created)}{m.replied ? " · you replied" : ""}</span>
          </li>
        ))}
      </ol>
      {thread.length === 1 && <p className="history-meta">No earlier messages from {name}.</p>}
    </div>
  );
}

const glyph = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const HistoryGlyph = () => <svg {...glyph}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>;
const OpenGlyph = () => <svg {...glyph}><path d="M7 17 17 7M8 7h9v9" /></svg>;

/** Voice notes say so, since their text is a transcript by Muse Voice Transcribe; photos and videos say while they're being looked at. */
function noteLabel(item: InboxItem) {
  if (item.transcribing === "photo" || item.transcribing === "video") return item.transcribing === "photo" ? "Photo · looking" : "Video · watching";
  if (!item.voice && !item.transcribing) return undefined;
  return item.transcribing ? "Voice note · transcribing" : "Voice note · transcript";
}

function Conversation({ item, mark, onClose, onStatus }: { item: InboxItem; mark?: Mark; onClose: () => void; onStatus: (label?: Mark) => void }) {
  // A draft handed over in this tab first, else the newest one Stupid keeps (from the agent or Muse).
  const [draft] = useState(() => drafts.get(item.id) ?? (item.draft && !item.replied ? { text: item.draft.text, source: item.draft.source === "muse" ? "muse" as const : "agent" as const } : undefined));
  const [text, setText] = useState(draft?.text ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const failed = !item.replied && !mark && item.reply_error;
  const canReply = !item.replied && mark !== "Sent";
  // A plain click, not clickAction: an action's transition would hold "Sending…" back until the send is over.
  const send = async () => {
    setSending(true);
    onStatus("Sending…");
    try {
      await api.reply(item.id, text.trim());
      drafts.delete(item.id);
      onStatus("Sent");
    } catch (cause) {
      onStatus();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setSending(false);
  };
  const close = () => { if (text.trim()) drafts.set(item.id, { ...draft, text }); onClose(); };
  return (
    <Modal isOpen onClose={close} purpose="form" title={senderName(item)}
      subtitle={<HStack gap={2} align="center"><SourceIcon source={item.kind} size={14} />{where[item.kind]} · {ago(item.created)}</HStack>}
      footer={canReply ? <>
        <Button variant="ghost" label="Close" onClick={close} />
        <Button variant="primary" label={sample ? sampleSend : "Send"} isDisabled={sample || !text.trim()} isLoading={sending} onClick={() => void send()} />
      </> : <Button label="Close" onClick={close} />}>
      {noteLabel(item) && <HStack><Token size="sm" label={noteLabel(item)!} /></HStack>}
      <div className="bubble"><Text as="p">{item.transcribing ? working[item.transcribing] : item.text}</Text></div>
      {item.matched_post && <Match post={item.matched_post} />}
      {item.replied && <Text as="p" type="supporting">You've replied to this one.</Text>}
      {failed && <MetaProblem issue={failed} kind={item.kind} title="Your reply didn't arrive" />}
      {error && <MetaProblem issue={error} kind={item.kind} />}
      {canReply && draft?.source && <HStack><Token size="sm" label={draft.source === "muse" ? "From Muse · check before sending" : "Drafted by AI · check before sending"} /></HStack>}
      {canReply && (
        <TextArea label={`Reply to ${senderName(item)}`} value={text} onChange={v => { setText(v); setError(""); }}
          rows={4} maxLength={1000} hasAutoFocus status={error ? { type: "error", message: error } : undefined}
          description={item.kind === "instagram_comment" ? "Replies publicly under the comment." : "Meta allows replies within 24 hours of their last message."} />
      )}
    </Modal>
  );
}
