// Sample data for ?fixtures=1, loaded only then. Every screen carries the Sample banner; every person, brand and number here is made up.
import { ApiError, appStatus, factsPrompt } from "./api";
import type { Account, AgentControl, AgentHome, AgentId, AgentMessage, AgentRun, Asset, AssetKind, Fact, InboxItem, MatchedPost, McpKey, Me, Persona, SetupNext, SetupStep, Style } from "./api";

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
    name: "@sample.trails (sample travel creator)",
    assets: [{ key: "instagram:1", kind: "instagram", id: "1", name: "@sample.trails" }, sampleAds],
    issue: { blocking: true, text: "Instagram is still a personal account.", fix: "Switch it to a professional account and link it to your Facebook Page.", link: "https://help.instagram.com/502981923235522" },
  },
  business: {
    name: "Crumb & Co. (sample bakery, Pune)",
    assets: [{ key: "whatsapp:1", kind: "whatsapp", id: "1", name: "Crumb & Co. WhatsApp (sample)" }, { key: "messenger:1", kind: "messenger", id: "1", name: "Crumb & Co. Page (sample)" }, sampleAds],
    issue: { blocking: true, text: "This WhatsApp number can't send messages yet.", fix: "Add a payment method for this WhatsApp account in Billing & payments.", link: "https://business.facebook.com/latest/billing_hub/payment_methods/" },
  },
};
if (world) {
  const who = people[persona ?? "business"];
  // The busy bakery also answers on Instagram.
  const assets = stage === "busy" && persona === "business" ? [...who.assets, { key: "instagram:1", kind: "instagram" as const, id: "1", name: "@crumbandco.sample" }] : who.assets;
  const shared = stage === "new" ? [] : stage === "setup" ? assets.filter(a => a.kind !== "ads").map((a, i) => i ? a : { ...a, issues: [who.issue] }) : assets;
  me = stage === "out" ? { signed_in: false } : {
    signed_in: true, name: persona ? who.name : "Sample person", persona, assets: shared, selected: shared.map(a => a.key), problems: [],
    permissions: ["ads_read", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments", "instagram_manage_messages", "pages_messaging", "whatsapp_business_messaging"],
  };
}
let hasKey = false;
let aiModel = "meta-models/muse-spark-open-1026";
const aiModels = [
  { id: "meta-models/muse-spark-open-1026", label: "Muse Spark Open 1026 · open weights", provider: "baseten", open_weights: true },
  { id: "meta-models/muse-spark-open", label: "Muse Spark Open · open weights", provider: "baseten", open_weights: true },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3 · Meta API", provider: "meta", open_weights: false },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2 · Meta API", provider: "meta", open_weights: false },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1 · Meta API", provider: "meta", open_weights: false },
] as const;
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
let style: Style = { style: { note: "Sample: short and warm, starts with Hi, one emoji at most.", length: "short", greeting: "Hi", emoji: "one at most", language: "English", sign_off: "none" }, built: now() - 3600, from: 4, sent: 4, message: null };
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

