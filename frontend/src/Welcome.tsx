import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { legal } from "./api";
import type { Persona } from "./api";
import SourceIcon from "./SourceIcon";

// The headline's second line. The first phrase is the main one; each of the others ends in the app it works in.
const phrases: [text: string, app?: string][] = [
  ["does your Meta busywork"],
  ["answers your customers", "whatsapp"],
  ["directs your Reels", "instagram"],
  ["finds your leads", "messenger"],
  ["writes your posts", "instagram"],
  ["reads your ads", "ads"],
];
// In ms. The main phrase holds longer; then the words leave one by one while the next ones arrive.
const hold = { main: 3250, other: 2500 }, exit = 150, enter = 200, enterDelay = 150, perWord = 30;
const words = (i: number) => phrases[i % phrases.length][0].split(" ").length;
const swap = (from: number) => Math.max(exit + (words(from) - 1) * perWord, enterDelay + enter + (words(from + 1) - 1) * perWord);
const apps = [["instagram", "Instagram"], ["whatsapp", "WhatsApp"], ["messenger", "Messenger"], ["ads", "Meta Ads"]] as const;
const Mascot = lazy(() => import("./Mascot"));
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const features: { title: string; text: string; art: ReactNode }[] = [
  {
    title: "Every message in one inbox",
    text: "Messenger, Instagram DMs and comments, and WhatsApp, newest first, updating live. Voice notes and photos are read for you.",
    art: <><SourceIcon source="messenger" size={56} /><SourceIcon source="instagram" size={56} /><SourceIcon source="whatsapp" size={56} /></>,
  },
  {
    title: "For creators: your next post, written",
    text: "Meta's Wonder watches your Reels and says what works and where people stop. Stupid writes your next script, post ideas and replies to comments, and spots brand deals. Nothing is posted without your tap.",
    art: <SourceIcon source="instagram" size={72} />,
  },
  {
    title: "For businesses: customers answered",
    text: "Customers send voice notes and photos. Stupid hears them, looks at them, drafts the answer with your prices, and asks you one question when it needs a price or a date. You check it and tap Send.",
    art: <><SourceIcon source="whatsapp" size={64} /><SourceIcon source="messenger" size={56} /></>,
  },
  {
    title: "Setup without the maze",
    text: "Connect one app at a time. Each account says what Meta still needs, like a payment method or a linked Page, with a link to the exact Meta screen.",
    art: <span className="feature-glyph"><Icon icon="wrench" size="lg" /></span>,
  },
  {
    title: "Your data stays yours",
    text: "Stupid only reads what you allow. Tokens are encrypted and never reach your browser. Messages are kept 30 days. Disconnect any time.",
    art: <span className="feature-glyph"><Icon icon="eyeSlash" size="lg" /></span>,
  },
];

