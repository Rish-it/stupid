import { BotAvatar } from "bot-avatars";

/** Stupid's mascot: a plush bot that follows the pointer, hops when clicked and gets busy while `excited`. Loaded on its own, outside the first-load JS. */
export default function Mascot({ excited }: { excited: boolean }) {
  return <BotAvatar type="circle" face="mouth" color="#405c35" size="var(--mascot-size)" state={excited ? "working" : "default"} aria-hidden />;
}