// The busy stage: one believable week for each sample, Crumb & Co. (a sample bakery in Pune) and @sample.trails
// (a sample travel creator). Every person and brand in it is made up.
const minutes = (n: number) => now() - n * 60;
const hours = 60, days = 1440;
// The model ids the server names, as it sends them.
const spark = "meta-models/muse-spark-open-1026", heard = "muse-voice-transcribe-1.0";
/** A drawn stand-in for a photo, never a real one. */
const drawn = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">${body}</svg>`)}`;
const pictures = {
  cake: drawn(`<rect width="160" height="120" fill="#F3E6D8"/><ellipse cx="80" cy="98" rx="60" ry="9" fill="#D9C3AD"/><rect x="30" y="52" width="100" height="44" rx="6" fill="#5B3A2E"/><rect x="30" y="52" width="100" height="10" rx="5" fill="#7A4D3B"/><circle cx="48" cy="50" r="6" fill="#C4384F"/><circle cx="66" cy="46" r="6" fill="#3B4F9C"/><circle cx="84" cy="50" r="6" fill="#C4384F"/><circle cx="102" cy="46" r="6" fill="#3B4F9C"/><circle cx="117" cy="50" r="5" fill="#C4384F"/>`),
  macarons: drawn(`<rect width="160" height="120" fill="#EDE7DF"/><rect x="18" y="30" width="124" height="64" rx="8" fill="#FFFFFF"/>${[0, 1, 2, 3].map(i => `<rect x="${28 + i * 28}" y="44" width="22" height="12" rx="6" fill="#9DBE8A"/><rect x="${28 + i * 28}" y="66" width="22" height="12" rx="6" fill="#9DBE8A"/>`).join("")}`),
  lemon: drawn(`<rect width="160" height="120" fill="#F6F0E1"/><rect x="26" y="50" width="108" height="44" rx="10" fill="#E3B04B"/><path d="M30 56 q12 10 24 0 t24 0 t24 0 t24 0" stroke="#FFFFFF" stroke-width="6" fill="none"/><circle cx="60" cy="44" r="5" fill="#F29BB1"/><circle cx="80" cy="42" r="5" fill="#FFFFFF"/><circle cx="100" cy="44" r="5" fill="#F29BB1"/>`),
  waterfall: drawn(`<rect width="160" height="120" fill="#BFE0F2"/><path d="M0 120 L0 40 L50 20 L60 120 Z" fill="#3F7D4E"/><path d="M160 120 L160 36 L104 18 L96 120 Z" fill="#356B43"/><rect x="62" y="22" width="32" height="98" fill="#F4FBFF"/><rect x="70" y="22" width="6" height="98" fill="#CFE8F6"/><ellipse cx="78" cy="112" rx="40" ry="8" fill="#E6F4FB"/>`),
  beach: drawn(`<rect width="160" height="70" fill="#F2A65A"/><circle cx="110" cy="62" r="14" fill="#FBD38D"/><rect y="70" width="160" height="50" fill="#2F6F8F"/><rect x="20" y="64" width="80" height="5" fill="#3B2A20"/>${[24, 44, 64, 84].map(x => `<rect x="${x}" y="69" width="3" height="18" fill="#3B2A20"/>`).join("")}`),
  cafe: drawn(`<rect width="160" height="120" fill="#CFE3EE"/><path d="M0 80 L40 30 L80 80 Z" fill="#8FA7B8"/><path d="M60 80 L110 22 L160 80 Z" fill="#7B95A8"/><path d="M98 34 L110 22 L122 34 Z" fill="#FFFFFF"/><rect y="80" width="160" height="40" fill="#7A4E2D"/>${[10, 34, 58, 82, 106, 130].map(x => `<rect x="${x}" y="70" width="6" height="30" fill="#5A3820"/>`).join("")}<rect y="70" width="160" height="6" fill="#5A3820"/>`),
};
/** The customer photos in the samples, by message id, for the "Sample photo" stand-in. */
export const samplePhotos: Record<string, { src: string; alt: string }> = {
  b1: { src: pictures.cake, alt: "Drawing of a chocolate cake with berries" },
  b3: { src: pictures.macarons, alt: "Drawing of a tray of pistachio macarons" },
  b14: { src: pictures.lemon, alt: "Drawing of a lemon loaf with flowers" },
  c1: { src: pictures.waterfall, alt: "Drawing of a waterfall in a green valley" },
  c4: { src: pictures.beach, alt: "Drawing of a beach at sunset with a pier" },
  c20: { src: pictures.cafe, alt: "Drawing of a café balcony with mountains behind" },
};
const post = (post_id: string, caption: string, posted: string, thumbnail: string): MatchedPost => ({ matched: true, post_id, permalink: "https://www.instagram.com/", caption, posted, thumbnail });
const cake = post("p1", "Sample post: chocolate berry cake, 1 kg", "2026-10-20T18:30:00+0000", pictures.cake);
const lemon = post("p2", "Sample post: lemon drizzle loaf with edible flowers", "2026-10-12T09:10:00+0000", pictures.lemon);
const falls = post("p3", "Sample post: the waterfall nobody finds before 9 AM", "2026-10-18T07:45:00+0000", pictures.waterfall);
const balcony = post("p4", "Sample post: the café balcony in old Manali", "2026-10-02T11:20:00+0000", pictures.cafe);
const notOurs: MatchedPost = { matched: false };

// What the owner told their agent once, kept as facts; drafts below say when they drew on one.
const learned: Record<Persona, Fact[]> = {
  business: [
    { id: 1, question: "What does the chocolate berry cake cost?", answer: "₹650 for 1 kg; delivery in Pune is ₹60.", created: minutes(3 * days) },
    { id: 2, question: "Can the cupcakes be eggless?", answer: "Yes, all of them: ₹80 each, order a day ahead.", created: minutes(4 * days) },
    { id: 3, question: "What do bulk brownie boxes cost?", answer: "₹450 for a box of 6; free delivery over ₹5,000 in Pune.", created: minutes(5 * days) },
    { id: 4, question: "Do you deliver on Sundays?", answer: "Yes, 9 AM to 1 PM, Pune city only.", created: minutes(6 * days) },
    { id: 5, question: "How far ahead do custom cakes need ordering?", answer: "Two days; three for tiered cakes.", created: minutes(6 * days + 5 * hours) },
  ],
  creator: [
    { id: 1, question: "How do people reach the waterfall from your Reel?", answer: "A 40-minute walk from the village; go before 9 AM.", created: minutes(2 * days) },
    { id: 2, question: "What do you shoot on?", answer: "My phone and a small gimbal; the full list is in my highlights.", created: minutes(4 * days) },
    { id: 3, question: "When did you go to Spiti?", answer: "Late September, right after the monsoon.", created: minutes(5 * days) },
    { id: 4, question: "Do you take stays instead of a fee?", answer: "Only places I'd book anyway, and the post always says it's a collab.", created: minutes(6 * days) },
  ],
};
const told = (p: Persona, id: number) => { const f = learned[p].find(f => f.id === id)!; return { answer: f.answer, told: f.created }; };
const styles: Record<Persona, NonNullable<Style["style"]>> = {
  business: { note: "Warm and short. Starts with \"Hi <name>!\", gives the price in ₹ and when it's ready, one emoji at most.", length: "short", greeting: "Hi <name>!", emoji: "one at most", language: "English, a little Hinglish", sign_off: "none" },
  creator: { note: "Friendly and quick. First name, one useful detail, points to the guide or highlights. No hashtags.", length: "short", greeting: "Hey <name>!", emoji: "one, often 🌿", language: "English", sign_off: "none" },
};

