//! Stupid server: Meta sign-in, connections, Meta data, webhooks and background agents.
mod agents;
mod attention;
mod control;
mod crops;
mod executor;
mod meta;
mod mcp;
mod meta_ai;
mod reels;
mod setup;
mod style;
mod tickets;
mod tools;
mod voice;

use axum::{
    body::Bytes,
    extract::{Form, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Redirect, Response,
    },
    routing::{any, delete, get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    timeout::TimeoutLayer,
};

pub type Db = Arc<Mutex<Connection>>;

/// A panic while a lock is held must not take every later request down with it.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Config {
    pub app_id: String,
    pub app_secret: String,
    pub login_config_id: String,
    pub redirect_uri: String,
    pub public_url: String,
    pub graph: String,
    pub verify_token: String,
    pub muse_key: String,
    pub muse_base: String,
    pub muse_model: String,
    pub muse_budget_usd: f64,
    pub meta_api_key: String,
    pub meta_api_base: String,
    pub meta_api_budget_usd: f64,
    pub static_dir: PathBuf,
    pub data_dir: PathBuf,
    pub bind: String,
}

impl Config {
    fn load() -> Self {
        let v = |k: &str| env::var(format!("STUPID_{k}")).unwrap_or_default();
        let or = |k: &str, d: &str| Some(v(k)).filter(|s| !s.is_empty()).unwrap_or_else(|| d.into());
        Config {
            app_id: v("META_APP_ID"),
            app_secret: v("META_APP_SECRET"),
            login_config_id: v("META_LOGIN_CONFIG_ID"),
            redirect_uri: v("META_REDIRECT_URI"),
            public_url: v("META_PUBLIC_URL"),
            graph: format!("https://graph.facebook.com/{}", or("META_GRAPH_VERSION", "v25.0")),
            verify_token: v("META_VERIFY_TOKEN"),
            muse_key: v("MUSE_API_KEY"),
            muse_base: or("MUSE_BASE_URL", "https://inference.baseten.co/v1"),
            muse_model: or("MUSE_MODEL", "meta-models/muse-spark-open-1026"),
            muse_budget_usd: v("MUSE_BUDGET_USD").parse().unwrap_or(0.0),
            meta_api_key: v("META_API_KEY"),
            meta_api_base: or("META_API_BASE_URL", "https://api.meta.ai/v1"),
            meta_api_budget_usd: v("META_API_BUDGET_USD").parse().unwrap_or(20.0),
            static_dir: or("STATIC_DIR", "frontend/dist").into(),
            data_dir: or("DATA_DIR", ".data/server").into(),
            bind: or("BIND", "127.0.0.1:8000"),
        }
    }
    /// Contributor-tier Model API models may train on inputs and must not receive personal data (Model API ToS §6).
    fn model_allowed(&self) -> bool {
        !self.muse_model.to_ascii_lowercase().contains("contributor")
    }
    fn secure(&self) -> bool {
        self.public_url.starts_with("https://")
    }
    /// `__Host-` cookies over HTTPS cannot be set or overwritten by a sibling subdomain.
    fn cookie_name(&self, base: &str) -> String {
        if self.secure() { format!("__Host-{base}") } else { base.to_string() }
    }
    /// Browsers send Origin on writes; only our own page may write.
    fn origin_allowed(&self, origin: &str) -> bool {
        let public = reqwest::Url::parse(&self.public_url).ok().map(|u| u.origin().ascii_serialization());
        let local = !self.secure()
            && reqwest::Url::parse(origin).is_ok_and(|u| matches!(u.host_str(), Some("localhost" | "127.0.0.1")));
        public.as_deref() == Some(origin) || local
    }
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Db,
    pub http: reqwest::Client,
    pub fernet: Option<Arc<fernet::Fernet>>,
    // ponytail: one in-process cache, swap for a shared cache if this ever runs on more than one host.
    pub cache: Arc<Mutex<HashMap<String, (Instant, Value)>>>,
    pub queue: tickets::Queue,
}

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);
impl AppError {
    pub fn new(code: u16, message: impl Into<String>) -> Self {
        AppError(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), message.into())
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "message": self.1 }))).into_response()
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::error!("database: {e}");
        AppError::new(500, "Storage failed. Try again.")
    }
}
pub type ApiResult<T> = Result<T, AppError>;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub fn hmac_sha256(key: &str, data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
fn hmac_ok(key: &str, data: &[u8], expected: &[u8]) -> bool {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("any key length");
    mac.update(data);
    !key.is_empty() && mac.verify_slice(expected).is_ok()
}

// Per connection, so they run at every start.
const PRAGMAS: &str = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;";
// Append only: entry N moves a database from user_version N to N+1. Never edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    "
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, meta_user_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  token_blob TEXT NOT NULL, token_expires INTEGER NOT NULL, assets_json TEXT NOT NULL, selected_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, asset_id TEXT NOT NULL, sender TEXT NOT NULL,
  text TEXT NOT NULL, created INTEGER NOT NULL, dedupe TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS events_asset ON events(asset_id, id);
CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
  result_json TEXT, error TEXT, cost_usd REAL NOT NULL DEFAULT 0, created INTEGER NOT NULL, finished INTEGER);
