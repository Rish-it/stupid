//! Secnd server: Meta sign-in, connections, Meta data, webhooks and background agents.
mod agents;
mod meta;

use axum::{
    body::Bytes,
    extract::{Form, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post, put},
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
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};

pub type Db = Arc<Mutex<Connection>>;

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
    pub static_dir: PathBuf,
    pub data_dir: PathBuf,
    pub bind: String,
}

impl Config {
    fn load() -> Self {
        let v = |k: &str| env::var(format!("SECND_{k}")).unwrap_or_default();
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
            static_dir: or("STATIC_DIR", "frontend/dist").into(),
            data_dir: or("DATA_DIR", ".data/server").into(),
            bind: or("BIND", "127.0.0.1:8000"),
        }
    }
    fn secure(&self) -> bool {
        self.public_url.starts_with("https://")
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

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
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
";

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
}
impl User {
    pub fn selected_assets(&self, kind: &str) -> Vec<&meta::Asset> {
        self.assets.iter().filter(|a| a.kind == kind && self.selected.contains(&a.key)).collect()
    }
}

pub fn user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    let session = cookie(headers, "secnd_session").ok_or_else(|| AppError::new(401, "Sign in with Facebook first."))?;
    let db = state.db.lock().expect("db lock");
    let row = db
        .query_row(
            "SELECT u.id,u.name,u.token_blob,u.assets_json,u.selected_json FROM sessions s JOIN users u ON u.id=s.user_id
             WHERE s.hash=?1 AND s.expires>?2",
            params![digest(&session), now()],
            |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)),
        )
        .optional()?;
    let (id, name, token_blob, assets, selected) = row.ok_or_else(|| AppError::new(401, "Your session ended. Sign in again."))?;
    Ok(User {
        id,
        name,
        token_blob,
        assets: serde_json::from_str(&assets).unwrap_or_default(),
        selected: serde_json::from_str(&selected).unwrap_or_default(),
    })
}

pub fn tokens(state: &AppState, user: &User) -> ApiResult<meta::Tokens> {
    let fernet = state.fernet.as_ref().ok_or_else(|| AppError::new(503, "Token encryption is not configured."))?;
    let plain = fernet.decrypt(&user.token_blob).map_err(|_| AppError::new(401, "Stored Meta access is unreadable. Connect again."))?;
    serde_json::from_slice(&plain).map_err(|_| AppError::new(401, "Stored Meta access is unreadable. Connect again."))
}

// ---------- routes ----------

async fn health(State(s): State<AppState>) -> Json<Value> {
    let db = s.db.lock().expect("db lock").query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).is_ok();
    Json(json!({ "status": if db { "ok" } else { "degraded" }, "meta_configured": !s.cfg.app_id.is_empty(), "ai_configured": !s.cfg.muse_key.is_empty() }))
}

async fn me(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    match user(&s, &headers) {
        Ok(u) => Json(json!({ "signed_in": true, "name": u.name, "assets": u.assets, "selected": u.selected })),
        Err(_) => Json(json!({ "signed_in": false })),
    }
}

async fn oauth_start(State(s): State<AppState>) -> ApiResult<Response> {
    let c = &s.cfg;
    if c.app_id.is_empty() || c.app_secret.is_empty() || c.login_config_id.is_empty() || c.redirect_uri.is_empty() || s.fernet.is_none() {
        return Err(AppError::new(503, "Facebook sign-in needs operator setup."));
    }
    let state = random_token();
    {
        let db = s.db.lock().expect("db lock");
        db.execute("DELETE FROM oauth_states WHERE expires<?1", [now()])?;
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
    response.headers_mut().append(header::SET_COOKIE, set_cookie(c, "secnd_oauth", &state, 600));
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
    let fail = |why: &str| {
        tracing::warn!("Meta sign-in refused: {why}");
        let mut r = Redirect::to("/?meta_error=1").into_response();
        r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, "secnd_oauth", "", 0));
        r
    };
    let browser = cookie(&headers, "secnd_oauth").unwrap_or_default();
    // Consume the state once, even when the person or Meta refused.
    let valid = {
        let db = s.db.lock().expect("db lock");
        db.execute("DELETE FROM oauth_states WHERE hash=?1 AND expires>?2", params![digest(&q.state), now()]).unwrap_or(0) == 1
    };
    if !valid || q.state.is_empty() || browser != q.state {
        return fail("state expired or did not match");
    }
    if !q.error.is_empty() || q.code.is_empty() {
        return fail("the person or Meta denied it");
    }
    match meta::sign_in(&s, &q.code).await {
        Ok(user_id) => {
            let session = random_token();
            let saved = s.db.lock().expect("db lock").execute(
                "INSERT INTO sessions VALUES (?1,?2,?3)",
                params![digest(&session), user_id, now() + 30 * 86400],
            );
            if saved.is_err() {
                return fail("session not saved");
            }
            let mut r = Redirect::to("/?connected=1").into_response();
            r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, "secnd_session", &session, 30 * 86400));
            r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, "secnd_oauth", "", 0));
            r
        }
        Err(e) => fail(&e.1),
    }
}

