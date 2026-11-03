import { Fragment, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { api, drafts, useLoad } from "./api";
import type { InboxItem } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";

const filters = { all: "All", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" } as const;
const where = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram DM", instagram_comment: "Instagram comment" } as const;

export default function Inbox() {
  const inbox = useLoad("inbox", api.inbox);
  const [filter, setFilter] = useState<keyof typeof filters>("all");
  const [open, setOpen] = useState(() => [...drafts.keys()].at(-1));
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
            {shown.map(item => (
              <Fragment key={item.id}>
                <ListItem align="start" isSelected={open === item.id} onClick={item.replied ? undefined : () => setOpen(open === item.id ? undefined : item.id)}
                  startContent={<SourceIcon source={item.kind === "instagram_comment" ? "instagram" : item.kind} />}
                  label={<HStack gap={2} wrap="wrap"><Text weight="semibold">{item.sender}</Text><Text type="supporting">{where[item.kind]}</Text></HStack>}
                  description={item.text}
                  endContent={<VStack gap={1} hAlign="end"><Timestamp value={item.created} format="relative_short" />{item.replied && <Text type="supporting">Replied</Text>}</VStack>} />
                {open === item.id && !item.replied && <Reply item={item} onSent={() => {
                  inbox.setData({ items: items.map(i => i.id === item.id ? { ...i, replied: true } : i) });
                  setOpen(undefined);
                }} />}
              </Fragment>
            ))}
          </List>
        );
      }}</Load>
    </VStack>
  );
}

function Reply({ item, onSent }: { item: InboxItem; onSent: () => void }) {
  const [text, setText] = useState(() => drafts.get(item.id) ?? "");
  const [error, setError] = useState("");
  const send = async () => {
    try {
      await api.reply(item.id, text.trim());
      drafts.delete(item.id);
      onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <VStack as="li" gap={2} paddingInlineStart={10} paddingBlockEnd={4}>
      <TextArea label={`Reply to ${item.sender}`} value={text} onChange={v => { setText(v); setError(""); }}
        rows={3} maxLength={1000} hasAutoFocus status={error ? { type: "error", message: error } : undefined} />
      <HStack gap={2}>
        <Button variant="primary" label="Send" isDisabled={!text.trim()} clickAction={send} />
      </HStack>
    </VStack>
  );
}
