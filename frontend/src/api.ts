import { useCallback, useEffect, useState } from "react";

export type AssetKind = "ads" | "instagram" | "whatsapp" | "messenger";
export type Asset = { key: string; kind: AssetKind; id: string; name: string };
export type Health = { status: "ok" | "degraded"; meta_configured: boolean; ai_configured: boolean };
export type Me = { signed_in: false } | { signed_in: true; name: string; assets: Asset[]; selected: string[] };
export type Connections = { assets: Asset[]; selected: string[] };

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
export type InboxItem = { id: string; kind: InboxKind; asset_id: string; sender: string; text: string; created: number };

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
export type Agents = { runs: AgentRun[]; ai_ready: boolean; model: string };
export type AiSettings = { has_key: boolean; model: string };

/** status 0 = server unreachable; 404 = endpoint not available yet; 401 = signed out. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  ads: () => call<Ads>("GET", "/api/ads"),
  instagram: () => call<Instagram>("GET", "/api/instagram"),
  inbox: () => call<{ items: InboxItem[] }>("GET", "/api/inbox"),
  reply: (id: string, text: string) => call<{ sent: true }>("POST", `/api/inbox/${encodeURIComponent(id)}/reply`, { text }),
  agents: () => call<Agents>("GET", "/api/agents"),
  run: (agent: AgentId) => call<{ agent: AgentId; status: string }>("POST", `/api/agents/${agent}/run`),
  aiSettings: () => call<AiSettings>("GET", "/api/settings/ai"),
  setAiKey: (api_key: string) => call<AiSettings>("PUT", "/api/settings/ai", { api_key }),
};

// In-memory only: a screen shows what it last saw at once, then refreshes in the background.
const cache = new Map<string, unknown>();

export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [data, setData] = useState(() => cache.get(key) as T | undefined);
  const [error, setError] = useState<ApiError>();
  const reload = useCallback(() => load()
    .then(next => { cache.set(key, next); setData(next); setError(undefined); })
    .catch((cause: unknown) => setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)))), [key, load]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, setData };
}
