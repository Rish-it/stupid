import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { oauthStartUrl } from "./api";
import type { Persona } from "./api";
import { Modal } from "./Surface";

/** What Meta's sign-in will ask this person to pick. */
const asks: Record<Persona, string[]> = {
  creator: ["Your Instagram account. It must be Professional (Creator or Business).", "The Facebook Page linked to it, if Meta shows one."],
  business: ["Your WhatsApp Business number.", "Your Facebook Page.", "Your ad account, only if you run ads."],
};

/** Sign in, for the door picked: what Meta will ask and what to pick. */
export default function SignIn({ persona, instagram, onConnect, onClose }: { persona?: Persona; instagram?: string; onConnect: () => void; onClose: () => void }) {
  return (
    <Modal isOpen onClose={onClose} width={480} title={persona === "creator" ? "Connect as a creator" : persona === "business" ? "Connect your business" : "Sign in to Stupid"}
      subtitle="Stupid signs you in with Facebook, then Meta asks what to share.">
      {persona ? (
        <VStack gap={2}>
          <Text as="p" weight="semibold">When Meta asks, pick:</Text>
          <ul className="picks">{asks[persona].map(a => <li key={a}><Text>{a}</Text></li>)}</ul>
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
          <li><Text type="supporting" size="sm">Use the Facebook profile that manages your business Page.</Text></li>
          <li><Text type="supporting" size="sm">For Instagram, have a public Professional account (Creator or Business) linked to that Page.</Text></li>
          <li><Text type="supporting" size="sm">For WhatsApp, use a Business Platform account and registered number, or Meta's test number.</Text></li>
          <li><Text type="supporting" size="sm">No business portfolio yet? In <Link hasUnderline isExternalLink href="https://business.facebook.com/">Meta Business Suite</Link>, open the dropdown below Home → Create a business portfolio. Business verification is needed only when Meta asks for it.</Text></li>
        </ul>
      </details>
    </Modal>
  );
}
