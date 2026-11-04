import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { api, oauthStartUrl, useLoad, whatsappBlock } from "./api";
import type { Account } from "./api";
import { Check } from "./Icons";

const Mascot = lazy(() => import("./Mascot"));
type Item = { key: string; text: string; label: string; href?: string; external?: boolean; onClick?: () => void };

/**
 * The agent's head, bottom right on every signed-in page. What's left to fix or finish lives here, not in the page:
 * the next setup step, Meta refusing the owner's WhatsApp number, and account problems Meta reported.
 */
export default function AgentHead({ account, onSetup }: { account: Account; onSetup: () => void }) {
  const setup = useLoad("setup-next", api.setupNext).data;
  const owner = useLoad("owner-channel", api.ownerChannel).data;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector<HTMLElement>(".agent-head")?.focus(); } };
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", away);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", away); };
  }, [open]);

  const items: Item[] = [];
  const step = setup?.persona ? setup.step : undefined;
  if (step) items.push(step.action === "fix_in_meta" ? { key: step.id, text: step.title, label: "Fix in Meta", href: step.link ?? undefined, external: true }
    : step.action === "connect" ? { key: step.id, text: step.title, label: step.button, href: oauthStartUrl }
    : { key: step.id, text: step.title, label: "Finish setup", onClick: () => { setOpen(false); location.hash = "#home"; onSetup(); } });
  const blocked = owner?.channel !== "messenger" ? whatsappBlock(account, owner?.asset_id) : undefined;
  if (blocked) items.push({ key: "wa", text: blocked.text, label: "Fix in Meta", href: blocked.link ?? "#settings", external: Boolean(blocked.link) });
  for (const p of account.problems ?? []) items.push({ key: p, text: p, label: "Connect", href: oauthStartUrl });

  return (
    <div ref={box} className="agent-head-wrap">
      {open && <div role="dialog" aria-label={items.length ? "A few things to finish" : "All set"} className="agent-card">
        {items.length ? <VStack gap={3}>
          <Text weight="semibold">A few things to finish</Text>
          <VStack gap={3} as="ul">{items.map(i => (
            <HStack key={i.key} as="li" gap={3} align="center" justify="between">
              <Text size="sm" className="agent-card-text">{i.text}</Text>
              <Button size="sm" label={i.label} href={i.href} onClick={i.onClick} {...(i.external ? { target: "_blank", rel: "noopener noreferrer" } : {})} />
            </HStack>
          ))}</VStack>
        </VStack> : <HStack gap={2} align="center"><Check /><Text weight="semibold">All set</Text></HStack>}
      </div>}
      <button type="button" className="agent-head" aria-expanded={open} aria-haspopup="dialog"
        aria-label={items.length ? `Your agent: ${items.length} ${items.length === 1 ? "thing" : "things"} to finish` : "Your agent: all set"} onClick={() => setOpen(o => !o)}>
        <Suspense fallback={<span className="agent-head-face" />}><Mascot busy={false} size="44px" /></Suspense>
        {items.length > 0 && <span className="agent-head-count" aria-hidden>{items.length}</span>}
      </button>
    </div>
  );
}
