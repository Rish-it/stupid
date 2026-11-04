import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Link } from "@astryxdesign/core/Link";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import type { Persona } from "./api";
import { api, door, legal, oauthStartUrl, sample, useLoad, useStream } from "./api";
import { Logo } from "./Icons";
import Welcome from "./Welcome";

const pages = { home: "Home", inbox: "Inbox", agents: "Agents", setup: "Setup", settings: "Settings" } as const;
type Page = keyof typeof pages;
const Setup = lazy(() => import("./Setup"));
const SignIn = lazy(() => import("./SignIn"));
const Home = lazy(() => import("./Home"));
const Inbox = lazy(() => import("./Inbox"));
const Agents = lazy(() => import("./Agents"));
const Settings = lazy(() => import("./Settings"));
const SideBar = lazy(() => import("./SideBar"));
const Onboarding = lazy(() => import("./Onboarding"));
const Toasts = lazy(() => import("./Toasts"));
// Closing the onboarding card (or skipping its optional step) holds it back for the rest of this visit.
const later = { get: () => { try { return sessionStorage.getItem("stupid.onboarding") === "later"; } catch { return false; } },
  set: () => { try { sessionStorage.setItem("stupid.onboarding", "later"); } catch { /* private mode: it just shows again */ } } };

// Meta sends people back to /?connected=1 or /?meta_error=1. Read it once, then drop it from the address.
// Only fixed wording is shown: text from the address could be anyone's.
const query = new URLSearchParams(location.search);
const failure = query.has("meta_error") ? "Nothing was shared with Stupid. You can try again whenever you like." : null;
// The sample desk shows one path; the banner offers the other.
const other = query.get("persona") === "creator" ? "business" : "creator";
const returned = failure ? "error" : query.has("connected") ? "connected" : null;
if (returned) {
  for (const key of ["error", "meta_error", "connected"]) query.delete(key);
  history.replaceState(null, "", `/${query.size ? `?${query}` : ""}${returned === "connected" ? "#home" : location.hash}`);
}

/** The page named in the address, or null when there is none. */
function usePage(): Page | null {
  // #today is the old name for Home; links to it still work.
  const read = () => { const hash = location.hash.slice(1).replace(/^today$/, "home"); return hash in pages ? hash as Page : null; };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return page;
}