CREATE INDEX IF NOT EXISTS runs_user ON agent_runs(user_id, agent, id);
CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, usd REAL NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deletions (code TEXT PRIMARY KEY, created INTEGER NOT NULL);
",
    "ALTER TABLE users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';",
    "CREATE TABLE replies (event_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);",
    "ALTER TABLE users ADD COLUMN ai_key_blob TEXT; ALTER TABLE spend ADD COLUMN own INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN problems_json TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE events ADD COLUMN sender_name TEXT;",
    "ALTER TABLE replies ADD COLUMN message_id TEXT; ALTER TABLE replies ADD COLUMN error TEXT; CREATE INDEX replies_message ON replies(message_id);",
    // When the person asked Stupid to send what agents read to their own AI account (their express direction).
    "ALTER TABLE users ADD COLUMN ai_key_saved_at INTEGER;",
    "CREATE TABLE meta_api_spend (id INTEGER PRIMARY KEY, model TEXT NOT NULL, usd REAL NOT NULL, created INTEGER NOT NULL);",
    // The agent's domain: triggers gather on threads, evals judge them, tickets hold prepare-only work.
    "
CREATE TABLE threads (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(user_id, key));
CREATE TABLE triggers (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, thread_id INTEGER NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL,
  event_id INTEGER, created INTEGER NOT NULL, disposition TEXT, reason TEXT, eval_id INTEGER, UNIQUE(user_id, source, ref));
CREATE INDEX triggers_thread ON triggers(thread_id, disposition);
CREATE TABLE evals (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, thread_id INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX evals_user ON evals(user_id, created);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, thread_id INTEGER NOT NULL, trigger_id INTEGER NOT NULL, job TEXT NOT NULL,
  mandate TEXT NOT NULL DEFAULT 'prepare' CHECK (mandate = 'prepare'), state TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, ended INTEGER);
CREATE INDEX tickets_user ON tickets(user_id, state);
CREATE INDEX tickets_thread ON tickets(thread_id, state);
CREATE TABLE reports (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX reports_ticket ON reports(ticket_id, id);
CREATE TABLE drafts (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, ticket_id INTEGER, event_id INTEGER NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX drafts_user ON drafts(user_id, event_id);
ALTER TABLE users ADD COLUMN agent_proactive INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN agent_rules TEXT NOT NULL DEFAULT '';
",
    // A voice note: `media` points at the audio until it is transcribed, then the words replace it.
    "ALTER TABLE events ADD COLUMN voice INTEGER NOT NULL DEFAULT 0; ALTER TABLE events ADD COLUMN media TEXT;",
    // Keys Muse uses to reach Stupid over MCP, stored as hashes like sessions.
    "CREATE TABLE access_keys (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER);",
    // Which model runs the person's agents: `open` (Muse Spark Open) or `meta` (Muse Spark 1.3 on the Model API).
    "ALTER TABLE users ADD COLUMN ai_brain TEXT NOT NULL DEFAULT 'open';",
    // Who Stupid works for: `creator` or `business`; NULL until the person picks.
    "ALTER TABLE users ADD COLUMN persona TEXT;",
    // Which Meta models made each run, and when Stupid last read the person's inboxes from Meta.
    "ALTER TABLE agent_runs ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE users ADD COLUMN last_pull INTEGER;",
    // What the owner told the agent once, kept until they delete it; a draft names the fact it used.
    "CREATE TABLE learned (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(user_id, question));
     ALTER TABLE drafts ADD COLUMN learned_id INTEGER;",
    // Each agent's mode (off, ask or draft) and the owner's one-sentence note for it.
    "CREATE TABLE agent_controls (user_id TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('off','ask','draft')),
     note TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, agent));",
    // How the owner writes, learned from their sent replies at most daily; drafts made with it say so.
    "ALTER TABLE users ADD COLUMN style_json TEXT; ALTER TABLE users ADD COLUMN style_at INTEGER; ALTER TABLE users ADD COLUMN style_from INTEGER;
     ALTER TABLE drafts ADD COLUMN styled INTEGER NOT NULL DEFAULT 0;",
    // Whether a customer's photo is one of the owner's Instagram posts: {"matched":true,post_id,…} or {"matched":false}.
    "ALTER TABLE events ADD COLUMN matched_json TEXT;",
    // The chat model the person picked for their agents (see agents::choices); NULL runs `ai_brain`'s default.
    "ALTER TABLE users ADD COLUMN ai_model TEXT;",
];

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch(PRAGMAS)?;
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i + 1)?;
        tx.commit()?;
    }
    Ok(())
}

