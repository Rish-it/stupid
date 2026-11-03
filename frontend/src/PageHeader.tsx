import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";

/** A screen's title, which sticks and shrinks as the screen scrolls. Place it directly in the screen's own stack. */
export default function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <div className="page-title"><Heading level={1}>{title}</Heading></div>
      {description && <Text as="p" type="supporting" className="page-description">{description}</Text>}
    </>
  );
}
