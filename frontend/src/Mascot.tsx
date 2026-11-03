import { BotAvatar } from "bot-avatars";

/** Stupid's mascot: a plush bot in Meta blue that follows the pointer, hops when clicked and gets to work while `busy`. Loaded on its own, outside the first-load JS. */
export default function Mascot({ busy, size }: { busy: boolean; size: string }) {
  return <BotAvatar type="circle" face="mouth" color="#0064E0" brightness={1.2} size={size} state={busy ? "working" : "default"} aria-hidden />;
}