// ---------- sessions ----------

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}
fn set_cookie(cfg: &Config, name: &str, value: &str, max_age: i64) -> HeaderValue {
    let secure = if cfg.secure() { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"))
        .expect("cookie is ascii")
}

pub struct User {
    pub id: String,
    pub name: String,
    pub token_blob: String,
    pub assets: Vec<meta::Asset>,
    pub selected: Vec<String>,
    pub permissions: Vec<String>,
    pub problems: Vec<String>,
    /// `creator` or `business`, once the person picked one.
    pub persona: Option<String>,
}
impl User {
    pub fn selected_assets(&self, kind: &str) -> Vec<&meta::Asset> {
        self.assets.iter().filter(|a| a.kind == kind && self.selected.contains(&a.key)).collect()
    }
}

pub fn user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    let session = cookie(headers, &state.cfg.cookie_name("stupid_session")).ok_or_else(|| AppError::new(401, "Sign in with Facebook first."))?;
    let id: Option<String> = lock(&state.db)
        .query_row("SELECT user_id FROM sessions WHERE hash=?1 AND expires>?2", params![digest(&session), now()], |r| r.get(0))
        .optional()?;
    user_by_id(state, &id.ok_or_else(|| AppError::new(401, "Your session ended. Sign in again."))?)
}

/// The person by id, for background work that has no session (the agent).
pub fn user_by_id(state: &AppState, id: &str) -> ApiResult<User> {
    let row = lock(&state.db)
        .query_row(
            "SELECT name,token_blob,assets_json,selected_json,permissions_json,problems_json,persona FROM users WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get(6)?)),
        )
        .optional()?;
    let (name, token_blob, assets, selected, permissions, problems, persona) = row.ok_or_else(|| AppError::new(401, "Your session ended. Sign in again."))?;
    Ok(User {
        id: id.to_string(),
        name,
        token_blob,
        assets: serde_json::from_str(&assets).unwrap_or_default(),
        selected: serde_json::from_str(&selected).unwrap_or_default(),
        permissions: serde_json::from_str(&permissions).unwrap_or_default(),
        problems: serde_json::from_str(&problems).unwrap_or_default(),
        persona,
    })
}

pub fn tokens(state: &AppState, user: &User) -> ApiResult<meta::Tokens> {
    let fernet = state.fernet.as_ref().ok_or_else(|| AppError::new(503, "Token encryption is not configured."))?;
    let plain = fernet.decrypt(&user.token_blob).map_err(|_| AppError::new(401, "Stored Meta access is unreadable. Connect again."))?;
    serde_json::from_slice(&plain).map_err(|_| AppError::new(401, "Stored Meta access is unreadable. Connect again."))
}

// ---------- routes ----------

