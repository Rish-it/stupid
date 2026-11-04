// Sample data for ?fixtures=1, loaded only then. Every name says "Sample"; nothing here is real.
import { ApiError, appStatus, factsPrompt } from "./api";
import type { Account, AgentHome, AgentId, AgentRun, Asset, AssetKind, InboxItem, McpKey, Me, Persona, SetupNext, SetupStep } from "./api";

const now = () => Math.floor(Date.now() / 1000);
const assets: Asset[] = [
  { key: "ads:act_1", kind: "ads", id: "act_1", name: "Sample ad account" },
  { key: "instagram:1", kind: "instagram", id: "1", name: "@sample.studio" },
  { key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Sample WhatsApp number" },
  { key: "whatsapp:2", kind: "whatsapp", id: "2", name: "Sample second number", issues: [{ blocking: true, text: "This number can't send messages yet.", fix: "Add a payment method in WhatsApp Manager.", link: "https://business.facebook.com/wa/manage/home/" }] },
];
let me: Me = { signed_in: true, name: "Sample creator", persona: null, assets, selected: ["ads:act_1", "instagram:1", "whatsapp:1", "whatsapp:2"], permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "whatsapp_business_messaging"], problems: ["Messages from Sample Page: the Page wasn't shared."] };
const tutorial = new URLSearchParams(location.search);
const tutorialKind = tutorial.get("tutorial");
if (["instagram", "whatsapp", "messenger", "ads"].includes(tutorialKind ?? "")) {
  const kind = tutorialKind as Asset["kind"];
  const stage = tutorial.get("stage") ?? "connect";
  const fixes = {
    instagram: { text: "Instagram messages aren't shared yet.", fix: "In Meta Business Suite, open Inbox → Instagram and allow access to messages.", link: "https://business.facebook.com/latest/inbox" },
    whatsapp: { text: "Meta has locked this WhatsApp account.", fix: "Open Business Support Home, select this account and follow the reason shown.", link: "https://business.facebook.com/business-support-home/" },
    messenger: { text: "Your Page access doesn't include messages.", fix: "Ask someone with full control to assign you messaging access.", link: "https://www.facebook.com/business/help/1101781386943864" },
    ads: { text: "This ad account has an unpaid balance.", fix: "Open Billing & payments and select this ad account.", link: "https://business.facebook.com/latest/billing_hub/payment_methods/" },
  };
  const asset: Asset = { key: `${kind}:1`, kind, id: "1", name: `Sample ${kind} account`, issues: stage === "fix" ? [{ blocking: true, ...fixes[kind] }] : [] };
  me = { signed_in: true, name: "Sample first-timer", persona: null, assets: stage === "connect" ? [] : [asset], selected: stage === "choose" || stage === "connect" ? [] : [asset.key],
    permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments", "instagram_manage_messages", "pages_messaging", "whatsapp_business_messaging"], problems: [] };
}

// ?persona=creator|business&stage=out|new|setup|ready|busy: one person at one point of their path.
const persona = (["creator", "business"] as const).find(p => p === tutorial.get("persona")) ?? null;
const stage = tutorial.get("stage") ?? "";
const world = ["out", "new", "setup", "ready", "busy"].includes(stage) && !tutorialKind;
const sampleAds: Asset = { key: "ads:act_1", kind: "ads", id: "act_1", name: "Sample ad account" };
const people: Record<Persona, { name: string; assets: Asset[]; issue: NonNullable<Asset["issues"]>[number] }> = {
  creator: {
    name: "Sample creator",
    assets: [{ key: "instagram:1", kind: "instagram", id: "1", name: "@sample.creator" }, sampleAds],
    issue: { blocking: true, text: "Instagram is still a personal account.", fix: "Switch it to a professional account and link it to your Facebook Page.", link: "https://help.instagram.com/502981923235522" },
  },
  business: {
    name: "Sample bakery",
    assets: [{ key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Sample Bakery number" }, { key: "messenger:1", kind: "messenger", id: "1", name: "Sample Bakery Page" }, sampleAds],
    issue: { blocking: true, text: "This WhatsApp number can't send messages yet.", fix: "Add a payment method for this WhatsApp account in Billing & payments.", link: "https://business.facebook.com/latest/billing_hub/payment_methods/" },
  },
};
if (world) {
  const who = people[persona ?? "business"];
  const shared = stage === "new" ? [] : stage === "setup" ? who.assets.filter(a => a.kind !== "ads").map((a, i) => i ? a : { ...a, issues: [who.issue] }) : who.assets;
  me = stage === "out" ? { signed_in: false } : {
    signed_in: true, name: persona ? who.name : "Sample person", persona, assets: shared, selected: shared.map(a => a.key), problems: [],
    permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments", "instagram_manage_messages", "pages_messaging", "whatsapp_business_messaging"],
  };
}
let hasKey = false;
let brain: "open" | "meta" = "open";
let mcp: Omit<McpKey, "url"> = { has_key: false, created: null, last_used: null };

const campaign = (name: string, spend: string, clicks: string, ctr: string, cpc: string) => ({
  campaign_id: name, campaign_name: name, spend, impressions: "12000", reach: "8400", clicks, ctr, cpc,
  date_start: "2026-10-27", date_stop: "2026-11-02",
});

const results: Record<AgentId, AgentRun["result"]> = {
  leads: { leads: [{ who: "Sample buyer", channel: "instagram", said: "Do you ship the blue one?", why: "Asked about a product and shipping.", next_step: "Reply with the price and delivery time." }] },
  ideas: { ideas: [{ hook: "Sample hook: three ways to style it", caption: "Sample caption for a reel.", format: "reel", why: "Your reels reached more people this week." }] },
  replies: { replies: [{ event_id: "m1", to: "Sample customer", draft: "Sample draft: yes, we're open until 7 today." }] },
  reels: { from_captions_only: false, watched: [{ video: 1, caption: "Sample Reel", permalink: "https://www.instagram.com/", works: [{ at: "0:00-0:02", what: "Sample: the product is in frame in the first second." }], drop_off_guesses: [{ at: "0:08", what: "Sample guess: the middle is slow." }] }],
    scripts: [{ title: "Sample script", hook: "Sample hook", caption: "Sample caption", shots: [{ shot: "Sample close-up", seconds: 2, on_screen: "Sample text", sound: "Sample sound" }] }] },
  ads: { summary: "Sample summary: one campaign is doing well, one is costly.", actions: [{ campaign: "Sample spring sale", do: "scale", why: "Clicks cost less than average." }, { campaign: "Sample brand video", do: "pause", why: "Spend with almost no clicks." }] },
};
const runs = new Map<AgentId, AgentRun>();
const customer = { kind: "whatsapp" as const, sender: "15550000001", sender_name: "Sample customer" };
let home: AgentHome = {
  proactive: true, rules: "", watching: ["whatsapp", "instagram"], last_checked: now() - 120,
  facts: [{ id: 1, question: "Sample question: do you deliver on Sundays?", answer: "Sample answer: yes, before noon.", created: now() - 86400 }],
  needs: [
    { type: "question", id: 2, question: "Sample question: what does delivery to Pune cost?", created: now() - 300, message: { ...customer, sender_name: "Sample buyer", text: "Sample: how much is delivery to Pune?" } },
    { type: "draft", id: 1, event_id: "m1", text: "Sample draft: yes, we're open until 7 today.", source: "agent", created: now() - 540, message: { ...customer, text: "Hi, are you open today?" } },
  ],
  tickets: [
    { id: 2, job: "replies", state: "open", created: now() - 320, message: { ...customer, sender_name: "Sample buyer" }, reports: [
      { kind: "progress", text: "Sample: asks about delivery cost.", created: now() - 320 }, { kind: "question", text: "Sample question: what does delivery to Pune cost?", created: now() - 300 }, { kind: "waiting", text: "Waiting for your answer.", created: now() - 300 }] },
    { id: 1, job: "replies", state: "ended", created: now() - 600, message: customer, reports: [
      { kind: "progress", text: "Sample: asks if the shop is open.", created: now() - 600 }, { kind: "ready", text: "Sample: drafted a reply about today's hours.", created: now() - 540 }] },
  ],
};

// What each path's agents found, for the busy stage.
const found: Record<Persona, Partial<Record<AgentId, AgentRun["result"]>>> = {
  creator: {
    reels: { from_captions_only: false,
      watched: [{ video: 1, caption: "Sample Reel: three ways to style one jacket", permalink: "https://www.instagram.com/", works: [{ at: "0:00-0:02", what: "Sample: you hold the jacket up to the camera in the first second." }], drop_off_guesses: [{ at: "0:11", what: "Sample guess: the second outfit repeats the first." }] }],
      scripts: [{ title: "Sample script: one jacket, three cities", hook: "Sample hook: which city wears it best?", caption: "Sample caption: same jacket, three moods.", shots: [
        { shot: "Sample: close-up of the zip", seconds: 2, on_screen: "One jacket", sound: "Zip pull" },
        { shot: "Sample: walk past a café", seconds: 4, on_screen: "Paris", sound: "Street noise" }] }] },
    ideas: { looked_at: 6, ideas: [
      { hook: "Sample idea: the outfit your followers asked for", caption: "Sample caption: you asked, so here it is.", format: "carousel", why: "Sample: your carousel of last week got twice the comments." },
      { hook: "Sample idea: 10-second closet tour", caption: "Sample caption: a peek inside.", format: "reel", why: "Sample: short Reels kept people watching longest." }] },
    leads: { leads: [{ who: "Sample Shoe Co", channel: "instagram", said: "Sample: we'd love to send you our new trainers for a Reel. What are your rates?", why: "Sample: a brand asking for a paid collab.", next_step: "Reply with your rate and what a Reel includes." }] },
  },
  business: {
    replies: { replies: [{ event_id: "b1", to: "Sample customer", draft: "Sample draft: yes, the chocolate cake is ₹650 and we deliver in Bandra." }] },
    leads: { leads: [{ who: "Sample office manager", channel: "whatsapp", said: "Sample: can you do 40 cupcakes for Friday?", why: "Sample: a large order with a date.", next_step: "Confirm the price for 40 and the delivery time." }] },
    ads: { summary: "Sample summary: the weekend offer brings messages cheaply; the brand video costs a lot per click.", actions: [{ campaign: "Sample weekend offer", do: "scale", why: "Sample: messages cost less than average." }, { campaign: "Sample brand video", do: "pause", why: "Sample: spend with almost no clicks." }] },
  },
};
const ask: Record<Persona, AgentHome["needs"]> = {
  creator: [
    { type: "question", id: 12, question: "Sample question: what's your rate for one Reel?", created: now() - 240, message: { kind: "instagram", sender: "17841400000000009", sender_name: "Sample Shoe Co", text: "Sample: what are your rates for a Reel?" } },
    { type: "draft", id: 11, event_id: "c1", text: "Sample draft: thank you! The jacket is from a small shop, link in bio.", source: "agent", created: now() - 600, message: { kind: "instagram_comment", sender: "17841400000000003", sender_name: "Sample fan", text: "Sample: where is the jacket from?" } },
  ],
  business: [
    { type: "question", id: 22, question: "Sample question: do you deliver to Andheri, and what does it cost?", created: now() - 180, message: { kind: "whatsapp", sender: "15550000002", sender_name: "Sample buyer", text: "Sample voice note: hi, can you deliver to Andheri tomorrow?" } },
    { type: "draft", id: 21, event_id: "b1", text: "Sample draft: yes, the chocolate cake is ₹650 and we deliver in Bandra.", source: "agent", created: now() - 420, message: { kind: "whatsapp", sender: "15550000001", sender_name: "Sample customer", text: "Sample: how much is this cake? (Photo: a chocolate cake)" } },
  ],
};
const messages: Record<Persona, InboxItem[]> = {
  creator: [
    { id: "c1", kind: "instagram_comment", asset_id: "1", sender: "17841400000000003", sender_name: "Sample fan", text: "Sample: where is the jacket from?", created: now() - 900, replied: false,
      draft: { text: "Sample draft: thank you! The jacket is from a small shop, link in bio.", source: "agent" } },
    { id: "c2", kind: "instagram", asset_id: "1", sender: "17841400000000009", sender_name: "Sample Shoe Co", text: "Sample: what are your rates for a Reel?", created: now() - 1800, replied: false },
  ],
  business: [
    { id: "b1", kind: "whatsapp", asset_id: "1", sender: "15550000001", sender_name: "Sample customer", text: "Sample: how much is this cake?\n(Photo: a chocolate cake with berries.)", created: now() - 600, replied: false,
      draft: { text: "Sample draft: yes, the chocolate cake is ₹650 and we deliver in Bandra.", source: "agent" } },
    { id: "b2", kind: "whatsapp", asset_id: "1", sender: "15550000002", sender_name: "Sample buyer", text: "Sample voice note: hi, can you deliver to Andheri tomorrow?", created: now() - 900, replied: false, voice: true },
    { id: "b3", kind: "messenger", asset_id: "1", sender: "24000000000000001", sender_name: "Sample neighbour", text: "Sample: are you open on Sunday?", created: now() - 7200, replied: false },
  ],
};
const order: Record<Persona, AgentId[]> = { creator: ["reels", "ideas", "leads", "replies", "ads"], business: ["replies", "leads", "ads", "ideas", "reels"] };
if (world) {
  const watching = me.signed_in ? [...new Set(me.assets.filter(a => a.kind !== "ads").map(a => a.kind))] : [];
  home = { proactive: true, rules: stage === "ready" || stage === "busy" ? "Sample rules." : "", facts: [], needs: [], tickets: [], watching, last_checked: watching.length ? now() - 120 : null };
  if (stage === "busy" && persona) {
    home.needs = ask[persona];
    home.tickets = ask[persona].map(n => ({ id: n.id, job: "replies", state: n.type === "question" ? "open" : "ended", created: n.created, message: n.message,
      reports: [{ kind: n.type === "question" ? "waiting" : "ready", text: n.type === "question" ? "Waiting for your answer." : "Sample: drafted a reply.", created: n.created }] }));
    for (const [agent, result] of Object.entries(found[persona]) as [AgentId, AgentRun["result"]][])
      runs.set(agent, { agent, status: "done", result, error: null, cost_usd: 0.004, created: now() - 1200, finished: now() - 1140, models: agent === "reels" ? ["Muse Wonder"] : ["Muse Spark Open"] });
  }
}
const inbox = () => world ? (stage === "busy" && persona ? messages[persona] : []) : [
  { id: "m1", kind: "whatsapp", asset_id: "1", sender: "15550000001", sender_name: "Sample customer", text: "Hi, are you open today?", created: now() - 600, replied: false },
  { id: "m2", kind: "instagram_comment", asset_id: "1", sender: "17841400000000001", sender_name: null, text: "Love this colour!", created: now() - 3600, replied: true },
  { id: "m3", kind: "instagram", asset_id: "1", sender: "17841400000000002", sender_name: "Sample buyer", text: "Do you ship the blue one?", created: now() - 7200, replied: false },
  { id: "m4", kind: "messenger", asset_id: "1", sender: "24000000000000001", sender_name: "", text: "Sample: can I book for Saturday?", created: now() - 86400, replied: false },
];

/** The sample answer to GET /api/setup/next, worked out like the server does from /api/me and the agent's rules. */
export function localNext(me: Account & { persona?: Persona | null }, rules: string, persona = me.persona ?? null): SetupNext {
  if (!persona) return { persona: null, done: false, progress: { done: 0, total: 0 } };
  const main: AssetKind = persona === "creator" ? "instagram" : "whatsapp";
  const on = (kind: AssetKind) => appStatus(me, kind).on;
  const issue = on(main).flatMap(a => a.issues ?? []).find(i => i.blocking);
  // Every step this path needs, each with whether it's passed; the first one not passed is next.
  const steps: [passed: boolean, step: () => SetupStep][] = persona === "creator" ? [
    [on("instagram").length > 0, () => ({ id: "instagram_connect", app: "instagram", title: "Connect Instagram", why: "Stupid watches your Reels and reads your comments and DMs.", action: "connect", button: "Connect Instagram", optional: false })],
  ] : [
    // Like the server: one step for both while the Page is missing too, its button naming both.
    [on("whatsapp").length > 0, () => on("messenger").length > 0
      ? { id: "whatsapp_connect", app: "whatsapp", title: "Connect WhatsApp", why: "Stupid hears your customers' chats, voice notes and photos.", action: "connect", button: "Connect WhatsApp", optional: false }
      : { id: "whatsapp_connect", app: "whatsapp", title: "Connect WhatsApp and your Facebook Page", why: "Stupid hears your customers' chats, voice notes and photos.", action: "connect", button: "Connect WhatsApp and Page", optional: false }],
    [on("messenger").length > 0, () => ({ id: "page_connect", app: "messenger", title: "Connect your Facebook Page", why: "Stupid answers Messenger chats from your Page too.", action: "connect", button: "Connect your Page", optional: false })],
  ];
  steps.push(
    [on(main).length > 0 && !issue, () => ({ id: persona === "creator" ? "instagram_issue" : "whatsapp_payment", app: main, title: issue!.text, why: "Your agent can't answer until Meta has this.", fix: issue!.fix, action: "fix_in_meta", button: "Open in Meta", link: issue!.link ?? undefined, optional: false })],
    [Boolean(rules.trim()), () => ({ id: "agent_facts", app: "agent", title: "Tell your agent about you", why: factsPrompt[persona], action: "tell_agent", button: "Save", optional: true })],
  );
  const left = steps.filter(([passed]) => !passed).map(([, step]) => step);
  const next = left[0]?.();
  return { persona, done: left.length === 0 || (left.length === 1 && next?.optional === true), progress: { done: steps.length - left.length, total: steps.length }, step: next };
}

export async function answer(method: string, path: string, body: unknown): Promise<unknown> {
  await new Promise(done => setTimeout(done, 300));
  const route = `${method} ${path}`;
  if (route === "GET /api/me") return me;
  if (route === "PUT /api/me/persona" && me.signed_in) return (me = { ...me, persona: (body as { persona: Persona }).persona });
  if (route === "GET /api/setup/next" && me.signed_in) return localNext(me, home.rules);
  if (route === "POST /api/sign-out") return (me = { signed_in: false });
  if (route === "PUT /api/connections" && me.signed_in) {
    me = { ...me, selected: (body as { selected: string[] }).selected };
    return { assets: me.assets, selected: me.selected };
  }
  // The first check finds the sample number fixed.
  if (route === "POST /api/connections/refresh" && me.signed_in) {
    if (tutorial.get("refresh") === "fail") throw new ApiError(502, "Meta could not be reached. Try again.");
    me = { ...me, assets: me.assets.map(a => ({ ...a, issues: [] })) };
    return { assets: me.assets, selected: me.selected, permissions: me.permissions, problems: me.problems ?? [] };
  }
  if (route === "DELETE /api/connections") return (me = { signed_in: false });
  if (route === "GET /api/ads") return { accounts: [{ id: "act_1", name: "Sample ad account", currency: "USD", status: 1, campaigns: [
    campaign("Sample spring sale", "84.20", "312", "2.6", "0.27"),
    campaign("Sample brand video", "41.00", "18", "0.15", "2.28"),
  ] }] };
  if (route === "GET /api/instagram") return { accounts: [{ id: "1",
    profile: { username: "sample.studio", name: "Sample Studio", followers_count: 1520, follows_count: 210, media_count: 48 },
    media: [1, 2, 3].map(i => ({ id: `p${i}`, caption: `Sample post ${i}`, media_type: "IMAGE", timestamp: new Date(Date.now() - i * 864e5).toISOString(), like_count: 120 / i, comments_count: 9 - i * 2, permalink: "https://www.instagram.com/" })),
    insights: [{ name: "reach", value: 6400 }, { name: "views", value: 9100 }, { name: "accounts_engaged", value: 380 }, { name: "total_interactions", value: 512 }],
    insights_error: null }] };
  if (route === "GET /api/inbox") return { items: inbox() };
  const reply = route.match(/^POST \/api\/inbox\/([^/]+)\/reply$/);
  if (reply) {
    // As on the server: a sent reply clears its draft from "Needs you" and marks the message replied.
    home = { ...home, needs: home.needs.filter(n => n.type !== "draft" || n.event_id !== reply[1]) };
    for (const item of inbox()) if (item.id === reply[1]) Object.assign(item, { replied: true, draft: null });
    return { sent: true };
  }
  if (route === "GET /api/agents") {
    for (const [id, run] of runs) if (run.status === "running" && now() - run.created >= 4) runs.set(id, { ...run, status: "done", result: results[id], cost_usd: 0.004, finished: now(), models: ["Muse Spark Open"] });
    const path: AgentId[] = me.signed_in && me.persona ? order[me.persona] : ["leads", "ideas", "replies", "reels", "ads"];
    return { runs: [...runs.values()], ai_ready: true, own_key: hasKey, model: "sample-model", order: path };
  }
  const run = route.match(/^POST \/api\/agents\/(leads|ideas|reels|replies|ads)\/run$/);
  if (run) {
    const agent = run[1] as AgentId;
    if (runs.get(agent)?.status === "running") throw new ApiError(409, "That agent is already running.");
    runs.set(agent, { agent, status: "running", result: null, error: null, cost_usd: null, created: now(), finished: null, models: [] });
    return { agent, status: "running" };
  }
  if (route === "GET /api/mcp/key") return { ...mcp, url: "https://app.example.com/mcp" };
  if (route === "POST /api/mcp/key") { mcp = { has_key: true, created: now(), last_used: null }; return { key: "stupid_sample_key_not_real", created: mcp.created }; }
  if (route === "DELETE /api/mcp/key") { mcp = { has_key: false, created: null, last_used: null }; return { has_key: false }; }
  if (route === "GET /api/agent") return home;
  if (route === "PUT /api/agent/settings") { home = { ...home, ...(body as { proactive: boolean; rules: string }) }; return { proactive: home.proactive, rules: home.rules }; }
  const fact = /^DELETE \/api\/agent\/facts\/(\d+)$/.exec(route);
  if (fact) { home = { ...home, facts: home.facts.filter(f => f.id !== Number(fact[1])) }; return { facts: home.facts }; }
  if (/^POST \/api\/agent\/tickets\/\d+\/answer$/.test(route)) { home = { ...home, needs: home.needs.filter(n => n.type !== "question") }; return { state: "open" }; }
  if (route === "GET /api/settings/ai" || route === "PUT /api/settings/ai/brain") {
    if (route.startsWith("PUT")) brain = (body as { brain: "open" | "meta" }).brain;
    return { has_key: hasKey, model: brain === "meta" ? "muse-spark-1.3" : "sample-model", workspace_ai: true, brain, meta_brain: true, open_model: "sample-model", meta_model: "muse-spark-1.3" };
  }
  if (route === "PUT /api/settings/ai") { hasKey = Boolean((body as { api_key: string }).api_key); return { has_key: hasKey, key_saved_at: hasKey ? Math.floor(Date.now() / 1000) : null, model: "sample-model" }; }
  throw new ApiError(404, "Sample data has no answer for this.");
}
