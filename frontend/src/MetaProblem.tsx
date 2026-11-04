import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { InboxKind, Issue } from "./api";
import { explainMeta } from "./metaHelp";

export default function MetaProblem({ issue, title, kind }: { issue: string | Issue; title?: string; kind?: InboxKind }) {
  const help = explainMeta(issue, kind);
  const open = help.link && <Button size="sm" variant={help.blocking ? "primary" : "ghost"} label="Open in Meta" href={help.link} target="_blank" rel="noopener noreferrer" />;
  if (help.blocking) return <Banner status="warning" title={title ?? help.text} description={title ? `${help.text} ${help.fix}` : help.fix} endContent={open} />;
  return <HStack gap={2} align="center" justify="between" wrap="wrap"><Text as="p" type="supporting" size="sm">{help.text} {help.fix}</Text>{open}</HStack>;
}
