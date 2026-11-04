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
import { api, door, legal, oauthStartUrl, sample, setupDone, useLoad, useStream } from "./api";
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

// Meta sends people back to /?connected=1 or /?meta_error=1. Read it once, then drop it from the address.
// Only fixed wording is shown: text from the address could be anyone's.
const query = new URLSearchParams(location.search);
const failure = query.has("meta_error") ? "Nothing was shared with Stupid. You can try again whenever you like." : null;
const returned = failure ? "error" : query.has("connected") ? "connected" : null;
if (returned) {
  for (const key of ["error", "meta_error", "connected"]) query.delete(key);
  history.replaceState(null, "", `/${query.size ? `?${query}` : ""}${returned === "connected" ? "#setup" : location.hash}`);
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
  const ready = user && setupDone(user);
  // Until setup is done, it is home; afterwards it lives in Settings. Pin it to the address so finishing doesn't jump away.
  const named = usePage();
  const page = named ?? (user && !ready ? "setup" : "home");
  useEffect(() => { if (!named && page === "setup") location.replace("#setup"); }, [named, page]);
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
  const loading = <Center minHeight={240}><Spinner size="lg" aria-label="Loading" /></Center>;
  const signedIn = Boolean(user);
  const signOut = useCallback(() => { setMe({ signed_in: false }); location.hash = ""; }, [setMe]);
  const reconnecting = useStream(signedIn, signOut);
  useEffect(() => {
    document.title = signedIn ? `${pages[page]} · Stupid` : "Stupid";
    // Each place starts at its top, not where the last one was scrolled to.
    document.querySelector(".astryx-layout-content")?.scrollTo(0, 0);
  }, [signedIn, page]);

  const connect = () => setConnecting(true);
  if (connecting || (returned && !me.data && !me.error)) return (
    <Center minHeight="100dvh">
      <VStack gap={4} hAlign="center" role="status"><Spinner size="lg" aria-hidden /><Text className="shimmer">Connecting to Meta…</Text></VStack>
    </Center>
  );

  const welcome = !user && Boolean(me.data || me.error?.status === 401);
  let body;
  if (user && page === "setup") body = <Suspense fallback={loading}><Setup state={user} onChange={next => me.setData({ ...user, ...next })} onConnect={connect} /></Suspense>;
  else if (user && page === "home") body = <Suspense fallback={loading}><Home state={user} persona={user.persona} /></Suspense>;
  else if (user && page === "inbox") body = <Suspense fallback={loading}><Inbox /></Suspense>;
  else if (user && page === "agents") body = <Suspense fallback={loading}><Agents state={user} /></Suspense>;
  else if (user) body = <Suspense fallback={loading}><Settings name={user.name} onSignedOut={signOut} /></Suspense>;
  else if (welcome) body = <Welcome onDoor={setSignIn} onPassed={setPassed} />;
  else if (me.error) body = (
    <EmptyState headingLevel={1} title={me.error.status === 0 ? "Stupid is offline" : "Something went wrong"}
      description={me.error.status === 0 ? "We can't reach Stupid's server. Check your connection, then try again." : me.error.message}
      actions={<Button label="Try again" clickAction={me.reload} />} />
  );
  else body = loading;

  return (
    <AppShell className={user ? "shell workspace" : "shell"} variant="wash" contentPadding={welcome ? 0 : 3}
      banner={sample && <Banner status="warning" container="section" title="Sample data" description="Nothing on this page is real. Remove ?fixtures=1 to use your own accounts." />}
      topNav={!user && <TopNav label="Main navigation" heading={<TopNavHeading logo={<Logo />} heading="Stupid" headingHref="/" />}
        endContent={welcome && <span className="sticky-mark" data-passed={passed || undefined}><Button variant="primary" size="lg" label="Sign in" onClick={() => setSignIn("any")} /></span>} />}
      sideNav={user && <Suspense fallback={null}><SideBar page={page} setup={!ready} name={user.name} /></Suspense>}>
      <VStack gap={6}>
        {failed && <VStack paddingInline={welcome ? 4 : 0} paddingBlockStart={welcome ? 4 : 0}>
          <Banner status="warning" isDismissable onDismiss={() => setFailed(null)} title="Facebook didn't connect" description={failed}
            endContent={<Button size="sm" label="Try again" href={oauthStartUrl} onClick={connect} />} />
        </VStack>}
        {reconnecting && <Text className="shimmer reconnecting" type="supporting" size="sm" role="status">Reconnecting…</Text>}
        {body}
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
