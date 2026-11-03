import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { api, apps, senderName, useLoad } from "./api";
import type { AssetKind, Campaign, Connections } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";

const count = (n: number) => n.toLocaleString();
const money = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);

export default function Today({ state }: { state: Connections }) {
  const on = (kind: AssetKind) => state.assets.some(a => a.kind === kind && state.selected.includes(a.key));
  const messaging = on("whatsapp") || on("messenger") || on("instagram");
  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={1}>Today</Heading>
        <Text as="p" type="supporting">How your business did over the last 7 days.</Text>
      </VStack>
      <Grid columns={{ minWidth: 300 }} gap={4}>
        <Tile kind="ads" title="Ads">{on("ads") ? <Ads /> : <Connect kind="ads" />}</Tile>
        <Tile kind="instagram" title="Instagram">{on("instagram") ? <Instagram /> : <Connect kind="instagram" />}</Tile>
        <Tile kind="whatsapp" title="Messages">{messaging ? <Messages /> : <Connect kind="whatsapp" />}</Tile>
      </Grid>
    </VStack>
  );
}

function Tile({ kind, title, children }: { kind: AssetKind; title: string; children: ReactNode }) {
  return (
    <Card variant="muted">
      <VStack gap={4}>
        <HStack gap={3} align="center"><SourceIcon source={kind} /><Heading level={2}>{title}</Heading></HStack>
        {children}
      </VStack>
    </Card>
  );
}

function Connect({ kind }: { kind: AssetKind }) {
  const app = apps.find(a => a.kind === kind)!;
  return (
    <VStack gap={3}>
      <Text as="p" type="supporting">{kind === "whatsapp" ? "Connect WhatsApp, Instagram or your Facebook Page to see new messages here." : `Connect ${app.name} to see it here.`}</Text>
      <Button variant="primary" label={`Connect ${app.name}`} href="#connections" />
    </VStack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={1}>
      <Text type="supporting">{label}</Text>
      <Text type="display-3" hasTabularNumbers>{value}</Text>
    </VStack>
  );
}

function Ads() {
  return <Load state={useLoad("ads", api.ads)}>{({ accounts }) => {
    const rows = accounts.flatMap(a => a.campaigns.map(c => ({ ...c, currency: a.currency })));
    if (!rows.length) return <Text as="p" type="supporting">No ad results in the last 7 days.</Text>;
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.spend));
    const spend = [...totals].map(([cur, sum]) => money(sum, cur)).join(" + ");
    // Cost per click ranks campaigns; one that spent with no clicks is always the worst.
    const perClick = (c: Campaign) => Number(c.clicks) > 0 ? Number(c.spend) / Number(c.clicks) : Infinity;
    const ranked = rows.filter(r => Number(r.spend) > 0).sort((a, b) => perClick(a) - perClick(b));
    const line = (c: (typeof rows)[number]) => Number(c.clicks) > 0
      ? `${count(Number(c.clicks))} clicks at ${money(perClick(c), c.currency)} each`
      : `${money(Number(c.spend), c.currency)} spent, no clicks yet`;
    return (
      <VStack gap={4}>
        <Stat label="Spent on ads" value={spend} />
        {ranked[0] && <Text as="p">Doing best: <strong>{ranked[0].campaign_name}</strong>, {line(ranked[0])}.</Text>}
        {ranked.length > 1 && <Text as="p">Costing most: <strong>{ranked.at(-1)!.campaign_name}</strong>, {line(ranked.at(-1)!)}.</Text>}
        <Link hasUnderline href="#agents">Ask the Ad watcher what to change</Link>
      </VStack>
    );
  }}</Load>;
}

function Instagram() {
  return <Load state={useLoad("instagram", api.instagram)}>{({ accounts }) => {
    if (!accounts.length) return <Text as="p" type="supporting">Instagram didn't return an account.</Text>;
    return accounts.map(a => {
      const insight = (name: string) => a.insights.find(i => i.name === name)?.value;
      const reach = insight("reach"), engaged = insight("accounts_engaged");
      const top = [...a.media].sort((x, y) => (y.like_count ?? 0) + (y.comments_count ?? 0) - (x.like_count ?? 0) - (x.comments_count ?? 0)).slice(0, 3);
      return (
        <VStack key={a.id} gap={4}>
          <Grid columns={3} gap={3}>
            <Stat label="Reach" value={reach === undefined ? "–" : count(reach)} />
            <Stat label="Followers" value={count(a.profile.followers_count)} />
            <Stat label="Engaged" value={engaged === undefined ? "–" : count(engaged)} />
          </Grid>
          {a.insights_error && <Text as="p" type="supporting">Instagram didn't share reach this week: {a.insights_error}</Text>}
          {top.length > 0 && (
            <VStack gap={2}>
              <Text weight="semibold">Top posts</Text>
              {top.map(m => (
                <Link hasUnderline key={m.id} href={m.permalink} isExternalLink maxLines={1}>
                  {`${m.caption?.split("\n")[0] || "Untitled post"} · ${count(m.like_count ?? 0)} likes, ${count(m.comments_count ?? 0)} comments`}
                </Link>
              ))}
            </VStack>
          )}
        </VStack>
      );
    });
  }}</Load>;
}

function Messages() {
  return <Load state={useLoad("inbox", api.inbox)}>{({ items }) => {
    const day = items.filter(i => Date.now() / 1000 - i.created < 86400);
    return (
      <VStack gap={4}>
        <Stat label="New in the last day" value={count(day.length)} />
        {items.slice(0, 3).map(i => <Text key={i.id} as="p" maxLines={1}><strong>{senderName(i)}</strong>: {i.text}</Text>)}
        {items.length ? <Link hasUnderline href="#inbox">Open your inbox</Link> : <Text as="p" type="supporting">No messages yet.</Text>}
      </VStack>
    );
  }}</Load>;
}
