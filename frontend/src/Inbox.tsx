import { useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { api, drafts, senderName, useLoad } from "./api";
import type { InboxItem } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal, Page } from "./Surface";

const filters = { all: "All", messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" } as const;
const where = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram DM", instagram_comment: "Instagram comment" } as const;
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
    <Page title="Inbox" description="Every new message and comment in one place, newest first."
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
          <div className="inset-list">
            <List density="balanced">
              {shown.map(item => {
                const label = mark(item);
                const tag = item.replied ? <Token size="sm" label="Replied" />
                  : label ? <Token size="sm" label={label} />
                  : item.reply_error ? <Token size="sm" color="red" label="Not delivered" />
                  : null;
                return (
                  <ListItem key={item.id} align="start" isSelected={open === item.id} onClick={() => setOpen(item.id)}
                    startContent={<Avatar name={senderName(item)} size="md" tooltip={false} aria-hidden status={<SourceIcon source={item.kind} size={14} />} />}
                    label={<HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{senderName(item)}</Text><Text type="supporting" size="sm">{where[item.kind]}</Text></HStack>}
                    description={<Text type="supporting" maxLines={1}>{item.text}</Text>}
                    endContent={<VStack gap={1} hAlign="end"><Timestamp value={item.created} format="relative" type="supporting" size="sm" />{tag}</VStack>} />
                );
              })}
            </List>
          </div>
        );
      }}</Load>
      {current && <Conversation key={current.id} item={current} mark={mark(current)} onClose={() => setOpen(undefined)}
        onStatus={label => { setMark(current.id, label); if (label === "Sent") setOpen(undefined); }} />}
    </Page>
  );
}

function Conversation({ item, mark, onClose, onStatus }: { item: InboxItem; mark?: Mark; onClose: () => void; onStatus: (label?: Mark) => void }) {
  const [draft] = useState(() => drafts.get(item.id));
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
      subtitle={<HStack gap={2} align="center"><SourceIcon source={item.kind} size={14} />{where[item.kind]} · <Timestamp value={item.created} format="relative" /></HStack>}
      footer={canReply ? <>
        <Button variant="ghost" label="Close" onClick={close} />
        <Button variant="primary" label="Send" isDisabled={!text.trim()} isLoading={sending} onClick={() => void send()} />
      </> : <Button label="Close" onClick={close} />}>
      <div className="bubble"><Text as="p">{item.text}</Text></div>
      {item.replied && <Text as="p" type="supporting">You've replied to this one.</Text>}
      {failed && <Banner status="warning" title="Your reply didn't arrive" description={`${failed} You can try again below.`} />}
      {canReply && draft?.source === "agent" && <HStack><Token size="sm" label="Drafted by AI · check before sending" /></HStack>}
      {canReply && (
        <TextArea label={`Reply to ${senderName(item)}`} value={text} onChange={v => { setText(v); setError(""); }}
          rows={4} maxLength={1000} hasAutoFocus status={error ? { type: "error", message: error } : undefined}
          description={item.kind === "instagram_comment" ? "Replies publicly under the comment." : "Meta allows replies within 24 hours of their last message."} />
      )}
    </Modal>
  );
}
