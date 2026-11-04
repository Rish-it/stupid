import { Avatar } from "@astryxdesign/core/Avatar";
import { AgentsIcon, InboxIcon, Logo, SetupIcon, TodayIcon } from "./Icons";

const items = [["home", "Home", TodayIcon], ["inbox", "Inbox", InboxIcon], ["agents", "Agents", AgentsIcon]] as const;

/** The signed-in navigation: a slim icon rail on wide screens, a bottom bar on phones. Settings sits behind the avatar. */
export default function SideBar({ page, setup, name }: { page: string; setup: boolean; name: string }) {
  const shown = setup ? [...items, ["setup", "Setup", SetupIcon] as const] : items;
  return (
    <nav aria-label="Main" className="rail">
      <a href="#home" className="rail-logo" aria-label="Stupid, home"><Logo size={28} /></a>
      {shown.map(([id, label, Glyph]) => (
        <a key={id} href={`#${id}`} className="rail-item" data-label={label} aria-label={label} aria-current={page === id ? "page" : undefined}>
          <Glyph width={20} height={20} aria-hidden />
        </a>
      ))}
      <a href="#settings" className="rail-item rail-me" data-label="Settings" aria-label="Settings" aria-current={page === "settings" ? "page" : undefined}>
        <Avatar name={name} size="sm" tooltip={false} aria-hidden />
      </a>
    </nav>
  );
}