export default function App() {
  const me = useLoad("me", api.me);
  const user = me.data?.signed_in ? me.data : undefined;
  // The door picked before sign-in becomes the account's path, once, right after sign-in.
  const pending = user && !user.persona ? door.get() : null;
  const { setData: setMe } = me;
  useEffect(() => {
    if (pending) api.setPersona(pending).then(next => { if (next.signed_in) setMe(next); }, () => undefined);
  }, [pending, setMe]);
  const page = usePage() ?? "home";
  // Settings opens over the page it was opened from, which stays behind it.
  const [behind, setBehind] = useState<Page>(page === "settings" ? "home" : page);
  if (page !== "settings" && page !== behind) setBehind(page);
  const shown = page === "settings" ? behind : page;
  const setPersona = (persona: Persona) => api.setPersona(persona).then(next => { if (next.signed_in) setMe(next); });
  const [held, setHeld] = useState(later.get);
  const [failed, setFailed] = useState(failure);
  const [connecting, setConnecting] = useState(false);
  const [passed, setPassed] = useState(false);
  // The sign-in window: for the door picked on the welcome page, or "any" from the header's Sign in.
  const [signIn, setSignIn] = useState<Persona | "any">();
  // Coming back with the browser's Back button restores this page as it was; drop the loader then.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => event.persisted && setConnecting(false);
    addEventListener("pageshow", onShow);
    return () => removeEventListener("pageshow", onShow);
  }, []);
  // As tall as a page, so the footer below doesn't jump once the page arrives.
  const loading = <Center minHeight="calc(100dvh - 12rem)"><Spinner size="lg" aria-label="Loading" /></Center>;
  const signedIn = Boolean(user);
  const signOut = useCallback(() => { setMe({ signed_in: false }); location.hash = ""; }, [setMe]);
  const reconnecting = useStream(signedIn, signOut);
  useEffect(() => {
    // Each place starts at its top, not where the last one was scrolled to.
    document.querySelector(".astryx-layout-content")?.scrollTo(0, 0);
  }, [signedIn, shown]);
  useEffect(() => { document.title = signedIn ? `${pages[page]} · Stupid` : "Stupid"; }, [signedIn, page]);

  const connect = () => setConnecting(true);
  if (connecting || (returned && !me.data && !me.error)) return (
    <Center minHeight="100dvh">
      <VStack gap={4} hAlign="center" role="status"><Spinner size="lg" aria-hidden /><Text className="shimmer">Connecting to Meta…</Text></VStack>
    </Center>
  );

  // Until we know who this is, a bare spinner: the shell around it (rail or top bar) depends on the answer.
  if (!me.data && !me.error) return <Center minHeight="100dvh">{loading}</Center>;
  const welcome = !user && Boolean(me.data || me.error?.status === 401);
  let body;
  if (user && shown === "setup") body = <Suspense fallback={loading}><Setup state={user} persona={user.persona} onChange={next => me.setData({ ...user, ...next })} onConnect={connect} /></Suspense>;
  else if (user && shown === "home") body = <Suspense fallback={loading}><Home state={user} persona={user.persona} onSetup={() => setHeld(false)} /></Suspense>;
  else if (user && shown === "inbox") body = <Suspense fallback={loading}><Inbox /></Suspense>;
  else if (user) body = <Suspense fallback={loading}><Agents state={user} /></Suspense>;
  else if (welcome) body = <Welcome onDoor={setSignIn} onPassed={setPassed} />;
  else if (me.error) body = (
    <EmptyState headingLevel={1} title={me.error.status === 0 ? "Stupid is offline" : "Something went wrong"}
      description={me.error.status === 0 ? "We can't reach Stupid's server. Check your connection, then try again." : me.error.message}
      actions={<Button label="Try again" clickAction={me.reload} />} />
  );
  else body = loading;

  return (
    <AppShell className={user ? "shell workspace" : "shell"} variant="wash" contentPadding={welcome ? 0 : 3}
      banner={sample && <Banner status="warning" container="section" title="Sample data, nothing here is real" description={<HStack as="span" gap={3} wrap="wrap">
        <Link href={`/?fixtures=1&persona=${other}&stage=busy#home`}>{other === "creator" ? "See the creator desk" : "See the business desk"}</Link>
        <Link href="/">Leave the sample</Link>
      </HStack>} />}
      topNav={!user && (me.data || me.error) && <TopNav label="Main navigation" heading={<TopNavHeading logo={<Logo />} heading="Stupid" headingHref="/" />}
        endContent={welcome && <span className="sticky-mark" data-passed={passed || undefined}><Button variant="primary" size="lg" label="Sign in" onClick={() => setSignIn("any")} /></span>} />}
      sideNav={user && <Suspense fallback={<div className="rail" aria-hidden />}><SideBar page={page} name={user.name} /></Suspense>}>
      <VStack gap={6}>
        {failed && <VStack paddingInline={welcome ? 4 : 0} paddingBlockStart={welcome ? 4 : 0}>
          <Banner status="warning" isDismissable onDismiss={() => setFailed(null)} title="Facebook didn't connect" description={failed}
            endContent={<Button size="sm" label="Try again" href={oauthStartUrl} onClick={connect} />} />
        </VStack>}
        {user && !sample && <Suspense fallback={null}><Toasts /></Suspense>}
        {reconnecting && <Text className="shimmer reconnecting" type="supporting" size="sm" role="status">Reconnecting…</Text>}
        {body}
        {user && page === "settings" && <Suspense><Settings name={user.name} persona={user.persona} onPersona={setPersona} onSignedOut={signOut}
          account={user} onAccount={next => me.setData({ ...user, ...next })} onConnect={connect}
          onClose={() => { location.hash = `#${behind}`; }} /></Suspense>}
        {user && page === "home" && !pending && !held && <Suspense><Onboarding persona={user.persona}
          onPersona={setPersona}
          onAccount={next => setMe({ ...user, ...next })} onConnect={connect} onClose={() => { later.set(); setHeld(true); }} /></Suspense>}
        {welcome && signIn && <Suspense><SignIn persona={signIn === "any" ? undefined : signIn} instagram={me.data?.signed_in === false ? me.data.instagram_oauth_start : undefined}
          onConnect={connect} onClose={() => setSignIn(undefined)} /></Suspense>}
        {!welcome && <VStack as="footer" gap={2} hAlign="center" className="app-footer">
          <HStack as="nav" aria-label="Legal" gap={4} wrap="wrap" hAlign="center">
            {legal.map(([label, href]) => <Link key={href} href={href} type="supporting">{label}</Link>)}
          </HStack>
          <Text as="p" type="supporting" justify="center">Built for Meta's platform. Not an official Meta product.</Text>
        </VStack>}
      </VStack>
    </AppShell>
  );
}