type Week = { item: InboxItem; need?: AgentHome["needs"][number] };
const chat = (id: string, kind: InboxItem["kind"], sender: string, sender_name: string, text: string, ago: number, more: Partial<InboxItem> = {}): InboxItem =>
  ({ id, kind, asset_id: "1", sender, sender_name, text, created: minutes(ago), replied: true, ...more });
/** A message the agent drafted for: the Inbox item, and the same draft waiting in Needs you. */
function drafted(id: number, item: InboxItem, text: string, how: { used?: ReturnType<typeof told>; match?: MatchedPost; photo?: string; voice?: string }): Week {
  const models = { ...how.voice || how.photo ? { described_by: how.voice ? heard : spark } : {}, drafted_by: spark };
  const draft = { text, source: "agent", styled: true, used: how.used ?? null, models };
  const message: AgentMessage = { kind: item.kind, sender: item.sender, sender_name: item.sender_name, text: item.text,
    voice: item.voice ? { transcript: item.text, model: heard } : null, photo: how.photo ? { description: how.photo, model: spark } : null };
  return { item: { ...item, replied: false, draft, matched_post: how.match ?? null },
    need: { type: "draft", id, event_id: item.id, text, source: "agent", created: item.created + 40, message, styled: true, used: how.used ?? null, matched_post: how.match ?? null, models } };
}
const asked = (id: number, item: InboxItem, question: string, ask_first = false): Week =>
  ({ item: { ...item, replied: false }, need: { type: "question", id, question, ask_first, created: item.created + 40, message: { kind: item.kind, sender: item.sender, sender_name: item.sender_name, text: item.text } } });

