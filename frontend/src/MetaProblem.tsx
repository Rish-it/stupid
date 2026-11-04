import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { InboxKind, Issue } from "./api";
import { explainMeta } from "./metaHelp";

export default function MetaProblem({ issue, title, kind }: { issue: string | Issue; title?: string; kind?: InboxKind }) {
  const help = explainMeta(issue, kind);
  const open = help.link && <Button size="sm" variant={help.blocking ? "primary" : "ghost"} label="Open in Meta" href={help.link} target="_blank" rel="noopener noreferrer" />;
  // The button sits under the words, so a phone keeps the warning full width.
  if (help.blocking) return <Banner status="warning" title={title ?? help.text} description={<VStack gap={3} hAlign="start">{title ? `${help.text} ${help.fix}` : help.fix}{open}</VStack>} />;
  return <HStack gap={2} align="center" justify="between" wrap="wrap"><Text as="p" type="supporting" size="sm">{help.text} {help.fix}</Text>{open}</HStack>;
}
