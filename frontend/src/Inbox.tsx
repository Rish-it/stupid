import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { ago, api, drafts, senderName, useLoad } from "./api";
import type { InboxItem } from "./api";
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

  return (
    <Page title="Inbox" description="Every message and comment, newest first. Open one to reply."
      actions={
        <SegmentedControl label="Show messages from" value={filter} onChange={v => setFilter(v as keyof typeof filters)}>
          {Object.entries(filters).map(([value, label]) => value === "all"
            ? <SegmentedControlItem key={value} value={value} label={label} />
            : <SegmentedControlItem key={value} value={value} label={label} isLabelHidden icon={<SourceIcon source={value} size={16} />} />)}
        </SegmentedControl>
      }>
      <Load state={inbox}>{({ items }) => {
        const shown = items.filter(i => filter === "all" || i.kind.startsWith(filter));
        if (!shown.length) return (
          <EmptyState headingLevel={2} title={items.length ? `Nothing from ${filters[filter]} yet` : "No messages yet"}
            description="New messages and comments show up here as they arrive." />
        );
        return (
          <ul className="people">
            {shown.map(item => {
              const label = mark(item);
              const status = item.replied ? "Replied" : label ?? (item.reply_error ? "Not delivered" : item.draft ? "Draft ready" : undefined);
              const note = noteLabel(item);
              return (
                <li key={item.id}>
                  <button type="button" className="person" data-app={item.kind.startsWith("instagram") ? "instagram" : item.kind} onClick={() => setOpen(item.id)}>
                    <span className="kind">{where[item.kind]}</span>
                    <span className="person-text">{item.transcribing ? working[item.transcribing] : item.text}</span>
                    <span className="person-foot">
                      <strong>{senderName(item)}</strong>
                      <span className="person-meta">{note && <span>{note}</span>}<span>{ago(item.created)}</span>{status && <span data-status={status}>{status}</span>}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        );
      }}</Load>
      {current && <Conversation key={current.id} item={current} mark={mark(current)} onClose={() => setOpen(undefined)}
        onStatus={label => { setMark(current.id, label); if (label === "Sent") setOpen(undefined); }} />}
    </Page>
  );
}

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
        <Button variant="primary" label="Send" isDisabled={!text.trim()} isLoading={sending} onClick={() => void send()} />
      </> : <Button label="Close" onClick={close} />}>
      {noteLabel(item) && <HStack><Token size="sm" label={noteLabel(item)!} /></HStack>}
      <div className="bubble"><Text as="p">{item.transcribing ? working[item.transcribing] : item.text}</Text></div>
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