const week: Record<Persona, Week[]> = {
  business: [
    drafted(21, chat("b1", "whatsapp", "15550100001", "Rohan", "How much is this one? Need it for Saturday evening.\n(Photo: a chocolate cake with berries on top.)", 12, { photo: true }),
      "Hi Rohan! That's our chocolate berry cake, ₹650 for 1 kg. Saturday evening works: pick it up after 4 PM, or we deliver in Pune for ₹60 🎂",
      { used: told("business", 1), match: cake, photo: "A round chocolate cake topped with raspberries and blueberries." }),
    drafted(22, chat("b2", "whatsapp", "15550100002", "Ishita", "Hi, do you do eggless cupcakes? My daughter is allergic to eggs. I'd need twelve for Sunday.", 25, { voice: true }),
      "Hi Ishita! Yes, all our cupcakes can be eggless. Twelve for Sunday is ₹960, ready by 11 AM 😊", { used: told("business", 2), voice: heard }),
    drafted(23, chat("b3", "instagram", "17841400000100003", "Meera", "Do you make these? Saw them somewhere.\n(Photo: a tray of pistachio macarons.)", 40, { photo: true }),
      "Hi Meera! Those aren't ours, but we bake rose and pistachio cookies every morning, ₹40 each. Shall I keep a few for you?",
      { match: notOurs, photo: "A white tray with eight pale green macarons." }),
    asked(24, chat("b4", "messenger", "24000000000100004", "Kabir", "Can you deliver a 2 kg cake to Hinjewadi on Friday? How much?", 55), "Do you deliver to Hinjewadi, and what does it cost?"),
    asked(25, chat("b5", "messenger", "24000000000100005", "Tara", "Are you open on Diwali?", 80), "Shall I draft a reply to this message?", true),
    drafted(26, chat("b6", "whatsapp", "15550100006", "Ananya", "Perfect, confirmed! Can you add a small card on each box saying 'Happy Diwali, team'?", 95),
      "Of course, Ananya! A card on every box, no extra charge. See you Friday 🪔", {}),
    { item: chat("b7", "whatsapp", "15550100006", "Ananya", "Hi, Ananya here from a design studio in Baner. We need 40 boxes of brownies for our Diwali party on Friday. Can you do it, and what will it cost?", 3 * hours, { voice: true }) },
    { item: chat("b8", "instagram_comment", "17841400000100008", "Farhan", "That sourdough crust 😍 Do you bake it every day?", 5 * hours) },
    { item: chat("b9", "whatsapp", "15550100009", "Sneha", "Picked up the red velvet, it was gone in ten minutes. Thank you!", days + 30) },
    { item: chat("b10", "whatsapp", "15550100010", "Arjun", "Is the walnut brownie there today or should I pre-order?", days + 2 * hours, { voice: true }) },
    { item: chat("b11", "messenger", "24000000000100011", "Neha (school PTA, sample)", "We're planning sports day on 15 Nov. Could you do 80 cupcakes with blue icing? Please send a quote.", days + 5 * hours) },
    { item: chat("b12", "instagram", "17841400000100012", "Dev", "Do you ship to Mumbai?", 2 * days) },
    { item: chat("b13", "whatsapp", "15550100013", "Vikram", "Can I get the croissant box at 7 AM tomorrow?", 2 * days + 3 * hours) },
    { item: chat("b14", "whatsapp", "15550100014", "Priya", "Is this the one from your post? Want it for my mom's birthday.\n(Photo: a lemon loaf with flowers on top.)", 2 * days + 6 * hours, { photo: true, matched_post: lemon }) },
    { item: chat("b15", "whatsapp", "15550100001", "Rohan", "Hi! Are you open tomorrow?", 3 * days) },
    { item: chat("b16", "messenger", "24000000000100004", "Kabir", "Hi, do you do custom cakes?", 3 * days + 2 * hours) },
    { item: chat("b17", "instagram_comment", "17841400000100017", "Zoya", "Recipe for the cardamom buns please 🙏", 3 * days + 5 * hours) },
    { item: chat("b18", "whatsapp", "15550100018", "Rahul (co-working office, sample)", "Do you do monthly snack boxes for an office of 25?", 4 * days) },
    { item: chat("b19", "instagram", "17841400000100003", "Meera", "Love your page!", 4 * days + 6 * hours) },
    { item: chat("b20", "whatsapp", "15550100002", "Ishita", "Do you have a menu I can see?", 5 * days) },
    { item: chat("b21", "messenger", "24000000000100021", "Aditi", "My order came 20 minutes late yesterday and the box was dented.", 5 * days + 4 * hours) },
    { item: chat("b22", "instagram_comment", "17841400000100022", "Sameer", "Best croissant in Pune, no contest.", 6 * days) },
    { item: chat("b23", "whatsapp", "15550100023", "Lata", "Namaste, do you take orders for a three-tier wedding cake? It's in December.", 6 * days + 3 * hours, { voice: true }) },
    { item: chat("b24", "messenger", "24000000000100005", "Tara", "Do you have parking near the shop?", 6 * days + 8 * hours) },
  ],
  creator: [
    drafted(11, chat("c1", "instagram", "17841400000200001", "Riya", "Is this the waterfall from your Reel? How do we get there?\n(Photo: a tall waterfall in a green valley.)", 10, { photo: true }),
      "Hey Riya! Yes, that's the one. It's a 40-minute walk from the village; go before 9 AM and you'll have it to yourself 🌿",
      { used: told("creator", 1), match: falls, photo: "A tall, narrow waterfall between two green hills." }),
    asked(12, chat("c2", "instagram", "17841400000200002", "Kavya (Sample Luggage Co.)", "Loved your Spiti series! We'd like one Reel and three Stories for our new cabin bag. What's your rate?", 30), "What's your rate for one Reel plus three Stories?"),
    drafted(13, chat("c3", "instagram", "17841400000200003", "Arnav", "Hey! Planning Meghalaya in December. Is it too cold? And what do you shoot on?", 45, { voice: true }),
      "Hey Arnav! December is cool, around 8 to 15°C, so pack a light jacket. I shoot on my phone and a small gimbal; the full list is in my highlights.",
      { used: told("creator", 2), voice: heard }),
    drafted(14, chat("c4", "instagram", "17841400000200004", "Jay", "Is this your shot? Someone reposted it.\n(Photo: a beach at sunset with a pier.)", 70, { photo: true }),
      "Thanks for looking out, Jay! That one isn't mine; I haven't shot that beach yet 🙏", { match: notOurs, photo: "A wooden pier running into the sea at sunset." }),
    asked(15, chat("c5", "instagram", "17841400000200005", "Meher (Sample Homestays)", "Would you stay with us in Kasol for three nights in exchange for a Reel?", 90), "Shall I draft a reply to this message?", true),
    drafted(16, chat("c6", "instagram_comment", "17841400000200006", "Leo", "Which month did you go to Spiti?", 2 * hours),
      "Late September, right after the monsoon. Roads open, skies clear!", { used: told("creator", 3) }),
    { item: chat("c7", "instagram", "17841400000200007", "Nikhil (Sample Trek Gear)", "We'd like to send you our new rain jacket for your next trek. Paid collab, ₹25,000 for one Reel.", 3 * hours + 20) },
    { item: chat("c8", "instagram_comment", "17841400000200008", "Sana", "This edit is so smooth 😍", 3 * hours + 40) },
    { item: chat("c9", "instagram_comment", "17841400000200009", "Rohit", "Budget for the whole Spiti trip?", 5 * hours) },
    { item: chat("c10", "instagram", "17841400000200010", "Tanvi", "Can you share your Ladakh itinerary?", days + 3 * hours) },
    { item: chat("c11", "instagram", "17841400000200002", "Kavya (Sample Luggage Co.)", "Hi! Are you open to brand collabs?", days + 6 * hours) },
    { item: chat("c12", "instagram", "17841400000200003", "Arnav", "Big fan of your Meghalaya Reel!", 2 * days) },
    { item: chat("c13", "instagram", "17841400000200013", "Megha", "Hi, I'm travelling solo. Is Spiti okay to do alone?", 2 * days + 4 * hours, { voice: true }) },
    { item: chat("c14", "instagram_comment", "17841400000200014", "Kabir", "Drone or phone?", 2 * days + 8 * hours) },
    { item: chat("c15", "instagram", "17841400000200015", "Ira (Sample Cafés)", "We run three cafés in Manali. Would you feature us? We can pay ₹15,000.", 3 * days) },
    { item: chat("c16", "instagram", "17841400000200001", "Riya", "Your Reels got me into travel!", 3 * days + 4 * hours) },
    { item: chat("c17", "instagram_comment", "17841400000200017", "Dhruv", "Song name?", 4 * days) },
    { item: chat("c18", "instagram", "17841400000200018", "Pooja", "How do you plan your shots before a trip?", 4 * days + 5 * hours) },
    { item: chat("c19", "instagram_comment", "17841400000200019", "Aman", "Next stop?", 5 * days) },
    { item: chat("c20", "instagram", "17841400000200020", "Neel", "Is this the café from your Manali vlog?\n(Photo: a wooden café balcony with mountains behind.)", 5 * days + 6 * hours, { photo: true, matched_post: balcony }) },
    { item: chat("c21", "instagram_comment", "17841400000200021", "Zara", "Saving this for my honeymoon 😂", 6 * days) },
    { item: chat("c22", "instagram", "17841400000200022", "Ishaan", "Do you run photography workshops?", 6 * days + 5 * hours) },
  ],
};

