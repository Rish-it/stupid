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
import { api, oauthStartUrl, sample, useLoad } from "./api";

const pages = { today: "Today", inbox: "Inbox", agents: "Agents", connections: "Connections", settings: "Settings" } as const;
type Page = keyof typeof pages;
const nav: Page[] = ["today", "inbox", "agents", "connections"];
const welcome = [
  ["Inbox", "Messenger, Instagram and WhatsApp messages in one place."],
  ["Agents", "Drafts replies, post ideas and ad advice. Nothing is sent without your tap."],
  ["Ads in plain words", "What you spent, what worked and what to change."],
] as const;
const legal = [["Privacy", "/privacy.html"], ["Terms", "/terms.html"], ["Data deletion", "/deletion.html"]] as const;
const Connections = lazy(() => import("./Connections"));
const Today = lazy(() => import("./Today"));
const Inbox = lazy(() => import("./Inbox"));
const Agents = lazy(() => import("./Agents"));
const Settings = lazy(() => import("./Settings"));

// Meta sends people back to /?connected=1 or /?meta_error=1. Read it once, then drop it from the address.
const query = new URLSearchParams(location.search);
const returned = query.has("meta_error") ? "error" : query.has("connected") ? "connected" : null;
if (returned) {
  query.delete("meta_error");
  query.delete("connected");
  history.replaceState(null, "", `/${query.size ? `?${query}` : ""}${returned === "connected" ? "#connections" : location.hash}`);
}

function usePage(): Page {
  const read = () => { const hash = location.hash.slice(1); return hash in pages ? hash as Page : "today"; };
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
  const page = usePage();
  const user = me.data?.signed_in ? me.data : undefined;
  const [notice, setNotice] = useState(returned);
  // "You're connected" belongs to the page Meta sends people back to; leaving it retires the notice for good.
  if (notice === "connected" && page !== "connections") setNotice(null);
  const loading = <Center minHeight={240}><Spinner size="lg" aria-label="Loading" /></Center>;
  const signedIn = Boolean(user);
  useEffect(() => { document.title = signedIn ? `${pages[page]} · Secnd` : "Secnd"; }, [signedIn, page]);

  let body;
  if (user && page === "connections") body = <Suspense fallback={loading}><Connections state={user} onChange={next => me.setData({ ...user, ...next })} /></Suspense>;
  else if (user && page === "today") body = <Suspense fallback={loading}><Today state={user} /></Suspense>;
  else if (user && page === "inbox") body = <Suspense fallback={loading}><Inbox /></Suspense>;
  else if (user && page === "agents") body = <Suspense fallback={loading}><Agents state={user} /></Suspense>;
  else if (user) body = <Suspense fallback={loading}><Settings name={user.name} onSignedOut={() => { me.setData({ signed_in: false }); location.hash = ""; }} /></Suspense>;
  else if (me.data || me.error?.status === 401) body = (
    <VStack gap={10} paddingBlockStart={8} hAlign="center">
      <VStack gap={4} hAlign="center" maxWidth={560}>
        <Heading level={1} type="display-2" justify="center" textWrap="balance">Run your Meta business in plain words</Heading>
        <Text as="p" justify="center">Your messages, posts and ads from Facebook, Instagram and WhatsApp, in one calm place.</Text>
        <Button variant="primary" size="lg" label="Continue with Facebook" href={oauthStartUrl} />
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
        startContent={user && nav.map(id => <TopNavItem key={id} label={pages[id]} href={`#${id}`} isSelected={page === id} />)}
        endContent={user && <TopNavItem label="Settings" href="#settings" isSelected={page === "settings"} />} />
    }>
      <VStack gap={10}>
        {notice && (notice === "error" || user) && (
          <Banner isDismissable onDismiss={() => setNotice(null)} {...notice === "error"
            ? { status: "error", title: "Facebook didn't connect", description: "Nothing was shared with Secnd. You can try again whenever you like." }
            : { status: "success", title: "You're connected", description: "Choose which accounts Secnd can read. You can change this any time." }} />
        )}
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