async fn sign_out(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(session) = cookie(&headers, "secnd_session") {
        s.db.lock().expect("db lock").execute("DELETE FROM sessions WHERE hash=?1", [digest(&session)])?;
    }
    let mut r = Json(json!({ "signed_in": false })).into_response();
    r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, "secnd_session", "", 0));
    Ok(r)
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
    s.db.lock().expect("db lock").execute(
        "UPDATE users SET selected_json=?1 WHERE id=?2",
        params![serde_json::to_string(&chosen).unwrap_or_else(|_| "[]".into()), u.id],
    )?;
    Ok(Json(json!({ "assets": u.assets, "selected": chosen })))
}

async fn disconnect(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let u = user(&s, &headers)?;
    delete_user(&s.db, &u.id)?;
    let mut r = Json(json!({ "signed_in": false })).into_response();
    r.headers_mut().append(header::SET_COOKIE, set_cookie(&s.cfg, "secnd_session", "", 0));
    Ok(r)
}

fn delete_user(db: &Db, id: &str) -> rusqlite::Result<()> {
    let db = db.lock().expect("db lock");
    db.execute("DELETE FROM sessions WHERE user_id=?1", [id])?;
    db.execute("DELETE FROM agent_runs WHERE user_id=?1", [id])?;
    db.execute("DELETE FROM users WHERE id=?1", [id])?;
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
    let id: Option<String> = s.db.lock().expect("db lock").query_row("SELECT id FROM users WHERE meta_user_id=?1", [&meta_user], |r| r.get(0)).optional()?;
    if let Some(id) = id {
        delete_user(&s.db, &id)?;
    }
    let code = random_token();
    s.db.lock().expect("db lock").execute("INSERT INTO deletions VALUES (?1,?2)", params![code, now()])?;
    Ok(Json(json!({ "url": format!("{}/api/v1/meta/deletion/{code}", s.cfg.public_url.trim_end_matches('/')), "confirmation_code": code })))
}

async fn deletion_status(State(s): State<AppState>, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let done: Option<i64> = s.db.lock().expect("db lock").query_row("SELECT created FROM deletions WHERE code=?1", [&code], |r| r.get(0)).optional()?;
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
    let db = s.db.lock().expect("db lock");
    for e in events {
        db.execute(
            "INSERT OR IGNORE INTO events (kind,asset_id,sender,text,created,dedupe) VALUES (?1,?2,?3,?4,?5,?6)",
            params![e.kind, e.asset_id, e.sender, e.text, now(), e.dedupe],
        )?;
    }
    Ok(StatusCode::OK)
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let cfg = Config::load();
    std::fs::create_dir_all(&cfg.data_dir).expect("create data dir");
    let conn = Connection::open(cfg.data_dir.join("secnd.sqlite3")).expect("open database");
    conn.execute_batch(SCHEMA).expect("migrate database");
    let fernet = fernet::Fernet::new(&env::var("SECND_META_TOKEN_KEY").unwrap_or_default()).map(Arc::new);
    if fernet.is_none() {
        tracing::warn!("SECND_META_TOKEN_KEY is missing or invalid; Meta sign-in is disabled");
    }
    let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).pool_max_idle_per_host(16).build().expect("http client");
    let bind = cfg.bind.clone();
    let index = cfg.static_dir.join("index.html");
    let state = AppState { cfg: Arc::new(cfg), db: Arc::new(Mutex::new(conn)), http, fernet, cache: Default::default() };
    let static_files = ServeDir::new(&state.cfg.static_dir).fallback(ServeFile::new(index));

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .route("/api/v1/meta/oauth/start", get(oauth_start))
        .route("/api/v1/meta/oauth/callback", get(oauth_callback))
        .route("/api/v1/meta/deletion", post(deletion))
        .route("/api/v1/meta/deletion/{code}", get(deletion_status))
        .route("/api/sign-out", post(sign_out))
        .route("/api/connections", put(select).delete(disconnect))
        .route("/api/ads", get(meta::ads))
        .route("/api/instagram", get(meta::instagram))
        .route("/api/inbox", get(meta::inbox))
        .route("/api/agents", get(agents::list))
        .route("/api/agents/{agent}/run", post(agents::run))
        .route("/webhooks/meta", get(webhook_verify).post(webhook))
        .fallback_service(static_files)
        .layer(CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await.expect("server");
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
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; secnd_session=xyz"));
        assert_eq!(cookie(&h, "secnd_session").as_deref(), Some("xyz"));
        assert_eq!(cookie(&h, "missing"), None);
    }
}
