import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { api, oauthStartUrl, useLoad } from "./api";

const pages = { today: "Today", inbox: "Inbox", agents: "Agents", connections: "Connections", settings: "Settings" } as const;
type Page = keyof typeof pages;
const nav: Page[] = ["today", "inbox", "agents", "connections"];
const Connections = lazy(() => import("./Connections"));

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
  const loading = <Center minHeight={240}><Spinner size="lg" aria-label="Loading" /></Center>;

  let body;
  if (user && page === "connections") body = <Suspense fallback={loading}><Connections state={user} onChange={next => me.setData({ ...user, ...next })} /></Suspense>;
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
    <AppShell contentPadding={6} topNav={
      <TopNav label="Main navigation"
        heading={<TopNavHeading heading="Secnd" headingHref="#today" />}
        startContent={user && nav.map(id => <TopNavItem key={id} label={pages[id]} href={`#${id}`} isSelected={page === id} />)}
        endContent={user && <TopNavItem label="Settings" href="#settings" isSelected={page === "settings"} />} />
    }>
      <VStack gap={10}>
        {body}
        <Text as="p" type="supporting" justify="center">Built for Meta's platform. Not an official Meta product.</Text>
      </VStack>
    </AppShell>
  );
}
