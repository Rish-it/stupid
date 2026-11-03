import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { api, oauthStartUrl, sample, useLoad } from "./api";

const pages = { today: "Today", inbox: "Inbox", agents: "Agents", connections: "Connections", settings: "Settings" } as const;
type Page = keyof typeof pages;
const nav: Page[] = ["today", "inbox", "agents", "connections"];
const Connections = lazy(() => import("./Connections"));
const Today = lazy(() => import("./Today"));
const Inbox = lazy(() => import("./Inbox"));
const Agents = lazy(() => import("./Agents"));

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
  const loading = <Center minHeight={240}><Spinner size="lg" aria-label="Loading" /></Center>;

  let body;
  if (user && page === "connections") body = <Suspense fallback={loading}><Connections state={user} onChange={next => me.setData({ ...user, ...next })} /></Suspense>;
  else if (user && page === "today") body = <Suspense fallback={loading}><Today state={user} /></Suspense>;
  else if (user && page === "inbox") body = <Suspense fallback={loading}><Inbox /></Suspense>;
  else if (user && page === "agents") body = <Suspense fallback={loading}><Agents state={user} /></Suspense>;
  else if (user) body = <EmptyState headingLevel={1} title={pages[page]} description="This screen is on its way." />;
  else if (me.data || me.error?.status === 401) body = (
    <EmptyState headingLevel={1} title="Run your Meta business in plain words"
      description="Sign in with Facebook, then connect Ads, Instagram and WhatsApp one at a time. You choose what Secnd can see."
      actions={<Button variant="primary" label="Continue with Facebook" href={oauthStartUrl} />} />
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
        <Text as="p" type="supporting" justify="center">Built for Meta's platform. Not an official Meta product.</Text>
      </VStack>
    </AppShell>
  );
}
