import { lazy, Suspense, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { door, legal } from "./api";
import type { Persona } from "./api";
import SourceIcon from "./SourceIcon";

const SignIn = lazy(() => import("./SignIn"));

const doors: Record<Persona, { label: string; promise: string; steps: [string, string][] }> = {
  creator: {
    label: "I create content",
    promise: "Meta's Wonder watches your Reels. Your next post, written for you.",
    steps: [
      ["Connect Instagram", "Sign in with Facebook and pick your Instagram account. One account is enough."],
      ["Stupid watches and writes", "Wonder watches your Reels. Muse Spark writes post ideas, Reel scripts and replies to comments and DMs, and spots brand deals."],
      ["You tap", "Copy a script, send a reply. Nothing is posted or sent without you."],
    ],
  },
  business: {
    label: "I run a business",
    promise: "Customers send voice notes and photos. Stupid drafts the answer. You tap send.",
    steps: [
      ["Connect WhatsApp and your Page", "Sign in with Facebook and pick your WhatsApp number and Facebook Page."],
      ["Stupid listens and drafts", "Voice Transcribe hears voice notes, Muse Spark looks at photos and drafts the answer with your prices. When it doesn't know, it asks you one question."],
      ["You tap Send", "Check the draft and send it. Nothing goes to a customer without your tap."],
    ],
  },
};

const models: [name: string, does: string][] = [
  ["Muse Spark", "Reads messages and pictures, writes replies, post ideas and ad advice."],
  ["Voice Transcribe", "Turns your customers' voice notes into text."],
  ["Wonder", "Watches your Reels and says what works and where people stop."],
  ["SAM 3.1", "Finds the product in your photos and crops it for every ad size."],
];

/** The signed-out home: what Stupid is, two doors, and how each path works. */
export default function Landing({ instagram, onConnect }: { instagram?: string; onConnect: () => void }) {
  const [shown, setShown] = useState<Persona>(() => door.get() ?? "creator");
  const [signIn, setSignIn] = useState<Persona | "any">();
  const open = (persona: Persona) => { door.set(persona); setShown(persona); setSignIn(persona); };
  return (
    <VStack className="landing">
      <VStack as="section" aria-labelledby="landing-title" className="landing-hero" hAlign="center" gap={8}>
        <VStack gap={3} hAlign="center" maxWidth={720}>
          <Heading level={1} type="display-1" id="landing-title" justify="center" textWrap="balance">Stupid does your Meta busywork</Heading>
          <Text as="p" type="large" justify="center" textWrap="balance">An agent for creators and small businesses on Instagram, WhatsApp and Messenger. It prepares the work. You tap.</Text>
        </VStack>
        <div className="doors">
          {(["creator", "business"] as const).map(p => (
            <button key={p} type="button" className="door" onClick={() => open(p)}>
              <DoorArt persona={p} />
              <span className="door-label">{doors[p].label}</span>
              <span className="door-promise">{doors[p].promise}</span>
            </button>
          ))}
        </div>
        <Button variant="ghost" label="Already use Stupid? Sign in" onClick={() => setSignIn("any")} />
      </VStack>

      <section aria-labelledby="how-title" className="landing-band">
        <VStack gap={6} maxWidth={960} width="100%">
          <HStack gap={4} justify="between" align="center" wrap="wrap">
            <Heading level={2} type="display-3" id="how-title">How it works</Heading>
            <SegmentedControl label="Show how it works for" value={shown} onChange={v => setShown(v as Persona)}>
              <SegmentedControlItem value="creator" label="Creators" />
              <SegmentedControlItem value="business" label="Businesses" />
            </SegmentedControl>
          </HStack>
          <ol className="how">
            {doors[shown].steps.map(([title, text], i) => (
              <li key={title}>
                <Text as="p" type="supporting" hasTabularNumbers>{i + 1}</Text>
                <Heading level={3}>{title}</Heading>
                <Text as="p" type="supporting">{text}</Text>
              </li>
            ))}
          </ol>
          <HStack><Button variant="primary" size="lg" label={shown === "creator" ? "Start as a creator" : "Start as a business"} onClick={() => open(shown)} /></HStack>
        </VStack>
      </section>

      <section aria-labelledby="models-title" className="landing-band">
        <VStack gap={6} maxWidth={960} width="100%">
          <VStack gap={2}>
            <Heading level={2} type="display-3" id="models-title">Meta's models, doing the work</Heading>
            <Text as="p" type="supporting">Each result in Stupid names the model that made it.</Text>
          </VStack>
          <ul className="models">
            {models.map(([name, does]) => <li key={name}><Text as="p" weight="semibold">{name}</Text><Text as="p" type="supporting">{does}</Text></li>)}
          </ul>
          <VStack gap={1} className="muse-strip">
            <Text as="p" weight="semibold">Works with Muse and Muse Code</Text>
            <Text as="p" type="supporting">Ask Muse what's waiting in Stupid, or queue a reply from Muse Code. Sending still happens here, with your tap.</Text>
          </VStack>
        </VStack>
      </section>

      <footer className="landing-band landing-footer" aria-label="Footer">
        <VStack gap={3} maxWidth={960} width="100%">
          <Text as="p" type="supporting">Stupid only reads what you allow. Tokens are encrypted and never reach your browser. Messages are kept 30 days. Disconnect any time.</Text>
          <HStack as="nav" aria-label="Legal" gap={4} wrap="wrap">
            {legal.map(([label, href]) => <Link key={href} href={href} type="supporting">{label}</Link>)}
          </HStack>
          <Text as="p" type="supporting">Built for Meta's platform. Not an official Meta product.</Text>
        </VStack>
      </footer>

      {signIn && <Suspense><SignIn persona={signIn === "any" ? undefined : signIn} instagram={instagram} onConnect={onConnect} onClose={() => setSignIn(undefined)} /></Suspense>}
    </VStack>
  );
}

/** One short picture of the agent at work: shapes, never made-up messages. */
function DoorArt({ persona }: { persona: Persona }) {
  if (persona === "creator") return (
    <span className="door-art" aria-hidden>
      <span className="art-reel"><SourceIcon source="instagram" size={20} /><span className="art-scan" /></span>
      <span className="art-note"><b /><i /><i /><i className="short" /></span>
    </span>
  );
  return (
    <span className="door-art" aria-hidden>
      <span className="art-chat">
        <span className="art-bubble art-voice">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ height: `${30 + ((i * 37) % 60)}%` }} />)}</span>
        <span className="art-bubble art-photo" />
        <span className="art-bubble art-draft"><i /><i className="short" /><b>Send</b></span>
      </span>
    </span>
  );
}