// What each path's agents found, for the busy stage.
const found: Record<Persona, Partial<Record<AgentId, AgentRun["result"]>>> = {
  creator: {
    reels: { from_captions_only: false,
      watched: [
        { video: 1, caption: "Sample Reel: the waterfall nobody finds before 9 AM", permalink: "https://www.instagram.com/", works: [
          { at: "0:00-0:02", what: "The waterfall is in frame from the first second, with the sound of it." }, { at: "0:06-0:09", what: "Your feet on the trail make the walk feel close." }],
          drop_off_guesses: [{ at: "0:14", what: "Guess: the map screenshot is still for four seconds." }] },
        { video: 2, caption: "Sample Reel: Spiti in five cups of chai", permalink: "https://www.instagram.com/", works: [{ at: "0:00-0:03", what: "A cup steaming in cold air is a hook on its own." }],
          drop_off_guesses: [{ at: "0:20", what: "Guess: the third and fourth cups look alike." }] },
      ],
      scripts: [
        { title: "Meghalaya's living root bridge, before the crowds", hook: "It took 150 years to grow this bridge.", caption: "Get there by 7 AM and it's just you and the river. Route in my guide.", shots: [
          { shot: "Close-up of roots wrapped around a stone", seconds: 2, on_screen: "150 years to grow", sound: "River" },
          { shot: "Walk onto the bridge, camera at your feet", seconds: 3, on_screen: "6:52 AM", sound: "Footsteps" },
          { shot: "Wide shot, you small in the middle", seconds: 3, on_screen: "Nobody else here", sound: "River swells" },
          { shot: "The crowd at 10 AM, same spot", seconds: 2, on_screen: "10 AM", sound: "Chatter" },
          { shot: "Back to the empty bridge", seconds: 3, on_screen: "Go early. Route in bio.", sound: "River" }] },
        { title: "What ₹8,000 got me in Spiti for four days", hook: "Four days, ₹8,000, no flights.", caption: "Every rupee, in order. Save it for your trip.", shots: [
          { shot: "Bus ticket held up to the window", seconds: 2, on_screen: "Bus ₹1,400", sound: "Engine" },
          { shot: "Homestay room, door opening", seconds: 2, on_screen: "Stay ₹3,200", sound: "Door creak" },
          { shot: "Thali on a wooden table", seconds: 2, on_screen: "Food ₹2,100", sound: "Plates" },
          { shot: "Shared taxi on a mountain road", seconds: 3, on_screen: "Taxi ₹1,300", sound: "Wind" }] },
      ] },
    ideas: { looked_at: 24, ideas: [
      { hook: "Five places in Spiti that aren't on Google Maps", caption: "Pins in my guide. Go slow.", format: "carousel", why: "Your Spiti carousel got the most saves this month." },
      { hook: "Packing for the mountains in one cabin bag", caption: "Everything I carried for 12 days.", format: "reel", why: "Three people asked what you pack this week." },
      { hook: "Answering your top 5 travel questions", caption: "Budget, safety, gear and more.", format: "story", why: "Budget and safety came up in DMs again and again." },
    ] },
    leads: { leads: [
      { who: "Kavya, Sample Luggage Co.", channel: "instagram", said: "We'd like one Reel and three Stories for our new cabin bag. What's your rate?", why: "A brand asking for a paid package.", next_step: "Answer your rate in Needs you; I'll draft the reply." },
      { who: "Nikhil, Sample Trek Gear", channel: "instagram", said: "Paid collab, ₹25,000 for one Reel.", why: "A paid offer with a price.", next_step: "You sent a yes on WhatsApp. Ask for the brief and the posting date." },
      { who: "Ira, Sample Cafés", channel: "instagram", said: "Would you feature us? We can pay ₹15,000.", why: "A paid feature, below your usual rate.", next_step: "Reply with your rate, or offer a Story instead." },
      { who: "Meher, Sample Homestays", channel: "instagram", said: "Three nights in Kasol in exchange for a Reel?", why: "A stay instead of a fee.", next_step: "Only if you'd book it anyway, as you told me." },
    ] },
    replies: { replies: [{ event_id: "c1", to: "Riya", draft: "Hey Riya! Yes, that's the one." }, { event_id: "c3", to: "Arnav", draft: "Hey Arnav! December is cool." }, { event_id: "c4", to: "Jay", draft: "Thanks for looking out, Jay!" }, { event_id: "c6", to: "Leo", draft: "Late September." }] },
  },
  business: {
    replies: { replies: [{ event_id: "b1", to: "Rohan", draft: "Hi Rohan! That's our chocolate berry cake." }, { event_id: "b2", to: "Ishita", draft: "Hi Ishita! Yes, all our cupcakes can be eggless." }, { event_id: "b3", to: "Meera", draft: "Hi Meera! Those aren't ours." }, { event_id: "b6", to: "Ananya", draft: "Of course, Ananya!" }] },
    leads: { leads: [
      { who: "Ananya, a design studio in Baner", channel: "whatsapp", said: "40 boxes of brownies for our Diwali party on Friday.", why: "₹18,000 order with a date.", next_step: "Confirmed on WhatsApp. Bake on Thursday evening." },
      { who: "Neha, a school PTA in Kothrud", channel: "messenger", said: "80 cupcakes with blue icing for sports day on 15 Nov.", why: "A large order with a date, asking for a quote.", next_step: "Send the price for 80 (₹6,400 at ₹80 each) and the delivery time." },
      { who: "Rahul, a co-working office", channel: "whatsapp", said: "Monthly snack boxes for an office of 25?", why: "Repeat business every month.", next_step: "Offer a trial box this Friday." },
      { who: "Lata", channel: "whatsapp", said: "A three-tier wedding cake in December.", why: "A big custom order, weeks ahead.", next_step: "Ask for the date and number of guests." },
    ] },
    ads: { summary: "This week ₹3,840 brought 46 WhatsApp chats. The weekend brownie offer brings a chat for about ₹38; the brand video spent ₹1,200 for 9 clicks.", actions: [
      { campaign: "Weekend brownie offer (sample)", do: "scale", why: "The cheapest chats you've had this month." },
      { campaign: "Diwali gift boxes (sample)", do: "keep", why: "Steady orders; it ends on its own on Sunday." },
      { campaign: "Bakery brand video (sample)", do: "pause", why: "₹1,200 spent for 9 clicks and no chats." }] },
    ideas: { looked_at: 18, ideas: [
      { hook: "5 AM: 200 croissants, one rolling pin", caption: "Ever wondered why they flake? Watch.", format: "reel", why: "Your behind-the-counter Reel reached twice your usual." },
      { hook: "Which Diwali box are you?", caption: "Four boxes, four kinds of people. Tag yours.", format: "carousel", why: "Diwali box questions came in five times this week." },
      { hook: "The eggless menu, all in one place", caption: "Every cake and cupcake, eggless on request.", format: "photo", why: "Customers ask about eggless every few days." },
    ] },
  },
};
const order: Record<Persona, AgentId[]> = { creator: ["reels", "ideas", "leads", "replies", "ads"], business: ["replies", "leads", "ads", "ideas", "reels"] };
if (world) {
  const watching = me.signed_in ? [...new Set(me.assets.filter(a => a.kind !== "ads").map(a => a.kind))] : [];
  home = { proactive: true, rules: stage === "ready" || stage === "busy" ? "Sample rules." : "", facts: [], needs: [], tickets: [], watching, last_checked: watching.length ? now() - 120 : null };
  if (stage === "busy" && persona) {
    home.rules = persona === "business" ? "Crumb & Co., a sample bakery in Pune. Open 8 AM to 9 PM, closed Mondays. Cakes from ₹650 a kg, delivery across Pune." : "Sample travel creator: slow travel in the Indian mountains. Paid deals from ₹20,000; stays only if I'd book them anyway.";
    home.facts = learned[persona];
    home.needs = week[persona].flatMap(w => w.need ? [w.need] : []);
    home.tickets = home.needs.map(n => ({ id: n.id, job: "replies", state: n.type === "question" ? "open" : "ended", created: n.created, message: n.message,
      reports: [{ kind: n.type === "question" ? "waiting" : "ready", text: n.type === "question" ? "Waiting for your answer." : "Drafted a reply.", created: n.created }] }));
    style = { style: styles[persona], built: now() - 3600, from: persona === "business" ? 18 : 14, sent: persona === "business" ? 22 : 16, message: null };
    for (const [agent, result] of Object.entries(found[persona]) as [AgentId, AgentRun["result"]][])
      runs.set(agent, { agent, status: "done", result, error: null, cost_usd: 0.004, created: now() - 1200, finished: now() - 1140, models: agent === "reels" ? ["Muse Wonder", "Muse Spark Open"] : ["Muse Spark Open"] });
  }
}
const inbox = () => world ? (stage === "busy" && persona ? week[persona].map(w => w.item) : []) : [
  { id: "m1", kind: "whatsapp", asset_id: "1", sender: "15550000001", sender_name: "Sample customer", text: "Hi, are you open today?", created: now() - 600, replied: false },
  { id: "m2", kind: "instagram_comment", asset_id: "1", sender: "17841400000000001", sender_name: null, text: "Love this colour!", created: now() - 3600, replied: true },
  { id: "m3", kind: "instagram", asset_id: "1", sender: "17841400000000002", sender_name: "Sample buyer", text: "Do you ship the blue one?", created: now() - 7200, replied: false },
  { id: "m4", kind: "messenger", asset_id: "1", sender: "24000000000000001", sender_name: "", text: "Sample: can I book for Saturday?", created: now() - 86400, replied: false },
];

