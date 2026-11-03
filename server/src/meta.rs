//! Meta Graph API: sign-in, account inventory, Ads and Instagram reads, webhook parsing.
use crate::{hmac_sha256, lock, now, random_token, tokens, user, ApiResult, AppError, AppState, User};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Asset {
    pub key: String,
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Tokens {
    pub user: String,
    #[serde(default)]
    pub assets: HashMap<String, String>,
}
impl Tokens {
    pub fn for_asset(&self, key: &str) -> &str {
        self.assets.get(key).map(String::as_str).unwrap_or(&self.user)
    }
}

fn graph_error(body: &Value) -> AppError {
    let e = &body["error"];
    if e["code"].as_i64() == Some(190) {
        return AppError::new(401, "Meta access expired. Connect again.");
    }
    let message = e["message"].as_str().unwrap_or("Meta did not answer.");
    tracing::warn!("Graph API error {}: {message}", e["code"]);
    AppError::new(502, format!("Meta: {message}"))
}

async fn send(request: reqwest::RequestBuilder) -> ApiResult<Value> {
    let response = request.send().await.map_err(|_| AppError::new(502, "Meta could not be reached. Try again."))?;
    let ok = response.status().is_success();
    let body: Value = response.json().await.map_err(|_| AppError::new(502, "Meta sent an unreadable answer."))?;
    if ok && body.get("error").is_none() { Ok(body) } else { Err(graph_error(&body)) }
}

/// GET a Graph path with the token and its appsecret_proof, so a leaked token alone cannot call our app.
pub async fn get(state: &AppState, path: &str, query: &[(&str, String)], token: &str) -> ApiResult<Value> {
    let proof = hex::encode(hmac_sha256(&state.cfg.app_secret, token.as_bytes()));
    let request = state.http.get(format!("{}/{path}", state.cfg.graph)).query(query).query(&[("access_token", token), ("appsecret_proof", &proof)]);
    send(request).await
}

/// POST to a Graph path, signed the same way as `get`.
pub async fn post(state: &AppState, path: &str, body: &Value, token: &str) -> ApiResult<Value> {
    let proof = hex::encode(hmac_sha256(&state.cfg.app_secret, token.as_bytes()));
    let request = state.http.post(format!("{}/{path}", state.cfg.graph)).query(&[("access_token", token), ("appsecret_proof", &proof)]).json(body);
    send(request).await
}

async fn rows(state: &AppState, path: &str, fields: &str, token: &str) -> ApiResult<Vec<Value>> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..10 {
        let mut query = vec![("fields", fields.to_string()), ("limit", "100".to_string())];
        if let Some(a) = &after {
            query.push(("after", a.clone()));
        }
        let page = get(state, path, &query, token).await?;
        out.extend(page["data"].as_array().cloned().unwrap_or_default());
        match (page["paging"]["next"].as_str(), page["paging"]["cursors"]["after"].as_str()) {
            (Some(_), Some(a)) if Some(a) != after.as_deref() && a.len() <= 512 => after = Some(a.to_string()),
            _ => return Ok(out),
        }
    }
    Ok(out)
}

fn numeric(id: &str) -> bool {
    let raw = id.strip_prefix("act_").unwrap_or(id);
    !raw.is_empty() && raw.len() <= 32 && raw.bytes().all(|b| b.is_ascii_digit())
}

/// What Meta shared at sign-in: accounts, Page tokens, granted permissions, and why any lookup failed.
pub struct Grant {
    assets: Vec<Asset>,
    page_tokens: HashMap<String, String>,
    permissions: Vec<String>,
    problems: Vec<String>,
}

