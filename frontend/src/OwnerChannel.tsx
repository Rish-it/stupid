import { useState } from "react";
import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ApiError, api, chatUrl, ownerPlace, refetch, useLoad, whatsappBlock } from "./api";
import type { Connections, Issue, OwnerChannel, Urgent } from "./api";
import { Load } from "./Load";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const urgent: [Urgent, string][] = [["big_order", "Big orders"], ["complaint", "Complaints"], ["brand_deal", "Brand deals"], ["payment", "Payment problems"], ["question", "Questions only I can answer"]];
/** Only the last four digits show; the rest of the number stays off screen. */
const masked = (phone: string) => `•••• ${phone.slice(-4)}`;
/** Whether the agent can message the owner right now: linked, and inside the 24 hours since their last message. */
const open = (oc: OwnerChannel) => oc.linked && oc.window_until !== null && oc.window_until > Date.now() / 1000;
const until = (oc: OwnerChannel) => new Date(oc.window_until! * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: oc.tz });
/** One line: linked and open until when, closed and how to reopen, or not linked. */
const status = (oc: OwnerChannel) => !oc.linked ? "Not linked" : open(oc) ? `Linked · I can message you until ${until(oc)}` : "Window closed: send any message to reopen";

/** Settings › On your WhatsApp: the agent messages the owner there, and only the owner. */
export default function OnYourWhatsApp({ state: account }: { state: Connections }) {
  const state = useLoad("owner-channel", api.ownerChannel);
  return <Load state={state}>{oc => <Channel oc={oc} blocked={oc.channel !== "messenger" ? whatsappBlock(account) : undefined} onSaved={state.setData} />}</Load>;
}

type Place = "phone" | "settings" | "test";