/// Live updates for a signed-in screen. Every 2 s it compares version marks for the inbox, replies,
/// agent runs and connections and sends `update` when one changed; every 16 s it also pulls new
/// Messenger and Instagram messages, since unpublished apps get no webhooks. Signing out ends it.
async fn stream(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Sse<impl futures_util::Stream<Item = Result<SseEvent, std::convert::Infallible>>>> {
    user(&s, &headers)?;
    let start = (s, headers, Value::Null, 0u32);
    let updates = futures_util::stream::unfold(start, |(s, headers, last, mut tick)| async move {
        loop {
            let u = user(&s, &headers).ok()?;
            if tick % 8 == 0 {
                if let Err(e) = meta::pull(&s, &u).await {
                    tracing::warn!("live pull: {}", e.1);
                }
            }
            tick = tick.wrapping_add(1);
            let marks = meta::marks(&s, &u).ok()?;
            if marks != last {
                let event = SseEvent::default().event("update").data(marks.to_string());
                return Some((Ok(event), (s, headers, marks, tick)));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(Sse::new(updates).keep_alive(KeepAlive::default()))
}

async fn health(State(s): State<AppState>) -> Json<Value> {
    let db = lock(&s.db).query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).is_ok();
    Json(json!({ "status": if db { "ok" } else { "degraded" }, "meta_configured": !s.cfg.app_id.is_empty(), "ai_configured": !s.cfg.muse_key.is_empty(), "meta_api_configured": !s.cfg.meta_api_key.is_empty() }))
}

fn me_json(u: &User) -> Value {
    json!({ "signed_in": true, "name": u.name, "assets": u.assets, "selected": u.selected, "permissions": u.permissions, "problems": u.problems, "persona": u.persona })
}

async fn me(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    match user(&s, &headers) {
        Ok(u) => Json(me_json(&u)),
        Err(_) => Json(json!({ "signed_in": false })),
    }
}

/// Creator or business: it picks the setup steps, the agents' order and how drafts sound.
async fn save_persona(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let mut u = user(&s, &headers)?;
    let persona = body["persona"].as_str().filter(|p| matches!(*p, "creator" | "business")).ok_or_else(|| AppError::new(400, "Choose creator or business."))?;
    lock(&s.db).execute("UPDATE users SET persona=?1 WHERE id=?2", params![persona, u.id])?;
    u.persona = Some(persona.into());
    Ok(Json(me_json(&u)))
}

async fn oauth_start(State(s): State<AppState>) -> ApiResult<Response> {
    let c = &s.cfg;
    if c.app_id.is_empty() || c.app_secret.is_empty() || c.login_config_id.is_empty() || c.redirect_uri.is_empty() || s.fernet.is_none() {
        return Err(AppError::new(503, "Facebook sign-in needs operator setup."));
    }
    let state = random_token();
    {
        let db = lock(&s.db);
        db.execute("DELETE FROM oauth_states WHERE expires<?1", [now()])?;
        // Unauthenticated, so bound it: a flood of starts cannot grow the table without limit.
        let open: i64 = db.query_row("SELECT COUNT(*) FROM oauth_states", [], |r| r.get(0))?;
        if open >= 10_000 {
            return Err(AppError::new(503, "Too many sign-ins in progress. Try again in a few minutes."));
        }
        db.execute("INSERT INTO oauth_states VALUES (?1,?2)", params![digest(&state), now() + 600])?;
    }
    let mut url = reqwest::Url::parse(&format!("https://www.facebook.com/{}/dialog/oauth", c.graph.rsplit('/').next().unwrap_or("v25.0"))).expect("static url");
    url.query_pairs_mut()
        .append_pair("client_id", &c.app_id)
        .append_pair("config_id", &c.login_config_id)
        .append_pair("redirect_uri", &c.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", &state);
    let mut response = Redirect::to(url.as_str()).into_response();
    response.headers_mut().append(header::SET_COOKIE, set_cookie(c, &c.cookie_name("stupid_oauth"), &state, 600));
    Ok(response)
}

#[derive(Deserialize)]
struct Callback {
    #[serde(default)]
    state: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    error: String,
}

async fn oauth_callback(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<Callback>) -> Response {
    let (oauth, session_name) = (s.cfg.cookie_name("stupid_oauth"), s.cfg.cookie_name("stupid_session"));
    let fail = |why: &str| {
        tracing::warn!("Meta sign-in refused: {why}");
        let mut r = Redirect::to("/?meta_error=1").into_response();
        r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, &oauth, "", 0));
        r
    };
    let browser = cookie(&headers, &oauth).unwrap_or_default();
    // Consume the state once, even when the person or Meta refused.
    let valid = lock(&s.db).execute("DELETE FROM oauth_states WHERE hash=?1 AND expires>?2", params![digest(&q.state), now()]).unwrap_or(0) == 1;
    if !valid || q.state.is_empty() || browser != q.state {
        return fail("state expired or did not match");
    }
    if !q.error.is_empty() || q.code.is_empty() {
        return fail("the person or Meta denied it");
    }
    match meta::sign_in(&s, &q.code).await {
        Ok(user_id) => {
            let session = random_token();
            let saved = {
                let db = lock(&s.db);
                // A new sign-in replaces this browser's old session instead of leaving it alive.
                if let Some(old) = cookie(&headers, &session_name) {
                    let _ = db.execute("DELETE FROM sessions WHERE hash=?1", [digest(&old)]);
                }
                db.execute("INSERT INTO sessions VALUES (?1,?2,?3)", params![digest(&session), user_id, now() + 30 * 86400])
            };
            if saved.is_err() {
                return fail("session not saved");
            }
            let mut r = Redirect::to("/?connected=1").into_response();
            r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, &session_name, &session, 30 * 86400));
            r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, &oauth, "", 0));
            r
        }
        Err(e) => fail(&e.1),
    }
}

fn signed_out(cfg: &Config) -> Response {
    let mut r = Json(json!({ "signed_in": false })).into_response();
    r.headers_mut().append(header::SET_COOKIE, set_cookie(cfg, &cfg.cookie_name("stupid_session"), "", 0));
    r
}

