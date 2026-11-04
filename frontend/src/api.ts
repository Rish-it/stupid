import { useCallback, useEffect, useState } from "react";
import type { Crop } from "./crop";

export type AssetKind = "ads" | "instagram" | "whatsapp" | "messenger";
/** Something Meta still needs from the person. `blocking` means the account can't work yet; otherwise it works with limits. */
export type Issue = { blocking: boolean; text: string; fix: string; link?: string | null };
export type Asset = { key: string; kind: AssetKind; id: string; name: string; issues?: Issue[] };
/** `instagram_oauth_start` appears once the server offers Instagram sign-in for creators without a Facebook Page. */
/** Who Stupid works for: a creator (Instagram first) or a business owner (WhatsApp first). */
export type Persona = "creator" | "business";
/** `persona` is null until the person picks a door. */
export type Me = { signed_in: false; instagram_oauth_start?: string } | { signed_in: true; name: string; assets: Asset[]; selected: string[]; permissions: string[]; problems?: string[]; persona: Persona | null };
export type Connections = { assets: Asset[]; selected: string[] };
export type Account = Connections & { permissions?: string[]; problems?: string[] };

/** In setup order. `pick` is what to choose in Meta's dialog. */
export const apps: { kind: AssetKind; name: string; why: string; pick: string }[] = [
  { kind: "instagram", name: "Instagram", why: "See your reach and answer DMs and comments.", pick: "In Meta's window, pick your Instagram account." },
  { kind: "whatsapp", name: "WhatsApp", why: "Answer customer chats from your inbox.", pick: "In Meta's window, pick your WhatsApp Business account and number." },
  { kind: "messenger", name: "Facebook Page", why: "Answer Messenger chats from your Page.", pick: "In Meta's window, pick your Facebook Page." },
  { kind: "ads", name: "Meta Ads", why: "See what you spent and what worked, in plain words.", pick: "In Meta's window, pick your ad account." },
];

// What each Meta permission turns on, in the person's words.
const features: Record<AssetKind, [permission: string, feature: string][]> = {
  ads: [["ads_read", "your ad results"]],
  instagram: [["instagram_manage_insights", "reach and insights"], ["instagram_manage_comments", "comments"], ["instagram_manage_messages", "DMs"]],
  whatsapp: [["whatsapp_business_messaging", "chats"]],
  messenger: [["pages_messaging", "Messenger chats"]],
};

export type Status = "ready" | "step" | "off";
/** One app's setup state. Only switched-on accounts count; an empty permission list means the server doesn't know yet. */
export function appStatus(state: Account, kind: AssetKind) {
  const on = state.assets.filter(a => a.kind === kind && state.selected.includes(a.key));
  const refused = on.length && state.permissions?.length ? features[kind].filter(([p]) => !state.permissions!.includes(p)).map(([, f]) => f) : [];
  const blocked = on.some(a => a.issues?.some(i => i.blocking));
  const status: Status = !on.length ? "off" : blocked || refused.length ? "step" : "ready";
  return { status, on, refused };
}
/** Setup is done when nothing was refused, nothing needs a step, and at least one app is ready. */
export const setupDone = (state: Account) => !state.problems?.length
  && apps.every(a => appStatus(state, a.kind).status !== "step") && apps.some(a => appStatus(state, a.kind).status === "ready");

/** The one thing this person must do next, from real Meta state (GET /api/setup/next). */
export type SetupStep = {
  id: string; app: AssetKind | "agent"; title: string; why: string;
  action: "connect" | "fix_in_meta" | "tell_agent"; button: string; link?: string; optional: boolean;
  /** fix_in_meta only: what to do in Meta, in Meta's words. */
  fix?: string;
};
export type SetupNext = { persona: Persona | null; done: boolean; progress: { done: number; total: number }; step?: SetupStep };

export const factsPrompt: Record<Persona, string> = {
  creator: "What you post about and what brand deals you take, in one or two sentences.",
  business: "Your prices, hours and delivery areas, in one or two sentences.",
};

/** The door picked on the landing page, kept for the trip through Facebook sign-in. */
const doorKey = "stupid.persona";
export const door = {
  get(): Persona | null {
    try { const v = sessionStorage.getItem(doorKey); return v === "creator" || v === "business" ? v : null; } catch { return null; }
  },
  /** Set on Continue only; a plain sign-in clears it, so an existing account is never guessed. */
  set(persona: Persona | null) {
    try { if (persona) sessionStorage.setItem(doorKey, persona); else sessionStorage.removeItem(doorKey); } catch { /* Storage blocked: the choice is asked again after sign-in. */ }
  },
};