/** The signed-out home. `onPassed` says whether the sign-in buttons have scrolled out of view. */
export default function Welcome({ onDoor, onPassed }: { onDoor: (persona: Persona) => void; onPassed: (passed: boolean) => void }) {
  const signIn = useRef<HTMLDivElement>(null);
  const footerMascot = useRef<HTMLDivElement>(null);
  const [showMascot, setShowMascot] = useState(false);
  useEffect(() => {
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setShowMascot(true); seen.disconnect(); }
    }, { rootMargin: "200px" });
    if (footerMascot.current) seen.observe(footerMascot.current);
    return () => seen.disconnect();
  }, []);
  const tour = useRef<HTMLElement>(null);
  const [excited, setExcited] = useState(false);
  useEffect(() => {
    const seen = new IntersectionObserver(([entry]) => onPassed(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    seen.observe(signIn.current!);
    return () => { seen.disconnect(); onPassed(false); };
  }, [onPassed]);
  const more = () => {
    tour.current?.scrollIntoView({ behavior: still() ? "auto" : "smooth" });
    tour.current?.focus({ preventScroll: true });
  };
  const buttons = (
    <>
      <Button variant="primary" size="lg" width="100%" label="I create content" onClick={() => onDoor("creator")} />
      <Button variant="primary" size="lg" width="100%" label="I run a business" onClick={() => onDoor("business")} />
    </>
  );

  return (
    <VStack>
      <VStack className="hero" hAlign="center" gap={10} paddingInline={5}>
        <Headline />
        <VStack ref={signIn} gap={2} hAlign="center" maxWidth={408} width="100%" paddingBlockStart={2}>
          <p className="hero-ask">For creators and small businesses on Meta. Which are you?</p>
          {buttons}
          <Link href="/?fixtures=1&persona=business&stage=busy#home" type="supporting">See a sample desk</Link>
          <details className="before-start">
            <summary>Before you start</summary>
            <Text as="p" type="supporting" size="sm">Use the Facebook profile that manages your business Page. For Instagram, have a public Professional account (Creator or Business) linked to that Page. For WhatsApp, use a Business Platform account and registered number, or Meta's test number. Ads needs an ad account you can view. You can connect one app now and add the rest later.</Text>
            <Text as="p" type="supporting" size="sm">A business portfolio groups these accounts. In <Link hasUnderline isExternalLink href="https://business.facebook.com/">Meta Business Suite</Link>, use the dropdown below Home → Create a business portfolio. Enter the business name, your name and business email → Create or Create portfolio, then confirm your email. Business verification is needed only when Meta asks for it; it is separate from the paid Meta Verified badge. Stupid walks you through each app after sign-in.</Text>
          </details>
          <Text as="p" type="supporting" size="sm" justify="center">Next, you sign in with Facebook. The window says what Meta will ask you to pick for your path.</Text>
        </VStack>
        <div className="hero-more"><Button label="Learn more" variant="secondary" size="lg" elevation="low" endContent={<Icon icon="arrowDown" size="sm" />} onClick={more} /></div>
      </VStack>

      <section ref={tour} tabIndex={-1} aria-labelledby="intro-title" className="intro">
        <div className="intro-fill" aria-hidden />
        <VStack gap={3} hAlign="center" paddingInline={4} maxWidth={720} width="100%" className="intro-copy">
          <Heading level={2} type="display-3" id="intro-title" justify="center" textWrap="balance">Two kinds of work, one agent</Heading>
          <Text as="p" justify="center">Creators start with Instagram; businesses start with WhatsApp and their Page. Stupid's agent does the busywork with Meta's models (Muse Spark, Voice Transcribe, Wonder and SAM 3.1), drafts the reply or asks you one question, and waits for your tap. It also works from Muse and Muse Code.</Text>
        </VStack>
        <div className="intro-stage">
          <div className="intro-card" aria-hidden>
            <span>Introducing</span>
            <strong>Stupid</strong>
            <HStack gap={4}>{["instagram", "whatsapp", "messenger", "ads"].map(app => <SourceIcon key={app} source={app} size={28} />)}</HStack>
          </div>
        </div>
      </section>

      {features.map((f, i) => (
        <section key={f.title} className={i % 2 ? "feature feature-alt" : "feature"} aria-label={f.title}>
          <Grid columns={{ minWidth: 280 }} gap={10} maxWidth={1040} width="100%">
            <div className="feature-art" aria-hidden>{f.art}</div>
            <VStack gap={3} vAlign="center">
              <Heading level={2} type="display-3" textWrap="balance">{f.title}</Heading>
              <Text as="p">{f.text}</Text>
            </VStack>
          </Grid>
        </section>
      ))}

      <footer className="outro" aria-label="Footer">
        <div className="mascot-stage" ref={footerMascot} aria-hidden>{showMascot && <Suspense><Mascot busy={excited} size="var(--mascot-size)" /></Suspense>}</div>
        <div className="outro-start">
          <span className="tag">How it works</span>
          <p className="outro-line">Agents prepare,<br />you decide</p>
          <nav className="outro-nav" aria-label="Legal">
            <button type="button" onClick={more}>See how it works</button>
            {legal.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
          </nav>
        </div>
        <div className="outro-mark" aria-hidden>Stupid</div>
        <div className="outro-end">
          <span className="tag">Ready when you are</span>
          <h2 className="outro-line">Ready to try Stupid?</h2>
          <VStack gap={3} width="100%" className="outro-buttons" onPointerEnter={() => setExcited(true)} onPointerLeave={() => setExcited(false)}>{buttons}</VStack>
          <p className="outro-note">Built for Meta's platform. Not an official Meta product.</p>
          <ul className="outro-apps" aria-label="Works with">
            {apps.map(([app, name]) => <li key={app} aria-label={name}><SourceIcon source={app} size={24} /></li>)}
          </ul>
        </div>
      </footer>
    </VStack>
  );
}

/** "Stupid, AI that …" with the second line cycling word by word. Screen readers hear the main phrase once. */
function Headline() {
  const [{ at, from }, setStep] = useState<{ at: number; from?: number }>({ at: 0 });
  useEffect(() => {
    if (still()) return;
    const timer = from === undefined
      ? setTimeout(() => setStep({ at: (at + 1) % phrases.length, from: at }), at ? hold.other : hold.main)
      : setTimeout(() => setStep({ at }), swap(from));
    return () => clearTimeout(timer);
  }, [at, from]);
  return (
    <Heading level={1} type="display-1" justify="center">
      <VisuallyHidden>Stupid, AI that {phrases[0][0]}</VisuallyHidden>
      <span className="rebus" aria-hidden>
        <span>Stupid<Avatar swapping={from} />, AI that</span>
        <span className="rebus-slot">
          {phrases.map(([text, app], i) => (
            <Fragment key={text}>
              <span className="rebus-measure">{text}{app && <span className="rebus-icon" />}</span>
              <span className="rebus-phrase" hidden={i !== at && i !== from}
                data-role={i === from ? "outgoing" : i === at ? (from === undefined ? "resting" : "incoming") : undefined}>
                {text.split(" ").map((word, w, all) => (
                  <Fragment key={w}>
                    {w > 0 && " "}
                    <span style={{ "--i": w } as CSSProperties}>
                      {word}{app && w === all.length - 1 && <span className="rebus-icon"><SourceIcon source={app} size="1em" /></span>}
                    </span>
                  </Fragment>
                ))}
              </span>
            </Fragment>
          ))}
        </span>
      </span>
    </Heading>
  );
}

/** The mascot, in the headline: it pulses each time the phrase changes and gets to work while hovered, or held for 0.4s on touch. */
function Avatar({ swapping }: { swapping?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [busy, setBusy] = useState(false);
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (swapping !== undefined && !still()) ref.current?.animate([{ scale: 1 }, { scale: 1.06 }, { scale: 1 }], { duration: 600, easing: "ease-in-out" });
  }, [swapping]);
  const hold = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const timer = setTimeout(() => { setAwake(true); setBusy(true); }, 400);
    const release = () => {
      clearTimeout(timer);
      setBusy(false);
      removeEventListener("pointerup", release);
      removeEventListener("pointercancel", release);
    };
    addEventListener("pointerup", release);
    addEventListener("pointercancel", release);
  };
  return (
    <span className="rebus-avatar" ref={ref} onPointerDown={e => hold(e.nativeEvent)}
      onPointerEnter={e => { if (e.pointerType === "mouse") { setAwake(true); setBusy(true); } }} onPointerLeave={() => setBusy(false)}>
      {awake ? <Suspense fallback={<span className="rebus-avatar-wait" />}><Mascot busy={busy} size="100%" /></Suspense>
        : <img src="/favicon.svg" width="100%" height="100%" alt="" />}
    </span>
  );
}
