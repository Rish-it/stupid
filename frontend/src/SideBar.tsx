import { Avatar } from "@astryxdesign/core/Avatar";
import { AgentsIcon, InboxIcon, Logo, TodayIcon } from "./Icons";

const items = [["home", "Home", TodayIcon], ["inbox", "Inbox", InboxIcon], ["agents", "Agents", AgentsIcon]] as const;

/** The signed-in navigation: a slim rail of named icons on wide screens, a bottom bar on phones. Settings sits behind the avatar. */
export default function SideBar({ page, name }: { page: string; name: string }) {
  return (
    <nav aria-label="Main" className="rail">
      <a href="#home" className="rail-logo" aria-label="Stupid, home"><Logo size={28} /></a>
      {items.map(([id, label, Glyph]) => (
        <a key={id} href={`#${id}`} className="rail-item" aria-current={page === id ? "page" : undefined}>
          <Glyph width={20} height={20} aria-hidden />{label}
        </a>
      ))}
      <a href="#settings" className="rail-item rail-me" aria-current={page === "settings" ? "page" : undefined}>
        <Avatar name={name} size="sm" tooltip={false} aria-hidden />Settings
      </a>
    </nav>
  );
}