async fn sign_out(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(session) = cookie(&headers, &s.cfg.cookie_name("stupid_session")) {
        lock(&s.db).execute("DELETE FROM sessions WHERE hash=?1", [digest(&session)])?;
    }
    Ok(signed_out(&s.cfg))
}

#[derive(Deserialize)]
struct Selection {
    selected: Vec<String>,
}

async fn select(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<Selection>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let mut chosen: Vec<String> = body.selected.into_iter().filter(|k| u.assets.iter().any(|a| &a.key == k)).collect();
    chosen.sort();
    chosen.dedup();
    lock(&s.db).execute(
        "UPDATE users SET selected_json=?1 WHERE id=?2",
        params![serde_json::to_string(&chosen).unwrap_or_else(|_| "[]".into()), u.id],
    )?;
    Ok(Json(json!({ "assets": u.assets, "selected": chosen })))
}

async fn disconnect(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let u = user(&s, &headers)?;
    delete_user(&s, &u.id)?;
    Ok(signed_out(&s.cfg))
}

/// Remove the person, their sessions, agent runs and the messages their accounts received, all or nothing.
fn delete_user(s: &AppState, id: &str) -> rusqlite::Result<()> {
    {
        let mut db = lock(&s.db);
        let tx = db.transaction()?;
        let assets: Option<String> = tx.query_row("SELECT assets_json FROM users WHERE id=?1", [id], |r| r.get(0)).optional()?;
        let assets: Vec<meta::Asset> = assets.and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
        for a in &assets {
            tx.execute("DELETE FROM events WHERE asset_id=?1", [&a.id])?;
        }
        tx.execute("DELETE FROM replies WHERE user_id=?1", [id])?;
        tx.execute("DELETE FROM sessions WHERE user_id=?1", [id])?;
        tx.execute("DELETE FROM agent_runs WHERE user_id=?1", [id])?;
        tx.execute("DELETE FROM reports WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id=?1)", [id])?;
        for table in ["drafts", "tickets", "evals", "triggers", "threads", "learned", "agent_controls"] {
            tx.execute(&format!("DELETE FROM {table} WHERE user_id=?1"), [id])?;
        }
        tx.execute("DELETE FROM access_keys WHERE user_id=?1", [id])?;
        tx.execute("DELETE FROM users WHERE id=?1", [id])?;
        tx.commit()?;
    }
    let prefix = format!("{id}:");
    lock(&s.cache).retain(|k, _| !k.starts_with(&prefix));
    Ok(())
}

#[derive(Deserialize)]
struct Signed {
    signed_request: String,
}

/// Meta's data-deletion callback: verify the signed request, delete everything for that Meta user.
async fn deletion(State(s): State<AppState>, Form(f): Form<Signed>) -> ApiResult<Json<Value>> {
    let refused = || AppError::new(403, "Invalid Meta deletion signature.");
    let (signature, payload) = f.signed_request.split_once('.').ok_or_else(refused)?;
    let decode = |v: &str| URL_SAFE_NO_PAD.decode(v.trim_end_matches('='));
    let signature = decode(signature).map_err(|_| refused())?;
    if !hmac_ok(&s.cfg.app_secret, payload.as_bytes(), &signature) {
        return Err(refused());
    }
    let data: Value = serde_json::from_slice(&decode(payload).map_err(|_| refused())?).map_err(|_| refused())?;
    if !data["algorithm"].as_str().is_some_and(|a| a.eq_ignore_ascii_case("HMAC-SHA256")) {
        return Err(refused());
    }
    let meta_user = match &data["user_id"] {
        Value::String(v) => v.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err(refused()),
    };
    let id: Option<String> = lock(&s.db).query_row("SELECT id FROM users WHERE meta_user_id=?1", [&meta_user], |r| r.get(0)).optional()?;
    if let Some(id) = id {
        delete_user(&s, &id)?;
    }
    let code = random_token();
    lock(&s.db).execute("INSERT INTO deletions VALUES (?1,?2)", params![code, now()])?;
    Ok(Json(json!({ "url": format!("{}/api/v1/meta/deletion/{code}", s.cfg.public_url.trim_end_matches('/')), "confirmation_code": code })))
}

async fn deletion_status(State(s): State<AppState>, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let done: Option<i64> = lock(&s.db).query_row("SELECT created FROM deletions WHERE code=?1", [&code], |r| r.get(0)).optional()?;
    done.map(|_| Json(json!({ "status": "deleted" }))).ok_or_else(|| AppError::new(404, "Unknown confirmation code."))
}

#[derive(Deserialize)]
struct Verify {
    #[serde(rename = "hub.mode", default)]
    mode: String,
    #[serde(rename = "hub.verify_token", default)]
    token: String,
    #[serde(rename = "hub.challenge", default)]
    challenge: String,
}

