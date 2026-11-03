import { Link } from "@astryxdesign/core/Link";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { legal } from "./api";
import { AgentsIcon, InboxIcon, SettingsIcon, SetupIcon, TodayIcon } from "./Icons";

const items = { today: ["Today", TodayIcon], inbox: ["Inbox", InboxIcon], agents: ["Agents", AgentsIcon], setup: ["Setup", SetupIcon] } as const;

/** The signed-in navigation. Loaded on its own, outside the first-load JS. Setup is listed until it's done. */
export default function SideBar({ page, setup }: { page: string; setup: boolean }) {
  const shown = (["today", "inbox", "agents", ...setup ? ["setup"] as const : []] as const);
  return (
    <SideNav footer={
      <VStack gap={3}>
        <SideNavItem size="lg" label="Settings" icon={SettingsIcon} href="#settings" isSelected={page === "settings"} />
        <VStack gap={1} paddingInline={3}>
          <HStack as="nav" aria-label="Legal" gap={3} wrap="wrap">
            {legal.map(([label, href]) => <Link key={href} href={href} type="supporting" size="sm">{label}</Link>)}
          </HStack>
          <Text as="p" type="supporting" size="sm">Built for Meta's platform. Not an official Meta product.</Text>
        </VStack>
      </VStack>
    }>
      <SideNavSection title="Workspace" isHeaderHidden>
        {shown.map(id => <SideNavItem key={id} size="lg" label={items[id][0]} icon={items[id][1]} href={`#${id}`} isSelected={page === id} />)}
      </SideNavSection>
    </SideNav>
  );
}