/// Everything the person granted in Meta's dialog. A lookup Meta refuses yields no assets and a
/// problem line saying why, so a missing Page or number is explained instead of silently absent.
async fn discover(state: &AppState, token: &str) -> Grant {
    let (mut assets, mut page_tokens, mut problems) = (Vec::new(), HashMap::new(), Vec::new());
    let mut take = |what: &str, r: ApiResult<Vec<Value>>| r.unwrap_or_else(|e| {
        problems.push(format!("{what}: {}", e.1.trim_start_matches("Meta: ")));
        Vec::new()
    });
    let (ad_accounts, pages, businesses, permissions) = tokio::join!(
        async { rows(state, "me/adaccounts", "id,name", token).await },
        async { rows(state, "me/accounts", "id,name,access_token,instagram_business_account{id,username}", token).await },
        async { rows(state, "me/businesses", "id", token).await },
        async { rows(state, "me/permissions", "permission,status", token).await },
    );
    let (ad_accounts, pages, businesses, permissions) =
        (take("Ad accounts", ad_accounts), take("Facebook Pages", pages), take("Businesses", businesses), take("Permissions", permissions));
    let mut wabas = Vec::new();
    for business in &businesses {
        let Some(b) = business["id"].as_str().filter(|b| numeric(b)) else { continue };
        wabas.extend(take("WhatsApp accounts", rows(state, &format!("{b}/owned_whatsapp_business_accounts"), "id,name", token).await));
    }
    let mut numbers = Vec::new();
    for waba in &wabas {
        let Some(w) = waba["id"].as_str().filter(|w| numeric(w)) else { continue };
        numbers.extend(take("WhatsApp numbers", rows(state, &format!("{w}/phone_numbers"), "id,verified_name,display_phone_number", token).await));
        // Meta forwards a WhatsApp account's messages only once the app is subscribed to it.
        let what = format!("Messages from {}", waba["name"].as_str().unwrap_or("a WhatsApp account"));
        take(&what, post(state, &format!("{w}/subscribed_apps"), &json!({}), token).await.map(|_| Vec::new()));
    }
    // Meta forwards a Page's messages only once the app is subscribed to that Page.
    let mut subscribed = 0;
    for row in &pages {
        let (Some(id), Some(t)) = (row["id"].as_str().filter(|i| numeric(i)), row["access_token"].as_str()) else { continue };
        match post(state, &format!("{id}/subscribed_apps"), &json!({ "subscribed_fields": "messages" }), t).await {
            Ok(_) => subscribed += 1,
            Err(e) => problems.push(format!("Messages from {}: {}", row["name"].as_str().unwrap_or("a Page"), e.1.trim_start_matches("Meta: "))),
        }
    }
    let mut add = |kind: &str, id: &Value, name: &Value, fallback: &str, token: Option<&str>| {
        let id = id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string());
        if !numeric(&id) {
            return;
        }
        let key = format!("{kind}:{id}");
        if let Some(t) = token {
            page_tokens.insert(key.clone(), t.to_string());
        }
        let name: String = name.as_str().unwrap_or(fallback).chars().take(200).collect();
        assets.push(Asset { key, kind: kind.into(), id, name });
    };
    for row in &ad_accounts {
        add("ads", &row["id"], &row["name"], "Ad account", None);
    }
    for row in &pages {
        let page_token = row["access_token"].as_str();
        add("messenger", &row["id"], &row["name"], "Facebook Page", page_token);
        let ig = &row["instagram_business_account"];
        if ig.is_object() {
            add("instagram", &ig["id"], &ig["username"], "Instagram", page_token);
        }
    }
    for number in &numbers {
        add("whatsapp", &number["id"], &number["verified_name"], "WhatsApp number", None);
    }
    let mut permissions: Vec<String> = permissions.iter().filter(|r| r["status"] == "granted").filter_map(|r| r["permission"].as_str().map(str::to_string)).collect();
    permissions.sort();
    let count = |k: &str| assets.iter().filter(|a| a.kind == k).count();
    tracing::info!(
        "Meta shared: ads={} pages={} (subscribed={subscribed}) instagram={} whatsapp={} (businesses={} wabas={}) permissions={} problems={:?}",
        count("ads"), count("messenger"), count("instagram"), count("whatsapp"), businesses.len(), wabas.len(), permissions.len(), problems
    );
    Grant { assets, page_tokens, permissions, problems }
}