function Channel({ oc, blocked, onSaved }: { oc: OwnerChannel; blocked?: Issue; onSaved: (next: OwnerChannel) => void }) {
  const place = ownerPlace(oc);
  const [phone, setPhone] = useState("");
  const [editing, setEditing] = useState(false);
  // One note at a time, shown where it happened: a save under the settings, a failed number on its field, a test by its button.
  const [note, setNote] = useState<{ at: Place; text: string; bad?: boolean }>();
  const save = (change: Parameters<typeof api.setOwnerChannel>[0], at: Place = "settings") => api.setOwnerChannel(change)
    // Home and onboarding read the same channel: they catch up once the server has it.
    .then(next => { onSaved(next); refetch("owner-channel"); setNote({ at, text: "Saved" }); return true; }, (cause: unknown) => { setNote({ at, text: message(cause), bad: true }); return false; });
  const savePhone = async () => {
    const number = phone.replace(/[\s()-]/g, "");
    if (number && await save({ phone: number }, "phone")) { setEditing(false); setPhone(""); }
  };
  // The server sends "Stupid is connected. I'll ping you here." A 409 says what's missing; anything else, the server's own words.
  const test = () => api.testOwnerChannel().then(() => setNote({ at: "test", text: `Sent. Check your ${place}.` }), (cause: unknown) => {
    const needs = cause instanceof ApiError ? (cause.body as { needs?: string } | undefined)?.needs : undefined;
    setNote({ at: "test", bad: true, text: needs === "link" ? "Pair your WhatsApp first: send the code above to your agent."
      : needs === "window" ? `${place} only lets me message you within 24 hours of your last message. Send any message to ${place === "Messenger" ? "your Page" : "the business number"}, then try again.`
      : message(cause) });
  });
  // A tick shows at once; a failed save puts the list back as the server has it.
  const toggle = (kind: Urgent, on: boolean) => {
    const next = on ? [...oc.urgent, kind] : oc.urgent.filter(k => k !== kind);
    onSaved({ ...oc, urgent: next });
    void save({ urgent: next }).then(ok => { if (!ok) onSaved(oc); });
  };
  const said = (at: Place) => note?.at === at && <Text as="p" size="sm" type={note.bad ? undefined : "supporting"} className={note.bad ? "owner-error" : undefined}>{note.text}</Text>;
  return (
    <VStack gap={4}>
      <Text as="p" type="supporting" size="sm">{`Your agent pings you on ${place}${oc.page_name ? ` from ${oc.page_name}` : ""} about what matters and sends a daily summary. Anything to a customer still waits for your tap, or your "1" reply.`}</Text>
      {blocked && <Banner status="warning" title={blocked.text} description={blocked.fix}
        endContent={blocked.link ? <Button size="sm" label="Fix in Meta" href={blocked.link} target="_blank" rel="noopener noreferrer" /> : undefined} />}
      {oc.last_error && !blocked && <Text as="p" size="sm" className="owner-error">{`The last ping didn't arrive: ${oc.last_error.error.replace(/^Meta: /, "")}`}</Text>}
      <section aria-labelledby="owner-link" className="owner-block">
        {oc.linked && <Heading level={3} id="owner-link">{place === "Messenger" ? "Your Messenger" : "Your number"}</Heading>}
        <Text as="p" size="sm" className="status-line"><span className="live-dot" data-ok={open(oc) || undefined} aria-hidden />{status(oc)}</Text>
        {oc.linked ? null : oc.business_number
          ? <>
            <Heading level={3} id="owner-link">Send this code to your agent: <span className="pair-code">{oc.link_code}</span></Heading>
            <HStack gap={3} align="center" wrap="wrap">
              <Button variant="primary" size="lg" label="Open WhatsApp" href={chatUrl(oc.business_number, `hi ${oc.link_code}`)} target="_blank" rel="noopener noreferrer" />
              <Text type="supporting" size="sm">or send <strong>hi {oc.link_code}</strong> to {oc.business_number} from your phone</Text>
            </HStack>
          </>
          : <>
            <Heading level={3} id="owner-link">Pair your WhatsApp</Heading>
            <Text as="p" type="supporting" size="sm">Connect your WhatsApp business number in Connections first; your agent answers you from it.</Text>
          </>}
        {editing
          ? <HStack gap={2} align="end" wrap="wrap">
            <TextInput type="tel" label="Your WhatsApp number" isOptional={!oc.linked} placeholder="+91 98xxx xxxxx" value={phone} onChange={setPhone} onEnter={() => void savePhone()}
              status={note?.at === "phone" && note.bad ? { type: "error", message: note.text } : undefined} />
            <Button label="Save number" isDisabled={!phone.trim()} clickAction={savePhone} />
            <Button variant="ghost" label="Cancel" onClick={() => { setEditing(false); setPhone(""); setNote(undefined); }} />
          </HStack>
          : oc.phone && place === "WhatsApp"
            ? <HStack gap={3} align="center" wrap="wrap">
              <Text>{masked(oc.phone)}</Text>
              <Button size="sm" variant="ghost" label="Change number" onClick={() => setEditing(true)} />
            </HStack>
            : !oc.linked && oc.business_number && <Button size="sm" variant="ghost" label="or type your number" onClick={() => setEditing(true)} />}
      </section>
      <VStack gap={2}>
        <div className="owner-grid">
          <Times label="Daily summary" value={oc.digest_time} fallback="21:00" onSave={digest => void save({ digest_time: digest })}>
            {on => <TimeField label="Summary time" value={oc.digest_time ?? "21:00"} isDisabled={!on} onSave={t => void save({ digest_time: t })} />}
          </Times>
          <Times label="Quiet hours" value={oc.quiet} fallback={{ from: "23:00", to: "08:00" }} onSave={quiet => void save({ quiet })}>
            {on => <HStack gap={2} wrap="wrap">
              <TimeField label="From" value={oc.quiet?.from ?? "23:00"} isDisabled={!on} onSave={from => void save({ quiet: { ...oc.quiet!, from } })} />
              <TimeField label="To" value={oc.quiet?.to ?? "08:00"} isDisabled={!on} onSave={to => void save({ quiet: { ...oc.quiet!, to } })} />
            </HStack>}
          </Times>
          <fieldset className="owner-pings">
            <legend><Heading level={3}>Ping me for</Heading></legend>
            {urgent.map(([kind, label]) => <CheckboxInput key={kind} label={label} value={oc.urgent.includes(kind)} onChange={on => toggle(kind, on)} />)}
          </fieldset>
        </div>
        <div aria-live="polite">{said("settings")}</div>
      </VStack>
      <HStack gap={3} align="center" wrap="wrap">
        <Button label="Send a test" clickAction={test} />
        <div aria-live="polite">{said("test")}</div>
      </HStack>
    </VStack>
  );
}

/** A switch for a timed message (off is null), with its times under it: greyed while off, so the column never looks empty. */
function Times<T>({ label, value, fallback, onSave, children }: { label: string; value: T | null; fallback: T; onSave: (next: T | null) => void; children: (on: boolean) => ReactNode }) {
  return (
    <VStack gap={2} className="owner-block">
      <Switch label={label} value={value !== null} onChange={on => onSave(on ? fallback : null)} />
      {children(value !== null)}
    </VStack>
  );
}

/** The browser's own time field: saves a full, changed time when you leave it. */
function TimeField({ label, value, isDisabled, onSave }: { label: string; value: string; isDisabled?: boolean; onSave: (time: string) => void }) {
  return (
    <label className="time-field">
      <span>{label}</span>
      <input type="time" key={value} defaultValue={value} disabled={isDisabled} onBlur={event => { const t = event.target.value; if (/^\d\d:\d\d$/.test(t) && t !== value) onSave(t); }} />
    </label>
  );
}
