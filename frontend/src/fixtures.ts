// Sample data for dev builds only (?fixtures=1). Every name says "Sample"; nothing here is real.
import { ApiError } from "./api";
import type { AgentHome, AgentId, AgentRun, Asset, Me } from "./api";

const now = () => Math.floor(Date.now() / 1000);
const assets: Asset[] = [
  { key: "ads:act_1", kind: "ads", id: "act_1", name: "Sample ad account" },
  { key: "instagram:1", kind: "instagram", id: "1", name: "@sample.studio" },
  { key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Sample WhatsApp number" },
  { key: "whatsapp:2", kind: "whatsapp", id: "2", name: "Sample second number", issues: [{ blocking: true, text: "This number can't send messages yet.", fix: "Add a payment method in WhatsApp Manager.", link: "https://business.facebook.com/wa/manage/home/" }] },
];
let me: Me = { signed_in: true, name: "Sample creator", assets, selected: ["ads:act_1", "instagram:1", "whatsapp:1", "whatsapp:2"], permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "whatsapp_business_messaging"], problems: ["Messages from Sample Page: the Page wasn't shared."] };
let hasKey = false;

const campaign = (name: string, spend: string, clicks: string, ctr: string, cpc: string) => ({
  campaign_id: name, campaign_name: name, spend, impressions: "12000", reach: "8400", clicks, ctr, cpc,
  date_start: "2026-10-27", date_stop: "2026-11-02",
});

const results: Record<AgentId, AgentRun["result"]> = {
  leads: { leads: [{ who: "Sample buyer", channel: "instagram", said: "Do you ship the blue one?", why: "Asked about a product and shipping.", next_step: "Reply with the price and delivery time." }] },
  ideas: { ideas: [{ hook: "Sample hook: three ways to style it", caption: "Sample caption for a reel.", format: "reel", why: "Your reels reached more people this week." }] },
  replies: { replies: [{ event_id: "m1", to: "Sample customer", draft: "Sample draft: yes, we're open until 7 today." }] },
  ads: { summary: "Sample summary: one campaign is doing well, one is costly.", actions: [{ campaign: "Sample spring sale", do: "scale", why: "Clicks cost less than average." }, { campaign: "Sample brand video", do: "pause", why: "Spend with almost no clicks." }] },
};
const runs = new Map<AgentId, AgentRun>();
const customer = { kind: "whatsapp" as const, sender: "15550000001", sender_name: "Sample customer" };
let home: AgentHome = {
  proactive: true, rules: "",
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

export async function answer(method: string, path: string, body: unknown): Promise<unknown> {
  await new Promise(done => setTimeout(done, 300));
  const route = `${method} ${path}`;
  if (route === "GET /api/me") return me;
  if (route === "POST /api/sign-out") return (me = { signed_in: false });
  if (route === "PUT /api/connections" && me.signed_in) {
    me = { ...me, selected: (body as { selected: string[] }).selected };
    return { assets: me.assets, selected: me.selected };
  }
  // The first check finds the sample number fixed.
  if (route === "POST /api/connections/refresh" && me.signed_in) {
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
  if (route === "GET /api/inbox") return { items: [
    { id: "m1", kind: "whatsapp", asset_id: "1", sender: "15550000001", sender_name: "Sample customer", text: "Hi, are you open today?", created: now() - 600, replied: false },
    { id: "m2", kind: "instagram_comment", asset_id: "1", sender: "17841400000000001", sender_name: null, text: "Love this colour!", created: now() - 3600, replied: true },
    { id: "m3", kind: "instagram", asset_id: "1", sender: "17841400000000002", sender_name: "Sample buyer", text: "Do you ship the blue one?", created: now() - 7200, replied: false },
    { id: "m4", kind: "messenger", asset_id: "1", sender: "24000000000000001", sender_name: "", text: "Sample: can I book for Saturday?", created: now() - 86400, replied: false },
  ] };
  if (/^POST \/api\/inbox\/[^/]+\/reply$/.test(route)) return { sent: true };
  if (route === "GET /api/agents") {
    for (const [id, run] of runs) if (run.status === "running" && now() - run.created >= 4) runs.set(id, { ...run, status: "done", result: results[id], cost_usd: 0.004, finished: now() });
    return { runs: [...runs.values()], ai_ready: true, own_key: hasKey, model: "sample-model" };
  }
  const run = route.match(/^POST \/api\/agents\/(leads|ideas|replies|ads)\/run$/);
  if (run) {
    const agent = run[1] as AgentId;
    if (runs.get(agent)?.status === "running") throw new ApiError(409, "That agent is already running.");
    runs.set(agent, { agent, status: "running", result: null, error: null, cost_usd: null, created: now(), finished: null });
    return { agent, status: "running" };
  }
  if (route === "GET /api/agent") return home;
  if (route === "PUT /api/agent/settings") { home = { ...home, ...(body as { proactive: boolean; rules: string }) }; return { proactive: home.proactive, rules: home.rules }; }
  if (/^POST \/api\/agent\/tickets\/\d+\/answer$/.test(route)) { home = { ...home, needs: home.needs.filter(n => n.type !== "question") }; return { state: "open" }; }
  if (route === "GET /api/settings/ai") return { has_key: hasKey, model: "sample-model", workspace_ai: true };
  if (route === "PUT /api/settings/ai") { hasKey = Boolean((body as { api_key: string }).api_key); return { has_key: hasKey, key_saved_at: hasKey ? Math.floor(Date.now() / 1000) : null, model: "sample-model" }; }
  throw new ApiError(404, "Sample data has no answer for this.");
}
