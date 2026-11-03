import { Fragment, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
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

const filters = { all: "All", messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" } as const;
const where = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram DM", instagram_comment: "Instagram comment" } as const;

export default function Inbox() {
  const inbox = useLoad("inbox", api.inbox);
  const [filter, setFilter] = useState<keyof typeof filters>("all");
  const [open, setOpen] = useState(() => [...drafts.keys()].at(-1));
  // What this screen knows about a reply before the server does. It lasts until the inbox is fetched again,
  // when the item's own `replied` or `reply_error` takes over.
  const [marks, setMarks] = useState<Record<string, { label: "Sending…" | "Sent"; items: InboxItem[] }>>({});
  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={1}>Inbox</Heading>
        <Text as="p" type="supporting">Every new message and comment in one place, newest first.</Text>
      </VStack>
      <SegmentedControl label="Show messages from" value={filter} onChange={v => setFilter(v as keyof typeof filters)} layout="fill">
        {Object.entries(filters).map(([value, label]) => value === "all"
          ? <SegmentedControlItem key={value} value={value} label={label} />
          : <SegmentedControlItem key={value} value={value} label={label} isLabelHidden icon={<SourceIcon source={value} />} />)}
      </SegmentedControl>
      <Load state={inbox}>{({ items }) => {
        const shown = items.filter(i => filter === "all" || i.kind.startsWith(filter));
        if (!shown.length) return <Text as="p" type="supporting">{items.length ? `Nothing from ${filters[filter]} yet.` : "No messages yet. New ones show up here as they arrive."}</Text>;
        return (
          <List density="spacious">
            {shown.map(item => {
              const mark = marks[item.id]?.items === items ? marks[item.id].label : undefined;
              const failed = !item.replied && !mark && item.reply_error;
              const tag = item.replied ? "Replied" : mark;
              const status = (label?: "Sending…" | "Sent") => setMarks(m => {
                const next = { ...m };
                if (label) next[item.id] = { label, items };
                else delete next[item.id];
                return next;
              });
              return (
              <Fragment key={item.id}>
                <ListItem align="start" isSelected={open === item.id} onClick={item.replied ? undefined : () => setOpen(open === item.id ? undefined : item.id)}
                  startContent={<SourceIcon source={item.kind} />}
                  label={<HStack gap={2} wrap="wrap"><Text weight="semibold">{senderName(item)}</Text><Text type="supporting">{where[item.kind]}</Text></HStack>}
                  description={item.text}
                  endContent={<VStack gap={1} hAlign="end"><Timestamp value={item.created} format="relative" type="supporting" />{tag && <Token size="sm" label={tag} />}</VStack>} />
                {(open === item.id || item.reply_error) && !item.replied && mark !== "Sent" && <Reply item={item} failed={failed || undefined} onStatus={label => {
                  status(label);
                  if (label === "Sent") setOpen(undefined);
                }} />}
              </Fragment>
              );
            })}
          </List>
        );
      }}</Load>
    </VStack>
  );
}

function Reply({ item, failed, onStatus }: { item: InboxItem; failed?: string; onStatus: (label?: "Sending…" | "Sent") => void }) {
  const [text, setText] = useState(() => drafts.get(item.id) ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
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
  return (
    <VStack as="li" gap={2} paddingInlineStart={10} paddingBlockEnd={4}>
      {failed && <Banner status="warning" title="Your reply didn't arrive" description={`${failed} You can try again below.`} />}
      <TextArea label={`Reply to ${senderName(item)}`} value={text} onChange={v => { setText(v); setError(""); }}
        rows={3} maxLength={1000} hasAutoFocus status={error ? { type: "error", message: error } : undefined} />
      <HStack gap={2}>
        <Button variant="primary" label="Send" isDisabled={!text.trim()} isLoading={sending} onClick={() => void send()} />
      </HStack>
    </VStack>
  );
}