export type Campaign = {
  campaign_id: string; campaign_name: string; spend: string; impressions: string; reach: string;
  clicks: string; ctr: string; cpc: string; actions?: { action_type: string; value: string }[];
  date_start: string; date_stop: string;
};
export type Ads = { accounts: { id: string; name: string; currency: string; status: string | number; campaigns: Campaign[] }[] };

export type Media = {
  id: string; caption?: string; media_type: string; media_product_type?: string; timestamp: string;
  like_count?: number; comments_count?: number; permalink: string; thumbnail_url?: string; media_url?: string;
};
export type Instagram = {
  accounts: {
    id: string;
    profile: { username: string; name?: string; followers_count: number; follows_count: number; media_count: number; profile_picture_url?: string; biography?: string };
    media: Media[];
    insights: { name: "reach" | "views" | "accounts_engaged" | "total_interactions"; value: number }[];
    insights_error: string | null;
  }[];
};

export type InboxKind = "whatsapp" | "messenger" | "instagram" | "instagram_comment";
export type InboxItem = { id: string; kind: InboxKind; asset_id: string; sender: string; sender_name: string | null; text: string; created: number; replied: boolean; reply_error?: string | null;
  /** A voice note: `text` holds its transcript. While a voice note, photo or video is put into words, `transcribing` says which. */
  voice?: boolean; transcribing?: "voice" | "photo" | "video" | null;
  /** The newest draft Stupid keeps for this message, from the agent or from Muse. */
  draft?: { text: string; source: string } | null };
