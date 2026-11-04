import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { api, apps, senderName, useLoad } from "./api";
import type { Ads as AdsData, AssetKind, Campaign, Connections, Instagram as InstagramData } from "./api";
import { Load } from "./Load";
import SourceIcon from "./SourceIcon";
import { Modal, Page, Stat, Tile } from "./Surface";
import MetaProblem from "./MetaProblem";

const count = (n: number) => n.toLocaleString();
const money = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);

export default function Today({ state }: { state: Connections }) {
  const on = (kind: AssetKind) => state.assets.some(a => a.kind === kind && state.selected.includes(a.key));
  const messaging = on("whatsapp") || on("messenger") || on("instagram");
  return (
    <Page title="Today" description="How your business did over the last 7 days.">
      <div className="bento bento-lead">
        {messaging ? <Messages /> : <Connect icon="chat" title="Messages" kind="whatsapp" />}
        {on("ads") ? <Ads /> : <Connect icon="ads" title="Ads" kind="ads" />}
        {on("instagram") ? <Instagram /> : <Connect icon="instagram" title="Instagram" kind="instagram" />}
      </div>
    </Page>
  );
}

function Connect({ icon, title, kind }: { icon: string; title: string; kind: AssetKind }) {
  const app = apps.find(a => a.kind === kind)!;
  return (
    <Tile icon={icon} title={title} status={<Token size="sm" label="Not connected" />}>
      <Text as="p" type="supporting">{kind === "whatsapp" ? "Connect WhatsApp, Instagram or your Facebook Page to see new messages here." : `Connect ${app.name} to see it here.`}</Text>
      <HStack><Button variant="primary" label={`Connect ${app.name}`} href="#setup" /></HStack>
    </Tile>
  );
}

function Messages() {
  const inbox = useLoad("inbox", api.inbox);
  return (
    <Tile icon="chat" title="Messages" count={inbox.data?.items.length} actions={<Button size="sm" variant="ghost" label="View all" href="#inbox" />}>
      <Load state={inbox}>{({ items }) => {
        const day = items.filter(i => Date.now() / 1000 - i.created < 86400);
        return (
          <VStack gap={4}>
            <Stat label="New in the last day" value={count(day.length)} />
            {items.length ? (
              <VStack gap={3}>
                {items.slice(0, 3).map(i => (
                  <HStack key={i.id} gap={3} align="center">
                    <SourceIcon source={i.kind} size={16} />
                    <VStack gap={0} width="100%">
                      <HStack gap={2} align="center" wrap="wrap">
                        <Text weight="semibold" size="sm">{senderName(i)}</Text>
                        <Timestamp value={i.created} format="relative" type="supporting" size="sm" />
                        {i.replied && <Token size="sm" label="Replied" />}
                      </HStack>
                      <Text as="p" type="supporting" size="sm" maxLines={1}>{i.text}</Text>
                    </VStack>
                  </HStack>
                ))}
              </VStack>
            ) : <Text as="p" type="supporting">No messages yet.</Text>}
          </VStack>
        );
      }}</Load>
    </Tile>
  );
}

function Ads() {
  const ads = useLoad("ads", api.ads);
  const [open, setOpen] = useState(false);
  const rows = ads.data?.accounts.flatMap(a => a.campaigns.map(c => ({ ...c, currency: a.currency }))) ?? [];
  return (
    <>
      <Tile icon="ads" title="Ads" count={ads.data ? rows.length : undefined} actions={rows.length > 0 && <Button size="sm" variant="ghost" label="Details" onClick={() => setOpen(true)} />}>
        <Load state={ads}>{() => <AdsSummary rows={rows} />}</Load>
      </Tile>
      {ads.data && <AdsDetails isOpen={open} onClose={() => setOpen(false)} data={ads.data} />}
    </>
  );
}

type Row = Campaign & { currency: string };
// Cost per click ranks campaigns; one that spent with no clicks is always the worst.
const perClick = (c: Campaign) => Number(c.clicks) > 0 ? Number(c.spend) / Number(c.clicks) : Infinity;
const line = (c: Row) => Number(c.clicks) > 0
  ? `${count(Number(c.clicks))} clicks at ${money(perClick(c), c.currency)} each`
  : `${money(Number(c.spend), c.currency)} spent, no clicks yet`;