/** What the agent sends the owner on their own WhatsApp, and what they answer, for the sample's "Your WhatsApp". */
export type OwnerLine = { from: "agent" | "owner"; at: string; text: string };
export const ownerChat: Record<Persona, { number: string; lines: OwnerLine[] }> = {
  business: { number: "+91 ••••• •4821", lines: [
    { from: "agent", at: "11:04 AM", text: "🔴 Ananya (WhatsApp): wants 40 brownie boxes by Friday.\nWhy urgent: big order.\nDraft: \"Hi Ananya! Yes, 40 boxes of 6 brownies for Friday works. That's ₹18,000, free delivery in Baner. Shall I confirm?\"\nReply 1 to send, 2 <new text> to send your version, 3 to skip." },
    { from: "owner", at: "11:06 AM", text: "1" },
    { from: "agent", at: "11:06 AM", text: "Sent to Ananya ✓" },
    { from: "agent", at: "9:00 PM", text: "Today at Crumb & Co.\n• 8 messages in: 4 WhatsApp, 2 Instagram, 2 Messenger\n• 2 replies sent\n• Waiting for you: Rohan, Ishita, Meera and 3 more\n• New lead: Ananya, 40 brownie boxes (₹18,000)\nOne thing to do today: tell me if you deliver to Hinjewadi. Kabir asked." },
  ] },
  creator: { number: "+91 ••••• •3307", lines: [
    { from: "agent", at: "2:18 PM", text: "🔴 Nikhil at Sample Trek Gear (Instagram): offers ₹25,000 for one Reel with their rain jacket.\nWhy urgent: brand deal.\nDraft: \"Hi Nikhil, thank you! ₹25,000 for one Reel works for me. Could you send the brief and when you'd like it live?\"\nReply 1 to send, 2 <new text> to send your version, 3 to skip." },
    { from: "owner", at: "2:21 PM", text: "1" },
    { from: "agent", at: "2:21 PM", text: "Sent to Nikhil ✓" },
    { from: "agent", at: "9:00 PM", text: "Today on @sample.trails\n• 9 messages in, all Instagram: 5 DMs, 4 comments\n• 3 replies sent\n• Waiting for you: Riya, Kavya, Arnav and 3 more\n• New brand deal: Sample Trek Gear, ₹25,000\nOne thing to do today: tell me your rate for one Reel plus three Stories. Kavya asked." },
  ] },
};

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

