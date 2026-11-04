import { useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { api, drafts, jobNames, lastReport, senderName, useLoad } from "./api";
import type { AgentHome, Need, Ticket } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal } from "./Surface";

type Question = Extract<Need, { type: "question" }>;

/** The person's own words for a ticket: who it was for, or which job ran. */
const who = (t: Pick<Ticket, "job" | "message">) => t.message ? senderName(t.message) : jobNames[t.job] ?? t.job;
const marks: Partial<Record<string, { label: string; color?: "green" | "red" | "yellow" | "blue" }>> = {
  progress: { label: "Working", color: "blue" }, waiting: { label: "Needs you" }, ready: { label: "Ready", color: "green" },
  blocked: { label: "Stopped", color: "yellow" }, failed: { label: "Didn't finish", color: "red" },
};
export function ReportMark({ kind }: { kind?: string }) {
  const mark = kind ? marks[kind] : undefined;
  return mark ? <Token size="sm" label={mark.label} color={mark.color} /> : null;
}

/**
 * The agent's home on Today: what waits for the person first, then what the agent did. "Needs you" takes no space
 * when nothing waits. A draft opens the Inbox reply box, prefilled and marked as AI; a question opens one field.
 */
export default function Attention() {
  const home = useLoad("agent", api.agent);
  const [asking, setAsking] = useState<Question>();
  return (
    <VStack gap={6}>
      {home.data && <NeedsYou needs={home.data.needs} onAsk={setAsking} />}
      <section aria-labelledby="did-heading">
        <VStack gap={3}>
          <Heading level={2} id="did-heading">What I did</Heading>
          <Load state={home}>{data => <WhatIDid data={data} />}</Load>
        </VStack>
      </section>
      {asking && <Answer question={asking} onClose={() => setAsking(undefined)} onDone={() => { setAsking(undefined); void home.reload(); }} />}
    </VStack>
  );
}

function NeedsYou({ needs, onAsk }: { needs: Need[]; onAsk: (q: Question) => void }) {
  if (!needs.length) return null;
  return (
    <section aria-labelledby="needs-heading">
      <VStack gap={3}>
        <HStack gap={2} align="center"><Heading level={2} id="needs-heading">Needs you</Heading><Text type="supporting" hasTabularNumbers>{needs.length}</Text></HStack>
        <div className="inset-list">
          <List density="balanced">
            {needs.map(n => n.type === "draft" ? (
              <ListItem key={`d${n.id}`} align="start" onClick={() => { drafts.set(n.event_id, { text: n.text, source: n.source === "muse" ? "muse" : "agent" }); location.hash = "#inbox"; }}
                startContent={<Avatar name={senderName(n.message)} size="md" tooltip={false} aria-hidden status={<SourceIcon source={n.message.kind} size={14} />} />}
                label={<HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">Reply to {senderName(n.message)}</Text><Token size="sm" label={n.source === "muse" ? "From Muse" : "Drafted by AI"} /></HStack>}
                description={<VStack gap={1}><Text type="supporting" maxLines={1}>“{n.message.text}”</Text><Text maxLines={2}>{n.text}</Text></VStack>}
                endContent={<Timestamp value={n.created} format="relative" type="supporting" size="sm" />} />
            ) : (
              <ListItem key={`q${n.id}`} align="start" onClick={() => onAsk(n)}
                startContent={n.message ? <Avatar name={senderName(n.message)} size="md" tooltip={false} aria-hidden status={<SourceIcon source={n.message.kind} size={14} />} /> : undefined}
                label={<HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{n.message ? `About ${senderName(n.message)}` : "A question"}</Text><Token size="sm" label="Question" /></HStack>}
                description={<Text maxLines={2}>{n.question}</Text>}
                endContent={<Timestamp value={n.created} format="relative" type="supporting" size="sm" />} />
            ))}
          </List>
        </div>
      </VStack>
    </section>
  );
}

function WhatIDid({ data }: { data: AgentHome }) {
  if (!data.tickets.length) return (
    <Text as="p" type="supporting">
      {data.proactive ? "I'm waiting for the first new message. When one arrives I'll draft a reply for you to check." : "Drafting on new messages is off in Settings. Run an agent to give me work."}
    </Text>
  );
  return (
    <VStack gap={3} as="ul">
      {data.tickets.slice(0, 8).map(t => {
        const last = lastReport(t);
        return (
          <HStack key={t.id} as="li" gap={3} align="start">
            <SourceIcon source={t.message?.kind ?? (t.job === "ads" ? "ads" : t.job === "ideas" ? "instagram" : "chat")} size={16} />
            <VStack gap={0} width="100%">
              <HStack gap={2} align="center" wrap="wrap">
                <Text weight="semibold" size="sm">{who(t)}</Text>
                <ReportMark kind={last?.kind} />
                <Timestamp value={last?.created ?? t.created} format="relative" type="supporting" size="sm" />
              </HStack>
              <Text as="p" type="supporting" size="sm" maxLines={2}>{last?.text}</Text>
            </VStack>
          </HStack>
        );
      })}
    </VStack>
  );
}

function Answer({ question, onClose, onDone }: { question: Question; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const send = (skip: boolean) => api.answer(question.id, text.trim(), skip).then(onDone, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  return (
    <Modal isOpen onClose={onClose} purpose="form" title="The agent asks" subtitle={question.message ? `While drafting a reply to ${senderName(question.message)}` : undefined}
      footer={<>
        <Button variant="ghost" label="Skip" clickAction={() => send(true)} />
        <Button variant="primary" label="Answer" isDisabled={!text.trim()} clickAction={() => send(false)} />
      </>}>
      {question.message?.text && <div className="bubble"><Text as="p">{question.message.text}</Text></div>}
      <Text as="p" weight="semibold">{question.question}</Text>
      <TextArea label="Your answer" value={text} onChange={v => { setText(v); setError(""); }} rows={3} maxLength={1000} hasAutoFocus
        status={error ? { type: "error", message: error } : undefined} description="The agent uses it to finish the draft. Nothing is sent." />
    </Modal>
  );
}
