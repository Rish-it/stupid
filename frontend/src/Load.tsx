import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ApiError } from "./api";

/** Shows data as soon as it exists (cached or fresh), else the server's message with a retry, else a spinner. */
export function Load<T>({ state, children }: { state: { data?: T; error?: ApiError; reload: () => Promise<void> }; children: (data: T) => ReactNode }) {
  if (state.data !== undefined) return children(state.data);
  if (state.error) return (
    <VStack gap={2}>
      <Text as="p" type="supporting">{state.error.message}</Text>
      <Button size="sm" label="Try again" clickAction={state.reload} />
    </VStack>
  );
  return <Center minHeight={96}><Spinner aria-label="Loading" /></Center>;
}
