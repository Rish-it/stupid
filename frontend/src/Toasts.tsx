import { useEffect, useRef } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { api, senderName, useLoad } from "./api";
import type { InboxKind } from "./api";

const what: Record<InboxKind, string> = { whatsapp: "WhatsApp message", messenger: "Messenger message", instagram: "Instagram message", instagram_comment: "Instagram comment" };

/**
 * A small note when the live stream brings something new: a message, a draft waiting for a tap, or something the
 * agent learned from the owner's answer (in the app or on WhatsApp).
 * The first look only remembers what is there; nothing is announced for it. No browser notifications.
 */
export default function Toasts() {
  const toast = useToast();
  const inbox = useLoad("inbox", api.inbox).data?.items;
  const home = useLoad("agent", api.agent).data;
  const needs = home?.needs;
  const facts = home?.facts;
  const seen = useRef<{ messages?: Set<string>; drafts?: Set<string>; facts?: Set<number> }>({});
  useEffect(() => {
    if (!inbox) return;
    const before = seen.current.messages;
    seen.current.messages = new Set(inbox.map(i => i.id));
    if (before) for (const i of inbox) if (!before.has(i.id) && !i.replied) toast({ body: `New ${what[i.kind]} from ${senderName(i)}` });
  }, [inbox, toast]);
  useEffect(() => {
    if (!needs) return;
    const drafts = needs.flatMap(n => n.type === "draft" ? [n] : []);
    const before = seen.current.drafts;
    seen.current.drafts = new Set(drafts.map(d => d.event_id));
    if (before) for (const d of drafts) if (!before.has(d.event_id)) toast({ body: `Draft ready for ${senderName(d.message)}` });
  }, [needs, toast]);
  useEffect(() => {
    if (!facts) return;
    const before = seen.current.facts;
    seen.current.facts = new Set(facts.map(f => f.id));
    if (before) for (const f of facts) if (!before.has(f.id)) toast({ body: `Learned: ${f.answer}` });
  }, [facts, toast]);
  return null;
}
