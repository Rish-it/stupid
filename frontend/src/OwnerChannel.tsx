import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ApiError, api, refetch, useLoad } from "./api";
import type { OwnerChannel, Urgent } from "./api";
import { Load } from "./Load";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const urgent: [Urgent, string][] = [["big_order", "Big orders"], ["complaint", "Complaints"], ["brand_deal", "Brand deals"], ["payment", "Payment problems"], ["question", "Questions only I can answer"]];
/** Only the last four digits show; the rest of the number stays off screen. */
const masked = (phone: string) => `•••• ${phone.slice(-4)}`;
/** The chat to open on the owner's phone: the business number with "hi <code>" typed in. */
const linkUrl = (oc: OwnerChannel) => oc.business_number ? `https://wa.me/${oc.business_number.replace(/\D/g, "")}?text=hi%20${oc.link_code}` : undefined;
/** Whether the agent can message the owner right now: linked, and inside the 24 hours since their last message. */
const open = (oc: OwnerChannel) => oc.linked && oc.window_until !== null && oc.window_until > Date.now() / 1000;
const until = (oc: OwnerChannel) => new Date(oc.window_until! * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: oc.tz });
/** One line: linked and open until when, closed and how to reopen, or not linked. */
const status = (oc: OwnerChannel) => !oc.linked ? "Not linked" : open(oc) ? `Linked · I can message you until ${until(oc)}` : "Window closed: send any message to reopen";

/** Settings › On your WhatsApp: the agent messages the owner there, and only the owner. */
export default function OnYourWhatsApp() {
  const state = useLoad("owner-channel", api.ownerChannel);
  return <Load state={state}>{oc => <Channel oc={oc} onSaved={state.setData} />}</Load>;
}

function Channel({ oc, onSaved }: { oc: OwnerChannel; onSaved: (next: OwnerChannel) => void }) {
  const [phone, setPhone] = useState("");
  const [editing, setEditing] = useState(!oc.phone);
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  const save = (change: Parameters<typeof api.setOwnerChannel>[0]) => api.setOwnerChannel(change)
    // Home and onboarding read the same channel: they catch up once the server has it.
    .then(next => { onSaved(next); refetch("owner-channel"); setError(""); setSaid("Saved"); return true; }, (cause: unknown) => { setSaid(""); setError(message(cause)); return false; });
  const savePhone = async () => {
    const number = phone.replace(/[\s()-]/g, "");
    if (number && await save({ phone: number })) { setEditing(false); setPhone(""); }
  };
  // The server sends "Stupid is connected. I'll ping you here." A 409 says what's missing first.
  const test = () => api.testOwnerChannel().then(() => { setError(""); setSaid("Sent. Check your WhatsApp."); }, (cause: unknown) => {
    const needs = cause instanceof ApiError ? (cause.body as { needs?: string } | undefined)?.needs : undefined;
    setSaid("");
    setError(needs === "link" ? "Link your WhatsApp first: tap Link it, then send the message it opens."
      : needs === "window" ? "WhatsApp only lets me message you within 24 hours of your last message. Send any message to the business number, then try again."
      : message(cause));
  });
  const link = linkUrl(oc);
  // A tick shows at once; a failed save puts the list back as the server has it.
  const toggle = (kind: Urgent, on: boolean) => {
    const next = on ? [...oc.urgent, kind] : oc.urgent.filter(k => k !== kind);
    onSaved({ ...oc, urgent: next });
    void save({ urgent: next }).then(ok => { if (!ok) onSaved(oc); });
  };
  return (
    <VStack gap={5}>
      <Text as="p" type="supporting" size="sm">Your agent pings you here about what matters and sends a daily summary. Anything to a customer still waits for your tap, or your "1" reply.</Text>
      <section aria-labelledby="owner-link" className="owner-block">
        <Heading level={3} id="owner-link">Your number</Heading>
        <Text as="p" size="sm" className="status-line"><span className="live-dot" data-on={open(oc) || undefined} aria-hidden />{status(oc)}</Text>
        {editing
          ? <HStack gap={2} align="end" wrap="wrap">
            <TextInput type="tel" label="Your WhatsApp number" description="With the country code, like +91 98xxx xxxxx" value={phone} onChange={setPhone} onEnter={() => void savePhone()} />
            <Button label="Save number" isDisabled={!phone.trim()} clickAction={savePhone} />
            {oc.phone && <Button variant="ghost" label="Keep the old number" onClick={() => { setEditing(false); setPhone(""); }} />}
          </HStack>
          : <HStack gap={3} align="center" wrap="wrap">
            <Text>{masked(oc.phone!)}</Text>
            <Button size="sm" variant="ghost" label="Change number" onClick={() => setEditing(true)} />
          </HStack>}
        {oc.phone && !oc.linked && (link
          ? <VStack gap={1} hAlign="start">
            <Button variant="primary" size="lg" label="Link it" href={link} target="_blank" rel="noopener noreferrer" />
            <Text as="p" type="supporting" size="sm">or send <strong>hi {oc.link_code}</strong> to {oc.business_number} from your phone</Text>
          </VStack>
          : <Text as="p" type="supporting" size="sm">Connect your WhatsApp business number in Connections first; I message you from it.</Text>)}
      </section>
      <div className="owner-grid">
        <Times label="Daily summary" value={oc.digest_time} fallback="21:00" onSave={digest => void save({ digest_time: digest })}>
          {on => on && <TimeField label="Summary time" value={oc.digest_time!} onSave={t => void save({ digest_time: t })} />}
        </Times>
        <Times label="Quiet hours" value={oc.quiet} fallback={{ from: "23:00", to: "08:00" }} onSave={quiet => void save({ quiet })}>
          {on => on && <HStack gap={2} wrap="wrap">
            <TimeField label="From" value={oc.quiet!.from} onSave={from => void save({ quiet: { ...oc.quiet!, from } })} />
            <TimeField label="To" value={oc.quiet!.to} onSave={to => void save({ quiet: { ...oc.quiet!, to } })} />
          </HStack>}
        </Times>
        <fieldset className="owner-pings">
          <legend><Heading level={3}>Ping me for</Heading></legend>
          {urgent.map(([kind, label]) => <CheckboxInput key={kind} label={label} value={oc.urgent.includes(kind)} onChange={on => toggle(kind, on)} />)}
        </fieldset>
      </div>
      <HStack gap={3} align="center" wrap="wrap">
        <Button label="Send a test" clickAction={test} />
        <div aria-live="polite">
          {error ? <Text as="p" size="sm">{error}</Text> : said && <Text as="p" size="sm" type="supporting">{said}</Text>}
        </div>
      </HStack>
    </VStack>
  );
}

/** A switch for a timed message (off is null), with its times under it while on. */
function Times<T>({ label, value, fallback, onSave, children }: { label: string; value: T | null; fallback: T; onSave: (next: T | null) => void; children: (on: boolean) => ReactNode }) {
  return (
    <VStack gap={2} className="owner-block">
      <Switch label={label} value={value !== null} onChange={on => onSave(on ? fallback : null)} />
      {children(value !== null)}
    </VStack>
  );
}

/** The browser's own time field: saves a full, changed time when you leave it. */
function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (time: string) => void }) {
  return (
    <label className="time-field">
      <span>{label}</span>
      <input type="time" defaultValue={value} onBlur={event => { const t = event.target.value; if (/^\d\d:\d\d$/.test(t) && t !== value) onSave(t); }} />
    </label>
  );
}
