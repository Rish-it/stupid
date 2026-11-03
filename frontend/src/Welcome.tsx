import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { legal, oauthStartUrl } from "./api";
import SourceIcon from "./SourceIcon";

// The headline's second line. The first phrase is the main one; each of the others ends in the app it works in.
const phrases: [text: string, app?: string][] = [
  ["does your Meta busywork"],
  ["drafts your replies", "whatsapp"],
  ["finds your leads", "messenger"],
  ["plans your posts", "instagram"],
  ["reads your ads", "ads"],
  ["sorts your inbox", "chat"],
];
// In ms. The main phrase holds longer; then the words leave one by one while the next ones arrive.
const hold = { main: 3250, other: 2500 }, exit = 150, enter = 200, enterDelay = 150, perWord = 30;
const words = (i: number) => phrases[i % phrases.length][0].split(" ").length;
const swap = (from: number) => Math.max(exit + (words(from) - 1) * perWord, enterDelay + enter + (words(from + 1) - 1) * perWord);
const apps = [["instagram", "Instagram"], ["whatsapp", "WhatsApp"], ["messenger", "Messenger"], ["ads", "Meta Ads"]] as const;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const features: { title: string; text: string; art: ReactNode }[] = [
  {
    title: "Every message in one inbox",
    text: "Messenger, Instagram DMs and comments, and WhatsApp, newest first, updating live.",
    art: <><SourceIcon source="messenger" size={56} /><SourceIcon source="instagram" size={56} /><SourceIcon source="whatsapp" size={56} /></>,
  },
  {
    title: "Agents prepare, you decide",
    text: "Background agents draft replies, find leads, suggest posts and read your ads. Nothing is sent, posted or changed without your tap.",
    art: <SourceIcon source="chat" size={72} />,
  },
  {
    title: "Results in plain words",
    text: "Your ad results for the last 7 days, and Instagram reach, followers and engagement, straight from Meta. An empty account says so.",
    art: <><SourceIcon source="ads" size={64} /><SourceIcon source="instagram" size={56} /></>,
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
export default function Welcome({ instagram, onConnect, onPassed }: { instagram?: string; onConnect: () => void; onPassed: (passed: boolean) => void }) {
  const signIn = useRef<HTMLDivElement>(null);
  const tour = useRef<HTMLElement>(null);
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
      <Button variant="primary" size="lg" width="100%" label="Continue with Facebook" href={oauthStartUrl} onClick={onConnect} />
      {instagram && <Button size="lg" width="100%" label="Continue with Instagram" href={instagram} onClick={onConnect} />}
    </>
  );

  return (
    <VStack>
      <VStack className="hero" hAlign="center" gap={8} paddingInline={4}>
        <Headline />
        <VStack ref={signIn} gap={3} hAlign="center" maxWidth={400} width="100%">
          <Text as="p" type="supporting" justify="center">Sign in with the Facebook account that runs your business.</Text>
          {buttons}
          <Text as="p" type="supporting" size="sm" justify="center">Meta will ask which Page, Instagram account and WhatsApp number to share. Pick the ones you use for your business.</Text>
        </VStack>
        <div className="hero-more"><Button label="See how it works" variant="secondary" endContent={<Icon icon="arrowDown" size="sm" />} onClick={more} /></div>
      </VStack>

      <section ref={tour} tabIndex={-1} aria-labelledby="intro-title" className="intro">
        <div className="intro-fill" aria-hidden />
        <VStack gap={3} hAlign="center" paddingInline={4} maxWidth={720} width="100%" className="intro-copy">
          <Heading level={2} type="display-3" id="intro-title" justify="center" textWrap="balance">Built around your whole business</Heading>
          <Text as="p" justify="center">Connect Instagram, WhatsApp, your Facebook Page and Meta Ads. Stupid reads them in plain words, and its agents get the next step ready for your tap.</Text>
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
        <Mascot />
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
          <VStack gap={3} width="100%" className="outro-buttons">{buttons}</VStack>
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

/** The agent, in the headline: it pulses each time the phrase changes and works while hovered, or held for 0.4s on touch. */
function Avatar({ swapping }: { swapping?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (swapping !== undefined && !still()) ref.current?.animate([{ scale: 1 }, { scale: 1.06 }, { scale: 1 }], { duration: 600, easing: "ease-in-out" });
  }, [swapping]);
  const hold = () => {
    const timer = setTimeout(() => setPressed(true), 400);
    const release = () => {
      clearTimeout(timer);
      setPressed(false);
      removeEventListener("pointerup", release);
      removeEventListener("pointercancel", release);
    };
    addEventListener("pointerup", release);
    addEventListener("pointercancel", release);
  };
  return <span className="rebus-avatar" ref={ref} data-pressed={pressed || undefined} onPointerDown={hold}><span /><span /><span /></span>;
}

/** The mascot at the foot of the page. On wide screens its eyes follow the pointer; on phones they look around. */
function Mascot() {
  const face = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const eyes = face.current!, body = eyes.parentElement!;
    const wide = matchMedia("(min-width: 64rem)");
    let pointer: { x: number; y: number } | undefined, frame = 0;
    const look = () => {
      frame = 0;
      if (!wide.matches) return void (eyes.style.translate = "");
      if (!pointer) return;
      // offsetLeft/Top ignore the current translate, so this is where the eyes rest.
      const r = body.getBoundingClientRect();
      const dx = pointer.x - (r.left + eyes.offsetLeft + eyes.offsetWidth / 2);
      const dy = pointer.y - (r.top + eyes.offsetTop + eyes.offsetHeight / 2);
      const reach = Math.min(Math.hypot(dx, dy) / 400, 1) * r.width * .09, angle = Math.atan2(dy, dx);
      eyes.style.translate = `${Math.cos(angle) * reach}px ${Math.sin(angle) * reach}px`;
    };
    const schedule = () => { frame ||= requestAnimationFrame(look); };
    const move = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; schedule(); };
    addEventListener("pointermove", move, { passive: true });
    // The page scrolls inside the shell, so listen in the capture phase.
    addEventListener("scroll", schedule, { passive: true, capture: true });
    addEventListener("resize", schedule);
    wide.addEventListener("change", schedule);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("pointermove", move);
      removeEventListener("scroll", schedule, { capture: true });
      removeEventListener("resize", schedule);
      wide.removeEventListener("change", schedule);
    };
  }, []);
  return <div className="mascot-stage" aria-hidden><span className="mascot"><span className="mascot-eyes" ref={face}><span /><span /><span /></span></span></div>;
}
