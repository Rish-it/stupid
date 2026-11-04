import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { MatchedPost } from "./api";

// Meta writes "+0000"; Safari reads only "+00:00".
const postedOn = (iso: string) => new Date(iso.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Which of the owner's posts a customer's photo shows, or that it is none of them. */
export default function Match({ post }: { post: MatchedPost }) {
  if (!post.matched) return <Text as="p" type="supporting" size="sm">Not one of your posts</Text>;
  return (
    <HStack gap={2} align="center">
      <img className="match-thumb" src={post.thumbnail} alt={post.caption || "Your post"} width={40} height={40} loading="lazy" />
      <VStack gap={0}>
        <Link href={post.permalink} isExternalLink type="supporting" size="sm">Matches your post of {postedOn(post.posted)}</Link>
        {post.caption && <Text type="supporting" size="sm" maxLines={1} aria-hidden>{post.caption}</Text>}
      </VStack>
    </HStack>
  );
}