async fn webhook_verify(State(s): State<AppState>, Query(q): Query<Verify>) -> ApiResult<String> {
    // Comparing digests keeps the comparison independent of where the strings differ.
    let ok = q.mode == "subscribe" && !s.cfg.verify_token.is_empty() && digest(&q.token) == digest(&s.cfg.verify_token);
    if ok && !q.challenge.is_empty() && q.challenge.len() <= 256 { Ok(q.challenge) } else { Err(AppError::new(403, "Verification failed.")) }
}

async fn webhook(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<StatusCode> {
    let supplied = headers.get("x-hub-signature-256").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("sha256=")).and_then(|v| hex::decode(v).ok());
    if !supplied.is_some_and(|sig| hmac_ok(&s.cfg.app_secret, &body, &sig)) {
        return Err(AppError::new(403, "Invalid signature."));
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|_| AppError::new(400, "Invalid JSON."))?;
    let events = meta::parse_webhook(&payload);
    let db = lock(&s.db);
    for (message_id, reason) in meta::failed_sends(&payload) {
        tracing::warn!("WhatsApp send {message_id} failed: {reason}");
        db.execute("UPDATE replies SET error=?2 WHERE message_id=?1", params![message_id, format!("WhatsApp didn't deliver this reply: {reason}")])?;
    }
    let mut added = Vec::new();
    for e in events {
        if db.execute(
            "INSERT OR IGNORE INTO events (kind,asset_id,sender,sender_name,text,created,dedupe,media) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![e.kind, e.asset_id, e.sender, e.sender_name, e.text, now(), e.dedupe, e.media],
        )? == 1 {
            added.push(db.last_insert_rowid());
        }
    }
    drop(db);
    voice::arrived(&s, &added);
    Ok(StatusCode::OK)
}

