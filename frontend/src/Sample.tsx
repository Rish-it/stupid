import type { CSSProperties } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Persona } from "./api";
import { ownerChat, samplePhotos } from "./fixtures";

// Sample desk only: loaded lazily from sample mode, so fixtures never reach the real app's bundle.

/** "Your WhatsApp": what the agent sends the owner, and the owner's one-key answers. */
export default function SamplePhone({ persona }: { persona: Persona }) {
  const chat = ownerChat[persona];
  return (
    <section aria-labelledby="phone-heading" className="panel">
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2} id="phone-heading" className="panel-title">Your WhatsApp</Heading>
          <Text as="p" type="supporting" size="sm">Your agent pings you here. Messages to you go out on their own; nothing reaches a customer until you reply 1.</Text>
        </VStack>
        <div className="phone" role="group" aria-label={`Sample WhatsApp chat with your agent on ${chat.number}`}>
          <HStack gap={2} align="center" className="phone-top">
            <span className="phone-avatar" aria-hidden>S</span>
            <VStack gap={0}>
              <Text weight="semibold" size="sm">Stupid · your agent</Text>
              <Text type="supporting" size="sm">Sample · to {chat.number}</Text>
            </VStack>
          </HStack>
          <ol className="phone-lines">
            {chat.lines.map((line, i) => (
              <li key={i} data-from={line.from} style={{ "--i": i } as CSSProperties}>
                <span className="phone-text">{line.text}</span>
                <span className="phone-at">{line.from === "owner" ? "You · " : ""}{line.at}</span>
              </li>
            ))}
          </ol>
        </div>
      </VStack>
    </section>
  );
}

/** A drawn stand-in for a customer's photo, labelled so it's never taken for a real one. */
export function SamplePhoto({ id }: { id: string }) {
  const photo = samplePhotos[id];
  if (!photo) return null;
  return (
    <figure className="sample-photo">
      <img src={photo.src} alt={photo.alt} width={160} height={120} />
      <figcaption>Sample photo</figcaption>
    </figure>
  );
}
