import type { CSSProperties, ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { door, oauthStartUrl, passed } from "./api";
import type { Persona } from "./api";
import { Modal } from "./Surface";
import SourceIcon from "./SourceIcon";
import "./flow.css";

/** What Meta's sign-in will ask this person to pick. */
const asks: Record<Persona, [app: string, what: string][]> = {
  creator: [["instagram", "Your Instagram account. It must be Professional (Creator or Business)."], ["messenger", "The Facebook Page linked to it, if Meta shows one."]],
  business: [["whatsapp", "Your WhatsApp Business number."], ["messenger", "Your Facebook Page."], ["ads", "Your ad account, only if you run ads."]],
};

const tips: ["all" | Persona, ReactNode][] = [
  ["all", "Use the Facebook profile that manages your Page."],
  ["creator", "Have a public Professional Instagram account (Creator or Business). Linking it to a Facebook Page lets Stupid read DMs."],
  ["business", "For Instagram, have a public Professional account (Creator or Business) linked to that Page."],
  ["business", "For WhatsApp, use a Business Platform account and registered number, or Meta's test number."],
  ["business", <>No business portfolio yet? In <Link hasUnderline isExternalLink href="https://business.facebook.com/">Meta Business Suite</Link>, open the dropdown below Home → Create a business portfolio. Business verification is needed only when Meta asks for it.</>],
];

/** Sign in, for the door picked: what Meta will ask and what to pick. */
export default function SignIn({ persona, instagram, onConnect: connect, onClose }: { persona?: Persona; instagram?: string; onConnect: () => void; onClose: () => void }) {
  const onConnect = () => { door.set(persona ?? null); passed.keep(0); connect(); };
  return (
    <Modal isOpen onClose={onClose} width={480} title={persona === "creator" ? "Connect as a creator" : persona === "business" ? "Connect your business" : "Sign in to Stupid"}
      subtitle="Stupid signs you in with Facebook, then Meta asks what to share.">
      {persona ? (
        <VStack gap={2}>
          <Text as="p" weight="semibold">When Meta asks, pick:</Text>
          <ol className="flow-picks">{asks[persona].map(([app, what], i) => (
            <li key={what} style={{ "--i": i } as CSSProperties}><span className="flow-app" aria-hidden><SourceIcon source={app} size={20} /></span><Text>{what}</Text></li>
          ))}</ol>
        </VStack>
      ) : <Text as="p">When Meta asks, pick the Instagram account, WhatsApp number and Page you use for your work.</Text>}
      <VStack gap={2}>
        <Button variant="primary" size="lg" width="100%" label="Continue with Facebook" href={oauthStartUrl} onClick={onConnect} />
        {instagram && persona !== "business" && <Button size="lg" width="100%" label="Continue with Instagram" href={instagram} onClick={onConnect} />}
      </VStack>
      <Text as="p" type="supporting" size="sm">Why Facebook? Meta lets apps reach Instagram, WhatsApp and Pages only through Facebook sign-in. Stupid never sees your password. <Link hasUnderline href="/privacy.html">Privacy policy</Link></Text>
      <details className="before-start">
        <summary>Before you start</summary>
        <ul className="picks">
          {tips.filter(([who]) => !persona || who === "all" || who === persona).map(([, tip], i) => <li key={i}><Text type="supporting" size="sm">{tip}</Text></li>)}
        </ul>
      </details>
    </Modal>
  );
}
