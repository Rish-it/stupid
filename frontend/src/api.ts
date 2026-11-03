import { useCallback, useEffect, useState } from "react";

export type AssetKind = "ads" | "instagram" | "whatsapp" | "messenger";
/** Something Meta still needs from the person. `blocking` means the account can't work yet; otherwise it works with limits. */
export type Issue = { blocking: boolean; text: string; fix: string; link?: string | null };
export type Asset = { key: string; kind: AssetKind; id: string; name: string; issues?: Issue[] };
export type Health = { status: "ok" | "degraded"; meta_configured: boolean; ai_configured: boolean };
/** `instagram_oauth_start` appears once the server offers Instagram sign-in for creators without a Facebook Page. */
export type Me = { signed_in: false; instagram_oauth_start?: string } | { signed_in: true; name: string; assets: Asset[]; selected: string[]; permissions: string[]; problems?: string[] };
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
export type InboxItem = { id: string; kind: InboxKind; asset_id: string; sender: string; sender_name: string | null; text: string; created: number; replied: boolean; reply_error?: string | null };
// ponytail: only India's +91 is grouped; other numbers show as +<digits>. Add a library if numbers from more countries arrive.
const phone = (digits: string) => digits.length === 12 && digits.startsWith("91") ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`;
/** The name to show for a message; `sender` stays the id replies go to. A WhatsApp sender is a phone number. */
export const senderName = (item: InboxItem) => item.sender_name || (item.kind === "whatsapp" ? phone(item.sender) : item.sender);

export type AgentId = "leads" | "ideas" | "replies" | "ads";
export type AgentResult =
  | { empty: true }
  | { leads: { who: string; channel: string; said: string; why: string; next_step: string }[] }
  | { ideas: { hook: string; caption: string; format: "reel" | "carousel" | "photo" | "story"; why: string }[] }
  | { replies: { event_id: string; to: string; draft: string }[] }
  | { summary: string; actions: { campaign: string; do: "pause" | "keep" | "scale" | "fix"; why: string }[] };
export type AgentRun = {
  agent: AgentId; status: "running" | "done" | "failed"; result: AgentResult | null; error: string | null;
  cost_usd: number | null; created: number; finished: number | null;
};
export type Agents = { runs: AgentRun[]; ai_ready: boolean; own_key: boolean; model: string };
export type AiSettings = { has_key: boolean; model: string; workspace_ai: boolean };

/** status 0 = server unreachable; 401 = signed out; any other 4xx carries a message written for the person. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Dev builds only: ?fixtures=1 answers from labelled sample data instead of the server. */
export const sample = import.meta.env.DEV && new URLSearchParams(location.search).has("fixtures");

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
    throw new ApiError(0, "Secnd can't reach its server right now.");
  }
  const data = (await res.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
  // A non-JSON reply is either a dev proxy with no server behind it, or the server's page fallback for a route it doesn't have yet.
  if (data === undefined) throw res.status >= 500 ? new ApiError(0, "Secnd can't reach its server right now.") : new ApiError(404, "This isn't available yet.");
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status}).`);
  return data;
}

export const oauthStartUrl = "/api/v1/meta/oauth/start";

export const api = {
  health: () => call<Health>("GET", "/api/health"),
  me: () => call<Me>("GET", "/api/me"),
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
  setAiKey: (api_key: string) => call<Omit<AiSettings, "workspace_ai">>("PUT", "/api/settings/ai", { api_key }),
};

/** Reply drafts handed from Agents to the Inbox, by message id. In memory only. */
export const drafts = new Map<string, string>();

// In-memory only: a screen shows what it last saw at once, then refreshes in the background.
const cache = new Map<string, unknown>();
// Screens on view, by what they load, so a live update can refetch just that.
const loaders = new Map<string, Set<() => unknown>>();
const refetch = (key: string) => loaders.get(key)?.forEach(load => load());

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
const streamed = { inbox: "inbox", replies: "inbox", runs: "agents", connections: "me" } as const;

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
        const changed = new Set(Object.entries(streamed).filter(([field]) => last && last[field] !== next[field]).map(([, key]) => key));
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