// ponytail: only India's +91 is grouped; other numbers show as +<digits>. Add a library if numbers from more countries arrive.
const phone = (digits: string) => digits.length === 12 && digits.startsWith("91") ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`;
/** The name to show for a message; `sender` stays the id replies go to. A WhatsApp sender is a phone number; numeric Meta ids are never shown. */
export const senderName = (item: Pick<InboxItem, "kind" | "sender" | "sender_name">) => item.sender_name
  || (item.kind === "whatsapp" ? phone(item.sender) : !/^\d+$/.test(item.sender) ? item.sender : item.kind === "messenger" ? "Someone on Messenger" : "Someone on Instagram");

export type AgentId = "leads" | "ideas" | "reels" | "replies" | "ads";
export type ReelScript = { title: string; hook: string; caption: string; shots: { shot: string; seconds: number; on_screen: string; sound: string }[] };
export type Watched = { video: number; caption?: string; permalink?: string; works: { at: string; what: string }[]; drop_off_guesses?: { at: string; what: string }[] };
export type AgentResult =
  | { empty: true }
  | { leads: { who: string; channel: string; said: string; why: string; next_step: string }[] }
  | { ideas: { hook: string; caption: string; format: "reel" | "carousel" | "photo" | "story"; why: string }[]; looked_at?: number }
  | { replies: { event_id: string; to: string; draft: string }[] }
  | { scripts: ReelScript[]; watched: Watched[]; from_captions_only: boolean }
  | { summary: string; actions: { campaign: string; do: "pause" | "keep" | "scale" | "fix"; why: string }[]; creative_pack?: Crop[] };
export type AgentRun = {
  agent: AgentId; status: "running" | "done" | "failed"; result: AgentResult | null; error: string | null;
  cost_usd: number | null; created: number; finished: number | null;
  /** The Meta models that made this result, e.g. "Muse Spark Open", "Muse Wonder", "SAM 3.1". */
  models: string[];
};
/** `order` lists agents in the order this person's path shows them. */
export type Agents = { runs: AgentRun[]; ai_ready: boolean; own_key: boolean; model: string; order: AgentId[] };
export type AiSettings = { has_key: boolean; key_saved_at?: number | null; model: string; workspace_ai: boolean; brain: "open" | "meta"; meta_brain: boolean; open_model: string; meta_model: string };

/** The customer message a piece of agent work is about. */
export type AgentMessage = { kind: InboxKind; sender: string; sender_name: string | null; text?: string };
/** What waits for the person: a ready reply draft, or the agent's one question. */
export type Need =
  | { type: "draft"; id: number; event_id: string; text: string; source: string; created: number; message: AgentMessage; used?: { answer: string; told: number } | null; styled?: boolean }
  | { type: "question"; id: number; question: string; created: number; message: AgentMessage | null };
export type ReportKind = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped" | "question" | "answer" | "idea" | "advice";
export type Ticket = { id: number; job: string; state: "open" | "ended"; created: number; message: AgentMessage | null; reports: { kind: ReportKind; text: string; created: number }[] };
/** How the owner writes, learned from their sent replies. `message` says why there is none yet. */
export type Style = { style: { note: string; length: string; greeting: string; emoji: string; language: string; sign_off: string } | null; built: number | null; from: number; sent: number; message: string | null };
/** Something the owner told the agent once, kept until they delete it. `created` is unix time. */
export type Fact = { id: number; question: string; answer: string; created: number };
/** `watching` lists the switched-on channels the agent reads; `last_checked` is unix time, or null if never. */
export type AgentHome = { needs: Need[]; tickets: Ticket[]; proactive: boolean; rules: string; facts: Fact[]; watching: string[]; last_checked: number | null };
/** The last thing a ticket said that a person would read. */
export const lastReport = (t: Ticket) => t.reports.filter(r => !["question", "answer", "idea", "advice"].includes(r.kind)).at(-1);
export const jobNames: Record<string, string> = { replies: "Reply drafts", leads: "Lead finder", ideas: "Post ideas", reels: "Reel director", ads: "Ad watcher" };

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "2 minutes ago", as plain text: no tab stop or tooltip, unlike a Timestamp. */
export function ago(unix: number) {
  const s = unix - Date.now() / 1000, abs = Math.abs(s);
  if (abs < 45) return "just now";
  const [n, unit] = abs < 3600 ? [s / 60, "minute"] as const : abs < 86400 ? [s / 3600, "hour"] as const : [s / 86400, "day"] as const;
  return relative.format(Math.round(n), unit);
}

/** status 0 = server unreachable; 401 = signed out; any other 4xx carries a message written for the person. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * ?fixtures=1 answers from labelled sample data instead of the server, loaded only then. It is how people without a
 * Meta login try Stupid ("See a sample desk"). It never calls the server, so it never touches a real session.
 */
export const sample = new URLSearchParams(location.search).has("fixtures");
/** Sample mode has nothing to send to: every send button says so and stays off. */
export const sampleSend = "Sample: nothing is sent";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (sample) return (await import("./fixtures")).answer(method, path, body) as Promise<T>;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Stupid can't reach its server right now.");
  }
  const data = (await res.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
  // A non-JSON reply is either a dev proxy with no server behind it, or the server's page fallback for a route it doesn't have yet.
  if (data === undefined) throw res.status >= 500 ? new ApiError(0, "Stupid can't reach its server right now.") : new ApiError(404, "This isn't available yet.");
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status}).`);
  return data;
}

export const oauthStartUrl = "/api/v1/meta/oauth/start";
// Static pages the server serves next to the app.
export const legal = [["Privacy", "/privacy.html"], ["Terms", "/terms.html"], ["Data deletion", "/deletion.html"]] as const;

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  setPersona: (persona: Persona) => call<Me>("PUT", "/api/me/persona", { persona }),
  setupNext: () => call<SetupNext>("GET", "/api/setup/next"),
  signOut: () => call<{ signed_in: false }>("POST", "/api/sign-out"),
  select: (selected: string[]) => call<Connections>("PUT", "/api/connections", { selected }),
  disconnect: () => call<unknown>("DELETE", "/api/connections"),
  refresh: () => call<Required<Account>>("POST", "/api/connections/refresh"),
  ads: () => call<Ads>("GET", "/api/ads"),
  instagram: () => call<Instagram>("GET", "/api/instagram"),
  inbox: () => call<{ items: InboxItem[] }>("GET", "/api/inbox"),
  reply: (id: string, text: string) => call<{ sent: true }>("POST", `/api/inbox/${encodeURIComponent(id)}/reply`, { text }),
  agents: () => call<Agents>("GET", "/api/agents"),
  run: (agent: AgentId) => call<{ agent: AgentId; status: string }>("POST", `/api/agents/${agent}/run`),
  aiSettings: () => call<AiSettings>("GET", "/api/settings/ai"),
  setAiKey: (api_key: string, consent = false) => call<Omit<AiSettings, "workspace_ai">>("PUT", "/api/settings/ai", { api_key, consent }),
  setBrain: (brain: AiSettings["brain"]) => call<AiSettings>("PUT", "/api/settings/ai/brain", { brain }),
  agent: () => call<AgentHome>("GET", "/api/agent"),
  mcpKey: () => call<McpKey>("GET", "/api/mcp/key"),
  createMcpKey: () => call<{ key: string; created: number }>("POST", "/api/mcp/key"),
  revokeMcpKey: () => call<{ has_key: false }>("DELETE", "/api/mcp/key"),
  answer: (ticket: number, text: string, skip = false) => call<{ state: string }>("POST", `/api/agent/tickets/${ticket}/answer`, { text, skip }),
  agentSettings: (proactive: boolean, rules: string) => call<{ proactive: boolean; rules: string }>("PUT", "/api/agent/settings", { proactive, rules }),
  style: () => call<Style>("GET", "/api/agent/style"),
  forgetStyle: () => call<{ style: null; message: string }>("DELETE", "/api/agent/style"),
  forgetFact: (id: number) => call<{ facts: Fact[] }>("DELETE", `/api/agent/facts/${id}`),
};

