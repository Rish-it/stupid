import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Check } from "./Icons";

export type Item = { key: string; text: string; label: string; href?: string; external?: boolean; onClick?: () => void };

/** The agent head's card: one line and one button per thing left, or All set. Loaded when first opened. */
export default function AgentCard({ items }: { items: Item[] }) {
  return (
    <div role="dialog" aria-label={items.length ? "A few things to finish" : "All set"} className="agent-card">
      {items.length ? <VStack gap={3}>
        <Text weight="semibold">A few things to finish</Text>
        <VStack gap={3} as="ul">{items.map(i => (
          <HStack key={i.key} as="li" gap={3} align="center" justify="between">
            <Text size="sm" className="agent-card-text">{i.text}</Text>
            <Link className="agent-card-action" href={i.href ?? "#home"} onClick={i.onClick} isExternalLink={i.external}>{i.label}</Link>
          </HStack>
        ))}</VStack>
      </VStack> : <HStack gap={2} align="center"><Check /><Text weight="semibold">All set</Text></HStack>}
    </div>
  );
}