// Each path starts with one agent switched off, so the quiet tile shows.
const controls: Record<AgentId, AgentControl> = Object.fromEntries((["leads", "ideas", "reels", "replies", "ads"] as const).map(name => [name, {
  mode: name === (persona === "business" ? "reels" : "ads") ? "off" : name === "replies" ? "draft" : "ask",
  note: name === "replies" ? "Sample note: keep replies short and friendly." : "" }])) as Record<AgentId, AgentControl>;
// The busy samples carry the notes their owners wrote.
const notes: Record<Persona, Partial<Record<AgentId, string>>> = {
  business: { replies: "Keep it short, give prices in ₹, never promise same-day delivery.", leads: "Flag orders over ₹5,000 and anything for an office or school.", ads: "Tell me before spend goes over ₹1,500 a week.", ideas: "Behind the counter works best for us." },
  creator: { replies: "First name, one useful detail, no hashtags.", leads: "Only paid deals over ₹20,000, or stays I'd book anyway.", reels: "Keep Reels under 30 seconds; hook in the first two.", ideas: "Mountains and slow travel only." },
};
if (world && stage === "busy" && persona) for (const [agent, note] of Object.entries(notes[persona]) as [AgentId, string][]) controls[agent] = { ...controls[agent], note };

// Each busy sample's own Instagram, for the numbers on Home.
const busy = world && stage === "busy" && persona ? {
  business: { username: "crumbandco.sample", name: "Crumb & Co. (sample)", followers: 6240, posts: ["Sample post: chocolate berry cake, 1 kg", "Sample post: lemon drizzle loaf with edible flowers", "Sample post: 5 AM croissants"] },
  creator: { username: "sample.trails", name: "Sample Trails", followers: 48200, posts: ["Sample post: the waterfall nobody finds before 9 AM", "Sample post: the café balcony in old Manali", "Sample post: Spiti in five cups of chai"] },
}[persona] : null;
const busyBakery = busy && persona === "business";

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
  if (route === "GET /api/ads" && busyBakery) return { accounts: [{ id: "act_1", name: "Crumb & Co. ads (sample)", currency: "INR", status: 1, campaigns: [
    campaign("Weekend brownie offer (sample)", "1740", "286", "3.1", "6.08"),
    campaign("Diwali gift boxes (sample)", "900", "124", "1.9", "7.26"),
    campaign("Bakery brand video (sample)", "1200", "9", "0.08", "133.33"),
  ] }] };
  if (route === "GET /api/ads") return { accounts: [{ id: "act_1", name: "Sample ad account", currency: "USD", status: 1, campaigns: [
    campaign("Sample spring sale", "84.20", "312", "2.6", "0.27"),
    campaign("Sample brand video", "41.00", "18", "0.15", "2.28"),
  ] }] };
  if (route === "GET /api/instagram") return { accounts: [{ id: "1",
    profile: busy ? { username: busy.username, name: busy.name, followers_count: busy.followers, follows_count: 210, media_count: busy.posts.length + 45 }
      : { username: "sample.studio", name: "Sample Studio", followers_count: 1520, follows_count: 210, media_count: 48 },
    media: [1, 2, 3].map(i => ({ id: `p${i}`, caption: busy?.posts[i - 1] ?? `Sample post ${i}`, media_type: "IMAGE", timestamp: new Date(Date.now() - i * 864e5).toISOString(), like_count: 120 / i, comments_count: 9 - i * 2, permalink: "https://www.instagram.com/" })),
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
    return { runs: [...runs.values()], ai_ready: true, own_key: hasKey, model: "Muse Spark Open (sample)", order: path, controls };
  }
  const control = route.match(/^PUT \/api\/agents\/(leads|ideas|reels|replies|ads)\/control$/);
  if (control) {
    const agent = control[1] as AgentId;
    controls[agent] = body as AgentControl;
    return { agent, ...controls[agent] };
  }
  const run = route.match(/^POST \/api\/agents\/(leads|ideas|reels|replies|ads)\/run$/);
  if (run) {
    const agent = run[1] as AgentId;
    if (controls[agent].mode === "off") throw new ApiError(409, "This agent is off. Switch it on to run it.");
    if (runs.get(agent)?.status === "running") throw new ApiError(409, "That agent is already running.");
    runs.set(agent, { agent, status: "running", result: null, error: null, cost_usd: null, created: now(), finished: null, models: [] });
    return { agent, status: "running" };
  }
  if (route === "GET /api/mcp/key") return { ...mcp, url: "https://app.example.com/mcp" };
  if (route === "POST /api/mcp/key") { mcp = { has_key: true, created: now(), last_used: null }; return { key: "stupid_sample_key_not_real", created: mcp.created }; }
  if (route === "DELETE /api/mcp/key") { mcp = { has_key: false, created: null, last_used: null }; return { has_key: false }; }
  if (route === "GET /api/agent") return home;
  if (route === "PUT /api/agent/settings") { home = { ...home, ...(body as { proactive: boolean; rules: string }) }; return { proactive: home.proactive, rules: home.rules }; }
  if (route === "GET /api/agent/style") return style;
  if (route === "DELETE /api/agent/style") { style = { style: null, built: null, from: 0, sent: style.sent, message: "Your agent learns how you write once a day. Check back tomorrow." }; return { style: null, message: "Forgotten." }; }
  const fact = /^DELETE \/api\/agent\/facts\/(\d+)$/.exec(route);
  if (fact) { home = { ...home, facts: home.facts.filter(f => f.id !== Number(fact[1])) }; return { facts: home.facts }; }
  const ticket = /^POST \/api\/agent\/tickets\/(\d+)\/answer$/.exec(route);
  if (ticket) { home = { ...home, needs: home.needs.filter(n => n.type !== "question" || n.id !== Number(ticket[1])) }; return { state: "open" }; }
  if (route === "GET /api/settings/ai" || route === "PUT /api/settings/ai/model") {
    if (route.startsWith("PUT")) aiModel = (body as { model: string }).model;
    const brain = aiModels.find(m => m.id === aiModel)?.provider === "meta" ? "meta" : "open";
    return { has_key: hasKey, model: aiModel, workspace_ai: true, brain, meta_brain: true, open_model: aiModels[0].id, meta_model: "muse-spark-1.3", models: aiModels };
  }
  if (route === "PUT /api/settings/ai") { hasKey = Boolean((body as { api_key: string }).api_key); return { has_key: hasKey, key_saved_at: hasKey ? Math.floor(Date.now() / 1000) : null, model: aiModel }; }
  throw new ApiError(404, "Sample data has no answer for this.");
}