/** A reply waiting in the Inbox. `source` marks text an agent wrote, so the person sees it came from AI. */
export type Draft = { text: string; source?: "agent" | "muse" };
export type McpKey = { has_key: boolean; created: number | null; last_used: number | null; url: string };
/** Reply drafts handed from Agents to the Inbox, by message id. In memory only. */
export const drafts = new Map<string, Draft>();

// In-memory only: a screen shows what it last saw at once, then refreshes in the background.
const cache = new Map<string, unknown>();
// Screens on view, by what they load, so a live update can refetch just that.
const loaders = new Map<string, Set<() => unknown>>();
export const refetch = (key: string) => loaders.get(key)?.forEach(load => load());

export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [data, setData] = useState(() => cache.get(key) as T | undefined);
  const [error, setError] = useState<ApiError>();
  const reload = useCallback(() => load()
    .then(next => { cache.set(key, next); setData(next); setError(undefined); })
    .catch((cause: unknown) => setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)))), [key, load]);
  useEffect(() => {
    void reload();
    const set = loaders.get(key) ?? new Set();
    loaders.set(key, set.add(reload));
    return () => void set.delete(reload);
  }, [key, reload]);
  return { data, error, reload, setData };
}

// Which screen data each field of a live update stands for.
// A sent reply also clears its draft from "Needs you".
const streamed = { inbox: ["inbox"], replies: ["inbox", "agent"], runs: ["agents"], agent: ["agent"], connections: ["me"] } as const;

/**
 * Listens to /api/stream while signed in and refetches only what changed. Returns true once it has been down
 * for more than 10 seconds. The browser reconnects by itself after a dropped connection; after a refused one
 * it gives up, so we ask why: 401 means signed out, 404 means the server has no stream yet.
 */
export function useStream(on: boolean, onSignedOut: () => void) {
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!on || sample) return;
    let source: EventSource | undefined;
    let last: Record<string, string> | undefined;
    let slow: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    const up = () => { clearTimeout(slow); slow = undefined; setDown(false); };
    const open = () => {
      source = new EventSource("/api/stream");
      source.onopen = up;
      source.addEventListener("update", event => {
        const next = JSON.parse((event as MessageEvent<string>).data) as Record<string, string>;
        const changed = new Set(Object.entries(streamed).filter(([field]) => last && last[field] !== next[field]).flatMap(([, keys]) => keys));
        last = next;
        changed.forEach(refetch);
      });
      source.onerror = () => {
        slow ??= setTimeout(() => setDown(true), 10_000);
        if (source?.readyState !== EventSource.CLOSED) return;
        fetch("/api/stream", { method: "HEAD", credentials: "same-origin" }).then(res => {
          if (res.status === 401) onSignedOut();
          else if (res.status === 404) up();
          else retry = setTimeout(open, 5000);
        }, () => { retry = setTimeout(open, 5000); });
      };
    };
    open();
    return () => { source?.close(); clearTimeout(slow); clearTimeout(retry); };
  }, [on, onSignedOut]);
  return down;
}