function AdsSummary({ rows }: { rows: Row[] }) {
  if (!rows.length) return <MetaProblem issue="adsEmpty" />;
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.spend));
  const spend = [...totals].map(([cur, sum]) => money(sum, cur)).join(" + ");
  const ranked = rows.filter(r => Number(r.spend) > 0).sort((a, b) => perClick(a) - perClick(b));
  return (
    <VStack gap={3}>
      <Stat label="Spent on ads" value={spend} />
      {ranked[0] && <Text as="p" size="sm">Doing best: <strong>{ranked[0].campaign_name}</strong>, {line(ranked[0])}.</Text>}
      {ranked.length > 1 && <Text as="p" size="sm">Costing most: <strong>{ranked.at(-1)!.campaign_name}</strong>, {line(ranked.at(-1)!)}.</Text>}
    </VStack>
  );
}

function AdsDetails({ isOpen, onClose, data }: { isOpen: boolean; onClose: () => void; data: AdsData }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Ads, last 7 days" subtitle="Straight from Meta Ads Manager."
      footer={<Button variant="primary" label="Ask the Ad watcher" href="#agents" onClick={onClose} />}>
      {data.accounts.map(a => (
        <VStack key={a.id} gap={3}>
          <Text weight="semibold">{a.name}</Text>
          {a.campaigns.length ? a.campaigns.map(c => (
            <VStack key={c.campaign_id} gap={2}>
              
              <Text as="p" weight="semibold" size="sm">{c.campaign_name}</Text>
              <Grid columns={3} gap={3}>
                <Stat label="Spent" value={money(Number(c.spend), a.currency)} />
                <Stat label="Clicks" value={count(Number(c.clicks))} />
                <Stat label="Reach" value={count(Number(c.reach))} />
              </Grid>
            </VStack>
          )) : <MetaProblem issue="adsEmpty" />}
        </VStack>
      ))}
      <Text as="p" type="supporting" size="sm">Change your ads in Meta Ads Manager. Stupid doesn't edit them.</Text>
    </Modal>
  );
}

function Instagram() {
  const ig = useLoad("instagram", api.instagram);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tile icon="instagram" title="Instagram" actions={Boolean(ig.data?.accounts.length) && <Button size="sm" variant="ghost" label="Details" onClick={() => setOpen(true)} />}>
        <Load state={ig}>{({ accounts }) => {
          if (!accounts.length) return <MetaProblem issue="instagramMissing" />;
          return accounts.map(a => {
            const insight = (name: string) => a.insights.find(i => i.name === name)?.value;
            const reach = insight("reach"), engaged = insight("accounts_engaged");
            return (
              <VStack key={a.id} gap={3}>
                <Grid columns={3} gap={3}>
                  <Stat label="Reach" value={reach === undefined ? "–" : count(reach)} />
                  <Stat label="Followers" value={count(a.profile.followers_count)} />
                  <Stat label="Engaged" value={engaged === undefined ? "–" : count(engaged)} />
                </Grid>
                {a.insights_error && <MetaProblem issue={a.insights_error} title="Instagram didn't share reach this week" />}
                {!a.insights_error && !a.insights.length && <MetaProblem issue="instagramInsights" />}
                {!a.media.length && <MetaProblem issue="instagramEmpty" />}
              </VStack>
            );
          });
        }}</Load>
      </Tile>
      {ig.data && <InstagramDetails isOpen={open} onClose={() => setOpen(false)} data={ig.data} />}
    </>
  );
}

function InstagramDetails({ isOpen, onClose, data }: { isOpen: boolean; onClose: () => void; data: InstagramData }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Instagram, last 7 days" footer={<Button variant="primary" label="Get post ideas" href="#agents" onClick={onClose} />}>
      {data.accounts.map(a => {
        const top = [...a.media].sort((x, y) => (y.like_count ?? 0) + (y.comments_count ?? 0) - (x.like_count ?? 0) - (x.comments_count ?? 0)).slice(0, 5);
        return (
          <VStack key={a.id} gap={4}>
            <Text weight="semibold">@{a.profile.username}</Text>
            <Grid columns={3} gap={3}>
              <Stat label="Posts" value={count(a.profile.media_count)} />
              <Stat label="Followers" value={count(a.profile.followers_count)} />
              <Stat label="Following" value={count(a.profile.follows_count)} />
            </Grid>
            <Text weight="semibold">Top posts</Text>
            {top.length ? top.map(m => (
              <Link hasUnderline key={m.id} href={m.permalink} isExternalLink maxLines={1}>
                {`${m.caption?.split("\n")[0] || "Untitled post"} · ${count(m.like_count ?? 0)} likes, ${count(m.comments_count ?? 0)} comments`}
              </Link>
            )) : <MetaProblem issue="instagramEmpty" />}
          </VStack>
        );
      })}
    </Modal>
  );
}
