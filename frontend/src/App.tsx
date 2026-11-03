import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { api, oauthStartUrl, sample, setupDone, useLoad } from "./api";

const pages = { today: "Today", inbox: "Inbox", agents: "Agents", setup: "Setup", settings: "Settings" } as const;
type Page = keyof typeof pages;
const nav: Page[] = ["today", "inbox", "agents"];
const welcome = [
  ["Inbox", "Messenger, Instagram and WhatsApp messages in one place."],
  ["Agents", "Drafts replies, post ideas and ad advice. Nothing is sent without your tap."],
  ["Ads in plain words", "What you spent, what worked and what to change."],
] as const;
const legal = [["Privacy", "/privacy.html"], ["Terms", "/terms.html"], ["Data deletion", "/deletion.html"]] as const;
const Setup = lazy(() => import("./Setup"));
const Today = lazy(() => import("./Today"));
const Inbox = lazy(() => import("./Inbox"));
const Agents = lazy(() => import("./Agents"));
const Settings = lazy(() => import("./Settings"));

// Meta sends people back to /?connected=1, /?error=<message> or /?meta_error=1. Read it once, then drop it from the address.
const query = new URLSearchParams(location.search);
const failure = query.get("error")?.slice(0, 300) || (query.has("meta_error") ? "Nothing was shared with Secnd. You can try again whenever you like." : null);
const returned = failure ? "error" : query.has("connected") ? "connected" : null;
if (returned) {
  for (const key of ["error", "meta_error", "connected"]) query.delete(key);
  history.replaceState(null, "", `/${query.size ? `?${query}` : ""}${returned === "connected" ? "#setup" : location.hash}`);
}

/** The page named in the address, or null when there is none. */
function usePage(): Page | null {
  const read = () => { const hash = location.hash.slice(1); return hash in pages ? hash as Page : null; };
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
  const ready = user && setupDone(user);
  // Until setup is done, it is home; afterwards it lives in Settings. Pin it to the address so finishing doesn't jump away.
  const named = usePage();
  const page = named ?? (user && !ready ? "setup" : "today");
  useEffect(() => { if (!named && page === "setup") location.replace("#setup"); }, [named, page]);
  const [failed, setFailed] = useState(failure);
  const [connecting, setConnecting] = useState(false);
  // Coming back with the browser's Back button restores this page as it was; drop the loader then.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => event.persisted && setConnecting(false);
    addEventListener("pageshow", onShow);
    return () => removeEventListener("pageshow", onShow);
  }, []);
  const loading = <Center minHeight={240}><Spinner size="lg" aria-label="Loading" /></Center>;
  const signedIn = Boolean(user);
  useEffect(() => { document.title = signedIn ? `${pages[page]} · Secnd` : "Secnd"; }, [signedIn, page]);

  const connect = () => setConnecting(true);
  if (connecting || (returned && !me.data && !me.error)) return (
    <Center minHeight="100dvh">
      <VStack gap={4} hAlign="center" role="status"><Spinner size="lg" aria-hidden /><Text>Connecting to Meta…</Text></VStack>
    </Center>
  );

  let body;
  if (user && page === "setup") body = <Suspense fallback={loading}><Setup state={user} onChange={next => me.setData({ ...user, ...next })} onConnect={connect} /></Suspense>;
  else if (user && page === "today") body = <Suspense fallback={loading}><Today state={user} /></Suspense>;
  else if (user && page === "inbox") body = <Suspense fallback={loading}><Inbox /></Suspense>;
  else if (user && page === "agents") body = <Suspense fallback={loading}><Agents state={user} /></Suspense>;
  else if (user) body = <Suspense fallback={loading}><Settings name={user.name} onSignedOut={() => { me.setData({ signed_in: false }); location.hash = ""; }} /></Suspense>;
  else if (me.data || me.error?.status === 401) body = (
    <VStack gap={10} paddingBlockStart={8} hAlign="center">
      <VStack gap={4} hAlign="center" maxWidth={560}>
        <Heading level={1} type="display-2" justify="center" textWrap="balance">Run your Meta business in plain words</Heading>
        <Text as="p" justify="center">Your messages, posts and ads from Facebook, Instagram and WhatsApp, in one calm place.</Text>
        <Text as="p" type="supporting" justify="center">Meta will ask which Page, Instagram account and WhatsApp number to share. Pick the ones you use for your business.</Text>
        <Button variant="primary" size="lg" label="Continue with Facebook" href={oauthStartUrl} onClick={connect} />
        {me.data && !me.data.signed_in && me.data.instagram_oauth_start && <Button size="lg" label="Continue with Instagram" href={me.data.instagram_oauth_start} onClick={connect} />}
      </VStack>
      <Grid columns={{ minWidth: 220 }} gap={6} maxWidth={880} width="100%">
        {welcome.map(([title, text]) => (
          <VStack key={title} gap={1}><Heading level={2}>{title}</Heading><Text as="p" type="supporting">{text}</Text></VStack>
        ))}
      </Grid>
      <Text as="p" type="supporting" justify="center">Secnd only reads what you allow. Tokens are encrypted. Disconnect any time.</Text>
    </VStack>
  );
  else if (me.error) body = (
    <EmptyState headingLevel={1} title={me.error.status === 0 ? "Secnd is offline" : "Something went wrong"}
      description={me.error.status === 0 ? "We can't reach Secnd's server. Check your connection, then try again." : me.error.message}
      actions={<Button label="Try again" clickAction={me.reload} />} />
  );
  else body = loading;

  return (
    <AppShell contentPadding={6}
      banner={sample && <Banner status="warning" container="section" title="Sample data" description="Nothing on this page is real. Remove ?fixtures=1 to use your own accounts." />}
      topNav={
      <TopNav label="Main navigation"
        heading={<TopNavHeading heading="Secnd" headingHref="#today" />}
        startContent={user && [...nav, ...ready ? [] : ["setup" as const]].map(id => <TopNavItem key={id} label={pages[id]} href={`#${id}`} isSelected={page === id} />)}
        endContent={user && <TopNavItem label="Settings" href="#settings" isSelected={page === "settings"} />} />
    }>
      <VStack gap={10}>
        {failed && <Banner status="warning" isDismissable onDismiss={() => setFailed(null)} title="Facebook didn't connect" description={failed}
          endContent={<Button size="sm" label="Try again" href={oauthStartUrl} onClick={connect} />} />}
        {body}
        <VStack as="footer" gap={2} hAlign="center">
          <HStack as="nav" aria-label="Legal" gap={4} wrap="wrap" hAlign="center">
            {legal.map(([label, href]) => <Link key={href} href={href} type="supporting">{label}</Link>)}
          </HStack>
          <Text as="p" type="supporting" justify="center">Built for Meta's platform. Not an official Meta product.</Text>
        </VStack>
      </VStack>
    </AppShell>
  );
}