/// Refuse cross-site writes and set security and caching headers on every response.
async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let write = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    // Meta's deletion callback is server to server; every other write must come from our page.
    if write && path.starts_with("/api/") && path != "/api/v1/meta/deletion" {
        let h = req.headers();
        let origin = h.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        let cross = h.get("sec-fetch-site").is_some_and(|v| v == "cross-site");
        if cross || origin.is_some_and(|o| !s.cfg.origin_allowed(o)) {
            return AppError::new(403, "Cross-site request refused.").into_response();
        }
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    if s.cfg.secure() {
        h.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000"));
    }
    let cache = if path.starts_with("/api/") || path.starts_with("/webhooks/") {
        "no-store"
    } else if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable" // Vite names these by content hash.
    } else {
        "no-cache"
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

/// Expire old rows. Runs at start and hourly; a run still "running" past ten minutes has lost its task.
fn sweep(s: &AppState, startup: bool) {
    let t = now();
    let stale = if startup { i64::MAX } else { t - 600 };
    let db = lock(&s.db);
    let done = db
        .execute("DELETE FROM sessions WHERE expires<?1", [t])
        .and_then(|_| db.execute("DELETE FROM oauth_states WHERE expires<?1", [t]))
        // ponytail: fixed 30-day inbox retention; make it a setting if anyone needs longer history.
        .and_then(|_| db.execute("DELETE FROM events WHERE created<?1", [t - 30 * 86400]))
        .and_then(|_| db.execute("DELETE FROM replies WHERE created<?1", [t - 30 * 86400]))
        // Lead and reply results quote customer messages, so they expire with them.
        .and_then(|_| db.execute("DELETE FROM agent_runs WHERE created<?1", [t - 30 * 86400]))
        // The agent's records hold customer words too, so they expire on the same day.
        .and_then(|_| db.execute_batch(&format!("
            DELETE FROM reports WHERE created<{old} OR ticket_id IN (SELECT id FROM tickets WHERE created<{old});
            DELETE FROM drafts WHERE created<{old};
            DELETE FROM tickets WHERE created<{old};
            DELETE FROM evals WHERE created<{old};
            DELETE FROM triggers WHERE created<{old};
            DELETE FROM threads WHERE created<{old} AND id NOT IN (SELECT thread_id FROM triggers) AND id NOT IN (SELECT thread_id FROM tickets);", old = t - 30 * 86400)))
        .and_then(|_| db.execute(
            "UPDATE agent_runs SET status='failed',error='Interrupted. Run it again.',finished=?1 WHERE status='running' AND created<?2",
            params![t, stale],
        ));
    if let Err(e) = done {
        tracing::error!("sweep: {e}");
    }
    drop(db);
    // The longest time-to-live in the cache.
    lock(&s.cache).retain(|_, (at, _)| at.elapsed() < meta::TTL.max(agents::MODELS_TTL));
}

async fn shutdown() {
    let term = async {
        #[cfg(unix)]
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
            return;
        }
        std::future::pending::<()>().await
    };
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term => {} }
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let cfg = Config::load();
    assert!(cfg.model_allowed(), "STUPID_MUSE_MODEL is a contributor-tier model, which must not receive customer messages; pick a standard model");
    std::fs::create_dir_all(&cfg.data_dir).expect("create data dir");
    let mut conn = Connection::open(cfg.data_dir.join("stupid.sqlite3")).expect("open database");
    migrate(&mut conn).expect("migrate database");
    let fernet = fernet::Fernet::new(&env::var("STUPID_META_TOKEN_KEY").unwrap_or_default()).map(Arc::new);
    if fernet.is_none() {
        tracing::warn!("STUPID_META_TOKEN_KEY is missing or invalid; Meta sign-in is disabled");
    }
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(25))
        .pool_max_idle_per_host(16)
        .build()
        .expect("http client");
    let bind = cfg.bind.clone();
    let index = cfg.static_dir.join("index.html");
    let state = AppState { cfg: Arc::new(cfg), db: Arc::new(Mutex::new(conn)), http, fernet, cache: Default::default(), queue: Default::default() };
    let static_files = ServeDir::new(&state.cfg.static_dir).fallback(ServeFile::new(index));
    sweep(&state, true);
    let swept = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(3600));
        every.tick().await;
        loop {
            every.tick().await;
            sweep(&swept, false);
        }
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .route("/api/me/persona", put(save_persona))
        .route("/api/setup/next", get(setup::next))
        .route("/api/v1/meta/oauth/start", get(oauth_start))
        .route("/api/v1/meta/oauth/callback", get(oauth_callback))
        .route("/api/v1/meta/deletion", post(deletion))
        .route("/api/v1/meta/deletion/{code}", get(deletion_status))
        .route("/api/sign-out", post(sign_out))
        .route("/api/connections", put(select).delete(disconnect))
        .route("/api/connections/refresh", post(meta::refresh))
        .route("/api/ads", get(meta::ads))
        .route("/api/instagram", get(meta::instagram))
        .route("/api/instagram/media/{id}/image", get(crops::image))
        .route("/api/inbox", get(meta::inbox))
        .route("/api/stream", get(stream))
        .route("/api/inbox/{id}/reply", post(meta::reply))
        .route("/api/settings/ai", get(agents::settings).put(agents::save_key))
        .route("/api/settings/ai/brain", put(agents::save_brain))
        .route("/api/settings/ai/model", put(agents::save_model))
        .route("/api/agents", get(agents::list))
        .route("/api/agents/{agent}/run", post(agents::run))
        .route("/api/agents/{agent}/control", put(control::save))
        .route("/api/agent", get(attention::home))
        .route("/api/agent/settings", put(attention::settings))
        .route("/api/agent/tickets/{id}/answer", post(attention::answer))
        .route("/api/agent/facts/{id}", delete(attention::forget))
        .route("/api/agent/style", get(style::get).delete(style::forget))
        .route("/api/mcp/key", get(mcp::key_status).post(mcp::create_key).delete(mcp::revoke_key))
        .route("/mcp", post(mcp::handle))
        .route("/webhooks/meta", get(webhook_verify).post(webhook))
        // Unknown API paths answer JSON 404, never the app's index.html.
        .route("/api/{*rest}", any(|| async { AppError::new(404, "Not found.") }))
        .fallback_service(static_files)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(StatusCode::GATEWAY_TIMEOUT, Duration::from_secs(60)))
        .layer(CatchPanicLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.expect("server");
}

#[cfg(test)]
pub mod tests_support {
    use super::*;

    /// A migrated in-memory state with one person whose WhatsApp number `p1` is switched on.
    pub fn state_with_user() -> (AppState, User) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO users (id,meta_user_id,name,token_blob,token_expires,assets_json,selected_json) VALUES ('u','1','n','b',0,?1,'[\"wa:p1\"]')",
            [r#"[{"key":"wa:p1","kind":"whatsapp","id":"p1","name":"Shop"}]"#]).unwrap();
        let mut cfg = Config::load();
        cfg.muse_key = String::new();
        let state = AppState { cfg: Arc::new(cfg), db: Arc::new(Mutex::new(conn)), http: reqwest::Client::new(), fernet: None, cache: Default::default(), queue: Default::default() };
        let u = user_by_id(&state, "u").unwrap();
        (state, u)
    }