fn to_json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).expect("json")
}

/// Encrypt the tokens and save what Meta shared. Accounts new to this person start switched on;
/// earlier on/off choices for accounts still shared are kept. Returns our user id.
fn store(state: &AppState, meta_user: &str, name: &str, token: String, expires: i64, g: Grant) -> ApiResult<String> {
    let fernet = state.fernet.as_ref().ok_or_else(|| AppError::new(503, "Token encryption is not configured."))?;
    let blob = fernet.encrypt(&serde_json::to_vec(&Tokens { user: token, assets: g.page_tokens }).expect("serializable"));
    let db = lock(&state.db);
    let existing: Option<(String, String, String)> = db
        .query_row("SELECT id,assets_json,selected_json FROM users WHERE meta_user_id=?1", [meta_user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    let (id, known, selected): (String, Vec<Asset>, Vec<String>) = match existing {
        Some((id, a, s)) => (id, serde_json::from_str(&a).unwrap_or_default(), serde_json::from_str(&s).unwrap_or_default()),
        None => (random_token(), Vec::new(), Vec::new()),
    };
    let selected: Vec<&String> = g.assets.iter().map(|a| &a.key).filter(|k| selected.contains(k) || !known.iter().any(|a| &a.key == *k)).collect();
    db.execute(
        "INSERT INTO users (id,meta_user_id,name,token_blob,token_expires,assets_json,selected_json,permissions_json,problems_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(meta_user_id) DO UPDATE SET name=?3,token_blob=?4,token_expires=?5,assets_json=?6,selected_json=?7,permissions_json=?8,problems_json=?9",
        params![id, meta_user, name, blob, expires, to_json(&g.assets), to_json(&selected), to_json(&g.permissions), to_json(&g.problems)],
    )?;
    Ok(id)
}

/// Exchange the login code, store encrypted tokens, and return our user id.
pub async fn sign_in(state: &AppState, code: &str) -> ApiResult<String> {
    let c = &state.cfg;
    let exchange = |form: Vec<(&'static str, String)>| send(state.http.post(format!("{}/oauth/access_token", c.graph)).form(&form));
    let short = exchange(vec![("client_id", c.app_id.clone()), ("client_secret", c.app_secret.clone()), ("redirect_uri", c.redirect_uri.clone()), ("code", code.into())]).await?;
    let short = short["access_token"].as_str().ok_or_else(|| AppError::new(403, "Meta returned no access."))?;
    let long = exchange(vec![("grant_type", "fb_exchange_token".into()), ("client_id", c.app_id.clone()), ("client_secret", c.app_secret.clone()), ("fb_exchange_token", short.into())]).await?;
    let token = long["access_token"].as_str().ok_or_else(|| AppError::new(403, "Meta returned no access."))?.to_string();
    // Meta omits expires_in for tokens that do not expire; recheck after its usual 60 days.
    let expires = now() + long["expires_in"].as_i64().unwrap_or(60 * 86400);
    let me = get(state, "me", &[("fields", "id,name".into())], &token).await?;
    let meta_user = me["id"].as_str().filter(|id| numeric(id)).ok_or_else(|| AppError::new(403, "Meta returned no user."))?.to_string();
    let name = me["name"].as_str().unwrap_or("You").to_string();
    let grant = discover(state, &token).await;
    store(state, &meta_user, &name, token, expires, grant)
}

/// Read again what the person's current Meta access covers, without the sign-in dialog.
pub async fn refresh(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let token = tokens(&s, &u)?.user;
    let (meta_user, expires): (String, i64) = lock(&s.db).query_row("SELECT meta_user_id,token_expires FROM users WHERE id=?1", [&u.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let grant = discover(&s, &token).await;
    store(&s, &meta_user, &u.name, token, expires, grant)?;
    let prefix = format!("{}:", u.id);
    lock(&s.cache).retain(|k, _| !k.starts_with(&prefix));
    let u = user(&s, &headers)?;
    Ok(Json(json!({ "assets": u.assets, "selected": u.selected, "permissions": u.permissions, "problems": u.problems })))
}

/// Cache Meta reads per user so screens load from memory, not from a Graph round trip.
pub async fn cached<F, Fut>(state: &AppState, key: String, ttl: Duration, fetch: F) -> ApiResult<Value>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ApiResult<Value>>,
{
    if let Some((at, v)) = lock(&state.cache).get(&key) {
        if at.elapsed() < ttl {
            return Ok(v.clone());
        }
    }
    let value = fetch().await?;
    let mut cache = lock(&state.cache);
    if cache.len() > 5000 {
        cache.retain(|_, (at, _)| at.elapsed() < ttl);
    }
    cache.insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

pub const TTL: Duration = Duration::from_secs(300);

pub async fn ads_data(state: &AppState, u: &User) -> ApiResult<Value> {
    let t = tokens(state, u)?;
    let mut accounts = Vec::new();
    for a in u.selected_assets("ads") {
        let token = t.for_asset(&a.key).to_string();
        let account = cached(state, format!("{}:ads:{}", u.id, a.id), TTL, || async {
            let (info, campaigns) = tokio::try_join!(
        async { get(state, &a.id, &[("fields", "name,currency,account_status".into())], &token).await },
        async { get(state, &format!("{}/insights", a.id), &[
                    ("level", "campaign".into()),
                    ("date_preset", "last_7d".into()),
                    ("fields", "campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions".into()),
                    ("limit", "50".into()),
                ], &token).await },
    )?;
            Ok(json!({ "id": a.id, "name": info["name"], "currency": info["currency"], "status": info["account_status"], "campaigns": campaigns["data"] }))
        }).await?;
        accounts.push(account);
    }
    Ok(json!({ "accounts": accounts }))
}

pub async fn instagram_data(state: &AppState, u: &User) -> ApiResult<Value> {
    let t = tokens(state, u)?;
    let mut out = Vec::new();
    for a in u.selected_assets("instagram") {
        let token = t.for_asset(&a.key).to_string();
        let account = cached(state, format!("{}:ig:{}", u.id, a.id), TTL, || async {
            let until = now();
            let (profile, media, insights) = tokio::join!(
        async { get(state, &a.id, &[("fields", "username,name,followers_count,follows_count,media_count,profile_picture_url,biography".into())], &token).await },
        async { get(state, &format!("{}/media", a.id), &[
                    ("fields", "id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url".into()),
                    ("limit", "12".into()),
                ], &token).await },
        async { // Insights need their own permission; the rest of the screen still works without it.
                get(state, &format!("{}/insights", a.id), &[
                    ("metric", "reach,views,accounts_engaged,total_interactions".into()),
                    ("period", "day".into()),
                    ("metric_type", "total_value".into()),
                    ("since", (until - 7 * 86400).to_string()),
                    ("until", until.to_string()),
                ], &token).await },
    );
            let (profile, media) = (profile?, media?);
            let (insights, insights_error) = match insights {
                Ok(v) => (v["data"].as_array().cloned().unwrap_or_default().into_iter()
                    .map(|m| json!({ "name": m["name"], "value": m["total_value"]["value"] })).collect::<Vec<_>>(), Value::Null),
                Err(e) => (Vec::new(), json!(e.1)),
            };
            Ok(json!({ "id": a.id, "profile": profile, "media": media["data"], "insights": insights, "insights_error": insights_error }))
        }).await?;
        out.push(account);
    }
    Ok(json!({ "accounts": out }))
}

/// Recent comments on the six newest posts, for agents: one Graph call per account.
pub async fn instagram_comments(state: &AppState, u: &User) -> ApiResult<Vec<Value>> {
    let t = tokens(state, u)?;
    let mut comments = Vec::new();
    for a in u.selected_assets("instagram") {
        let fields = ("fields", "caption,comments.limit(50){text,username,timestamp}".to_string());
        let Ok(page) = get(state, &format!("{}/media", a.id), &[fields, ("limit", "6".into())], t.for_asset(&a.key)).await else { continue };
        for post in page["data"].as_array().into_iter().flatten() {
            let caption: String = post["caption"].as_str().unwrap_or("").chars().take(120).collect();
            for c in post["comments"]["data"].as_array().into_iter().flatten() {
                comments.push(json!({ "username": c["username"], "text": c["text"], "post": caption }));
            }
        }
    }
    Ok(comments)
}

/// Unix seconds from Graph's "2026-11-03T07:00:00+0000". Graph sends UTC, so the offset is not read.
fn graph_time(t: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| t.get(r).and_then(|v| v.parse::<i64>().ok());
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    // Days since 1970-01-01 from a civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let (era, mp) = (y.div_euclid(400), (m + 9) % 12);
    let yoe = y - era * 400;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + d - 1;
    Some((era * 146_097 + doe - 719_468) * 86400 + hh * 3600 + mm * 60 + ss)
}

/// Unpublished Meta apps get no real webhooks, so the inbox also reads recent Messenger and
/// Instagram conversations and Instagram comments directly, at most once a minute per account.
/// Rows share the webhook de-duplication keys, so a message never appears twice.
async fn pull(state: &AppState, u: &User) -> ApiResult<()> {
    let t = tokens(state, u)?;
    let oldest = now() - 30 * 86400;
    for a in u.assets.iter().filter(|a| u.selected.contains(&a.key) && (a.kind == "messenger" || a.kind == "instagram")) {
        let token = t.for_asset(&a.key).to_string();
        let fetched = cached(state, format!("{}:pull:{}", u.id, a.key), Duration::from_secs(60), || async {
            let mut rows: Vec<(String, String, String, String, i64, String)> = Vec::new();
            let fields = "messages.limit(10){id,message,from,created_time}".to_string();
            let conversations = get(state, "me/conversations", &[("platform", a.kind.clone()), ("fields", fields), ("limit", "20".into())], &token).await?;
            for conv in conversations["data"].as_array().into_iter().flatten() {
                for m in conv["messages"]["data"].as_array().into_iter().flatten() {
                    let from = &m["from"];
                    let (id, handle) = (from["id"].as_str().unwrap_or_default(), from["username"].as_str().or(from["name"].as_str()).unwrap_or_default());
                    let text = m["message"].as_str().unwrap_or_default();
                    // Skip the account's own messages and anything the 30-day sweep would remove.
                    let created = m["created_time"].as_str().and_then(graph_time).unwrap_or_else(now);
                    if text.is_empty() || id.is_empty() || id == a.id || handle == a.name || created < oldest {
                        continue;
                    }
                    rows.push((a.kind.clone(), id.into(), handle.into(), text.chars().take(4000).collect(), created, format!("{}:{}", a.kind, m["id"].as_str().unwrap_or_default())));
                }
            }
            if a.kind == "instagram" {
                let fields = ("fields", "comments.limit(20){id,text,username,timestamp}".to_string());
                let media = get(state, &format!("{}/media", a.id), &[fields, ("limit", "6".into())], &token).await?;
                for post in media["data"].as_array().into_iter().flatten() {
                    for c in post["comments"]["data"].as_array().into_iter().flatten() {
                        let (who, text) = (c["username"].as_str().unwrap_or_default(), c["text"].as_str().unwrap_or_default());
                        let created = c["timestamp"].as_str().and_then(graph_time).unwrap_or_else(now);
                        if text.is_empty() || who.is_empty() || who == a.name || created < oldest {
                            continue;
                        }
                        rows.push(("instagram_comment".into(), who.into(), who.into(), text.chars().take(4000).collect(), created, format!("igc:{}", c["id"].as_str().unwrap_or_default())));
                    }
                }
            }
            let db = lock(&state.db);
            for (kind, sender, name, text, created, dedupe) in &rows {
                db.execute(
                    "INSERT OR IGNORE INTO events (kind,asset_id,sender,sender_name,text,created,dedupe) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![kind, a.id, sender, name, text, created, dedupe],
                )?;
            }
            Ok(json!(rows.len()))
        }).await;
        if let Err(e) = fetched {
            tracing::warn!("inbox pull for {} {}: {}", a.kind, a.id, e.1);
        }
    }
    Ok(())
}

/// The inbox after pulling anything new; a failed pull still returns what is stored.
pub async fn fresh_inbox(state: &AppState, u: &User) -> ApiResult<Vec<Value>> {
    if let Err(e) = pull(state, u).await {
        tracing::warn!("inbox pull: {}", e.1);
    }
    inbox_rows(state, u)
}

pub fn inbox_rows(state: &AppState, u: &User) -> ApiResult<Vec<Value>> {
    let ids: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(",");
    let db = lock(&state.db);
    let mut stmt = db.prepare(&format!("SELECT id,kind,asset_id,sender,text,created,EXISTS(SELECT 1 FROM replies r WHERE r.event_id=events.id AND r.error IS NULL),sender_name,
          (SELECT error FROM replies r WHERE r.event_id=events.id)
          FROM events WHERE asset_id IN ({marks}) ORDER BY created DESC, id DESC LIMIT 100"))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "asset_id": r.get::<_, String>(2)?, "sender": r.get::<_, String>(3)?, "text": r.get::<_, String>(4)?, "created": r.get::<_, i64>(5)?, "replied": r.get::<_, bool>(6)?, "sender_name": r.get::<_, Option<String>>(7)?, "reply_error": r.get::<_, Option<String>>(8)? }))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub async fn ads(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(ads_data(&s, &u).await?))
}
pub async fn instagram(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(instagram_data(&s, &u).await?))
}
pub async fn inbox(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(json!({ "items": fresh_inbox(&s, &u).await? })))
}

#[derive(Deserialize)]
pub struct ReplyBody {
    text: String,
}

/// Meta allows free-form replies to messages only within 24 hours of the customer's message.
const REPLY_WINDOW: i64 = 24 * 3600;

/// The Graph call that answers one inbox message, or None when the message cannot be answered.
fn reply_request(kind: &str, asset_id: &str, sender: &str, dedupe: &str, text: &str) -> Option<(String, Value)> {
    match kind {
        "whatsapp" => Some((format!("{asset_id}/messages"), json!({ "messaging_product": "whatsapp", "recipient_type": "individual", "to": sender, "type": "text", "text": { "body": text } }))),
        "instagram_comment" => dedupe.strip_prefix("igc:").filter(|c| numeric(c)).map(|c| (format!("{c}/replies"), json!({ "message": text }))),
        // With a Page token, me/messages sends from that Page, on Messenger or its Instagram account.
        "messenger" | "instagram" => Some(("me/messages".into(), json!({ "recipient": { "id": sender }, "messaging_type": "RESPONSE", "message": { "text": text } }))),
        _ => None,
    }
}

/// Send the person's reply to one inbox message. Only their tap calls this; each message gets one reply.
pub async fn reply(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>, Json(body): Json<ReplyBody>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let text = body.text.trim();
    if text.is_empty() || text.chars().count() > 1000 {
        return Err(AppError::new(400, "Write a reply of up to 1,000 characters."));
    }
    let missing = || AppError::new(404, "That message is no longer in your inbox.");
    let event = lock(&s.db)
        .query_row("SELECT kind,asset_id,sender,created,dedupe FROM events WHERE id=?1", [id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?))
        })
        .optional()?;
    let (kind, asset_id, sender, created, dedupe) = event.ok_or_else(missing)?;
    // Only messages to an account this person has switched on; anything else looks like it does not exist.
    let asset_kind = if kind == "instagram_comment" { "instagram" } else { kind.as_str() };
    let asset = u.selected_assets(asset_kind).into_iter().find(|a| a.id == asset_id).ok_or_else(missing)?;
    if kind != "instagram_comment" && now() - created > REPLY_WINDOW {
        return Err(AppError::new(409, "Meta only allows a reply within 24 hours of their message."));
    }
    let (path, payload) = reply_request(&kind, &asset_id, &sender, &dedupe, text).ok_or_else(missing)?;
    let t = tokens(&s, &u)?;
    // Claim the message before sending, so a double tap cannot send twice. A reply Meta failed
    // to deliver frees the message for another try.
    let claimed = {
        let db = lock(&s.db);
        db.execute("DELETE FROM replies WHERE event_id=?1 AND error IS NOT NULL", [id])?;
        db.execute("INSERT OR IGNORE INTO replies (event_id,user_id,text,created) VALUES (?1,?2,?3,?4)", params![id, u.id, text, now()])?
    };
    if claimed == 0 {
        return Err(AppError::new(409, "You already replied to this message."));
    }
    let sent = match post(&s, &path, &payload, t.for_asset(&asset.key)).await {
        Ok(sent) => sent,
        Err(e) => {
            let _ = lock(&s.db).execute("DELETE FROM replies WHERE event_id=?1", [id]);
            return Err(e);
        }
    };
    // Meta's id for the sent message, so a later delivery failure can be matched to this reply.
    let message_id = [&sent["messages"][0]["id"], &sent["message_id"], &sent["id"]].into_iter().find_map(|v| v.as_str());
    lock(&s.db).execute("UPDATE replies SET message_id=?2 WHERE event_id=?1", params![id, message_id])?;
    Ok(Json(json!({ "sent": true })))
}

pub struct Event {
    pub kind: String,
    pub asset_id: String,
    pub sender: String,
    pub sender_name: String,
    pub text: String,
    pub dedupe: String,
}

/// Incoming WhatsApp, Messenger and Instagram messages and Instagram comments.
pub fn parse_webhook(payload: &Value) -> Vec<Event> {
    let object = payload["object"].as_str().unwrap_or_default();
    let clip = |v: &Value| v.as_str().unwrap_or_default().chars().take(4000).collect::<String>();
    let mut out = Vec::new();
    for entry in payload["entry"].as_array().into_iter().flatten() {
        let entry_id = clip(&entry["id"]);
        for change in entry["changes"].as_array().into_iter().flatten() {
            let v = &change["value"];
            if object == "whatsapp_business_account" {
                let phone = clip(&v["metadata"]["phone_number_id"]);
                let contacts = v["contacts"].as_array().map(Vec::as_slice).unwrap_or_default();
                for m in v["messages"].as_array().into_iter().flatten() {
                    let text = clip(&m["text"]["body"]);
                    if !text.is_empty() {
                        let sender = clip(&m["from"]);
                        let sender_name = contacts.iter().find(|c| clip(&c["wa_id"]) == sender).map(|c| clip(&c["profile"]["name"])).unwrap_or_default();
                        out.push(Event { kind: "whatsapp".into(), asset_id: phone.clone(), sender, sender_name, text, dedupe: format!("wa:{}", clip(&m["id"])) });
                    }
                }
            } else if object == "instagram" && change["field"] == "comments" {
                let sender = Some(clip(&v["from"]["username"])).filter(|s| !s.is_empty()).unwrap_or_else(|| clip(&v["from"]["id"]));
                out.push(Event { kind: "instagram_comment".into(), asset_id: entry_id.clone(), sender_name: clip(&v["from"]["username"]), sender, text: clip(&v["text"]), dedupe: format!("igc:{}", clip(&v["id"])) });
            }
        }
        for m in entry["messaging"].as_array().into_iter().flatten() {
            let message = &m["message"];
            let text = clip(&message["text"]);
            if text.is_empty() || message["is_echo"].as_bool() == Some(true) {
                continue;
            }
            let kind = if object == "instagram" { "instagram" } else { "messenger" };
            out.push(Event { kind: kind.into(), asset_id: entry_id.clone(), sender: clip(&m["sender"]["id"]), sender_name: String::new(), text, dedupe: format!("{kind}:{}", clip(&message["mid"])) });
        }
    }
    out
}

/// WhatsApp delivery failures, which Meta reports only through the webhook after accepting a send.
pub fn failed_sends(payload: &Value) -> Vec<(String, String)> {
    let changes = payload["entry"].as_array().into_iter().flatten().flat_map(|e| e["changes"].as_array().into_iter().flatten());
    changes
        .flat_map(|c| c["value"]["statuses"].as_array().into_iter().flatten())
        .filter(|st| st["status"] == "failed")
        .map(|st| {
            let e = &st["errors"][0];
            let reason = format!("{} ({})", e["error_data"]["details"].as_str().or(e["title"].as_str()).unwrap_or("unknown error"), e["code"]);
            (st["id"].as_str().unwrap_or_default().to_string(), reason)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_shapes() {
        let wa = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55"},"contacts":[{"wa_id":"91","profile":{"name":"Asha"}}],"messages":[{"id":"m1","from":"91","text":{"body":"price?"}}]}}]}]});
        let e = parse_webhook(&wa);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str(), e[0].text.as_str(), e[0].sender_name.as_str()), ("whatsapp", "55", "price?", "Asha"));
        let ig = json!({"object":"instagram","entry":[{"id":"77","messaging":[{"sender":{"id":"9"},"message":{"mid":"x","text":"hi"}},{"sender":{"id":"77"},"message":{"mid":"y","text":"echo","is_echo":true}}]}]});
        let e = parse_webhook(&ig);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str()), ("instagram", "77"));
        assert!(numeric("act_123") && !numeric("act_") && !numeric("12a"));
        let st = json!({"entry":[{"changes":[{"value":{"statuses":[{"status":"delivered"},{"status":"failed","id":"wamid.1","recipient_id":"91","errors":[{"code":131031,"title":"Business Account locked","error_data":{"details":"Business account has been locked."}}]}]}}]}]});
        assert_eq!(failed_sends(&st), vec![("wamid.1".to_string(), "Business account has been locked. (131031)".to_string())]);
    }

    #[test]
    fn reply_targets() {
        let (path, body) = reply_request("whatsapp", "55", "91", "wa:m1", "hi").unwrap();
        assert_eq!((path.as_str(), body["to"].as_str(), body["text"]["body"].as_str()), ("55/messages", Some("91"), Some("hi")));
        let (path, body) = reply_request("instagram_comment", "77", "bob", "igc:123", "thanks").unwrap();
        assert_eq!((path.as_str(), body["message"].as_str()), ("123/replies", Some("thanks")));
        assert!(reply_request("instagram_comment", "77", "bob", "igc:1/../x", "t").is_none());
        let (path, body) = reply_request("messenger", "5", "9", "messenger:x", "yo").unwrap();
        assert_eq!((path.as_str(), body["recipient"]["id"].as_str()), ("me/messages", Some("9")));
        assert!(reply_request("other", "5", "9", "", "yo").is_none());
    }

    #[test]
    fn graph_times() {
        assert_eq!(graph_time("1970-01-01T00:00:00+0000"), Some(0));
        assert_eq!(graph_time("2026-11-03T07:00:00+0000"), Some(1_793_689_200));
        assert_eq!(graph_time("2024-02-29T12:30:15+0000"), Some(1_709_209_815));
        assert_eq!(graph_time("garbage"), None);
    }
}