    /// Muse stand-in on a local port: answers every chat call with `content` and keeps each request body.
    pub async fn stub(content: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kept = seen.clone();
        let app = axum::Router::new().route("/chat/completions", axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
            kept.lock().unwrap().push(body);
            async move { axum::Json(serde_json::json!({ "choices": [{ "message": { "content": content }, "finish_reason": "stop" }], "usage": { "prompt_tokens": 900, "completion_tokens": 40 } })) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    pub fn with_muse(base: String) -> AppState {
        let (s, _) = state_with_user();
        let mut cfg = crate::Config::load();
        (cfg.muse_base, cfg.muse_key, cfg.muse_budget_usd) = (base, "k".into(), 1.0);
        AppState { cfg: std::sync::Arc::new(cfg), ..s }
    }

    /// Request headers signed in as that person.
    pub fn signed_in(state: &AppState) -> HeaderMap {
        lock(&state.db).execute("INSERT OR REPLACE INTO sessions VALUES (?1,'u',?2)", params![digest("t"), now() + 3600]).unwrap();
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("stupid_session=t"));
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_and_cookies() {
        let sig = hmac_sha256("secret", b"body");
        assert!(hmac_ok("secret", b"body", &sig));
        assert!(!hmac_ok("secret", b"other", &sig));
        assert!(!hmac_ok("", b"body", &hmac_sha256("", b"body")));
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; stupid_session=xyz"));
        assert_eq!(cookie(&h, "stupid_session").as_deref(), Some("xyz"));
        assert_eq!(cookie(&h, "missing"), None);
    }

    #[test]
    fn migrations_run_once_and_upgrade_old_databases() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap(); // a database from before versioning
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len());
        conn.execute("INSERT INTO users (id,meta_user_id,name,token_blob,token_expires,assets_json) VALUES ('a','1','n','b',0,'[]')", []).unwrap();
        let p: String = conn.query_row("SELECT permissions_json FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(p, "[]");
    }

    #[test]
    fn origins_and_cookie_names() {
        let public = Config { public_url: "https://app.example.com/".into(), ..Config::load() };
        assert!(public.origin_allowed("https://app.example.com"));
        assert!(!public.origin_allowed("https://evil.example.com"));
        assert!(!public.origin_allowed("http://localhost:5173"));
        assert_eq!(public.cookie_name("stupid_session"), "__Host-stupid_session");
        let local = Config { public_url: String::new(), ..Config::load() };
        assert!(local.origin_allowed("http://localhost:5173") && local.origin_allowed("http://127.0.0.1:8000"));
        assert!(!local.origin_allowed("http://localhost.evil.com"));
        assert_eq!(local.cookie_name("stupid_session"), "stupid_session");
    }

    #[test]
    fn sweep_expires_agent_runs_with_the_messages() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        for age in [31, 29] {
            conn.execute("INSERT INTO agent_runs (user_id,agent,status,created) VALUES ('u','leads','done',?1)", [now() - age * 86400]).unwrap();
        }
        let state = AppState { cfg: Arc::new(Config::load()), db: Arc::new(Mutex::new(conn)), http: reqwest::Client::new(), fernet: None, cache: Default::default(), queue: Default::default() };
        sweep(&state, false);
        let left: i64 = lock(&state.db).query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
    }

    #[tokio::test]
    async fn persona_is_creator_or_business() {
        let (s, _) = tests_support::state_with_user();
        let h = tests_support::signed_in(&s);
        assert_eq!(me(State(s.clone()), h.clone()).await.0["persona"], Value::Null);
        for bad in [json!({ "persona": "agency" }), json!({}), json!({ "persona": 1 })] {
            assert_eq!(save_persona(State(s.clone()), h.clone(), Json(bad)).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        }
        let saved = save_persona(State(s.clone()), h.clone(), Json(json!({ "persona": "creator" }))).await.unwrap().0;
        assert_eq!((saved["signed_in"].clone(), saved["persona"].clone()), (json!(true), json!("creator")));
        assert_eq!(me(State(s.clone()), h.clone()).await.0, saved);
        assert_eq!(save_persona(State(s.clone()), h.clone(), Json(json!({ "persona": "business" }))).await.unwrap().0["persona"], "business");
        assert_eq!(user_by_id(&s, "u").unwrap().persona.as_deref(), Some("business"));
        assert_eq!(save_persona(State(s.clone()), HeaderMap::new(), Json(json!({ "persona": "creator" }))).await.unwrap_err().0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn contributor_models_are_refused() {
        let model = |m: &str| Config { muse_model: m.into(), ..Config::load() };
        assert!(model("meta-models/muse-spark-open-1026").model_allowed());
        assert!(!model("muse-spark-1.3-contributor").model_allowed());
        assert!(!model("Muse-Spark-1.2-Contributor").model_allowed());
    }
}
