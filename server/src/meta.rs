//! Meta Graph API: sign-in, account inventory, Ads and Instagram reads, webhook parsing.
use crate::{hmac_sha256, lock, now, random_token, tokens, user, ApiResult, AppError, AppState, User};
use axum::{extract::State, http::HeaderMap, Json};
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

/// Everything the person granted in Meta's dialog. A product the app lacks yields no assets, not a failure.
async fn inventory(state: &AppState, token: &str) -> (Vec<Asset>, HashMap<String, String>) {
    let (mut assets, mut page_tokens) = (Vec::new(), HashMap::new());
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
    for row in rows(state, "me/adaccounts", "id,name", token).await.unwrap_or_default() {
        add("ads", &row["id"], &row["name"], "Ad account", None);
    }
    for row in rows(state, "me/accounts", "id,name,access_token,instagram_business_account{id,username}", token).await.unwrap_or_default() {
        let page_token = row["access_token"].as_str();
        add("messenger", &row["id"], &row["name"], "Facebook Page", page_token);
        let ig = &row["instagram_business_account"];
        if ig.is_object() {
            add("instagram", &ig["id"], &ig["username"], "Instagram", page_token);
        }
    }
    for business in rows(state, "me/businesses", "id", token).await.unwrap_or_default() {
        let Some(b) = business["id"].as_str().filter(|b| numeric(b)) else { continue };
        for waba in rows(state, &format!("{b}/owned_whatsapp_business_accounts"), "id,name", token).await.unwrap_or_default() {
            let Some(w) = waba["id"].as_str().filter(|w| numeric(w)) else { continue };
            for number in rows(state, &format!("{w}/phone_numbers"), "id,verified_name,display_phone_number", token).await.unwrap_or_default() {
                add("whatsapp", &number["id"], &number["verified_name"], "WhatsApp number", None);
            }
        }
    }
    (assets, page_tokens)
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
    let (assets, page_tokens) = inventory(state, &token).await;
    let fernet = state.fernet.as_ref().ok_or_else(|| AppError::new(503, "Token encryption is not configured."))?;
    let blob = fernet.encrypt(&serde_json::to_vec(&Tokens { user: token, assets: page_tokens }).expect("serializable"));

    let db = lock(&state.db);
    let existing: Option<(String, String, String)> = db
        .query_row("SELECT id,assets_json,selected_json FROM users WHERE meta_user_id=?1", [&meta_user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    // Accounts chosen in Meta's dialog start switched on; earlier choices for accounts still granted are kept.
    let (id, known, selected): (String, Vec<Asset>, Vec<String>) = match existing {
        Some((id, a, s)) => (id, serde_json::from_str(&a).unwrap_or_default(), serde_json::from_str(&s).unwrap_or_default()),
        None => (random_token(), Vec::new(), Vec::new()),
    };
    let selected: Vec<&String> = assets.iter().map(|a| &a.key).filter(|k| selected.contains(k) || !known.iter().any(|a| &a.key == *k)).collect();
    db.execute(
        "INSERT INTO users (id,meta_user_id,name,token_blob,token_expires,assets_json,selected_json) VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(meta_user_id) DO UPDATE SET name=?3,token_blob=?4,token_expires=?5,assets_json=?6,selected_json=?7",
        params![id, meta_user, name, blob, expires, serde_json::to_string(&assets).expect("json"), serde_json::to_string(&selected).expect("json")],
    )?;
    Ok(id)
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
            let info = get(state, &a.id, &[("fields", "name,currency,account_status".into())], &token).await?;
            let campaigns = get(state, &format!("{}/insights", a.id), &[
                ("level", "campaign".into()),
                ("date_preset", "last_7d".into()),
                ("fields", "campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions".into()),
                ("limit", "50".into()),
            ], &token).await?;
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
            let profile = get(state, &a.id, &[("fields", "username,name,followers_count,follows_count,media_count,profile_picture_url,biography".into())], &token).await?;
            let media = get(state, &format!("{}/media", a.id), &[
                ("fields", "id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url".into()),
                ("limit", "12".into()),
            ], &token).await?;
            let until = now();
            // Insights need their own permission; the rest of the screen still works without it.
            let insights = get(state, &format!("{}/insights", a.id), &[
                ("metric", "reach,views,accounts_engaged,total_interactions".into()),
                ("period", "day".into()),
                ("metric_type", "total_value".into()),
                ("since", (until - 7 * 86400).to_string()),
                ("until", until.to_string()),
            ], &token).await;
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

/// Recent comments on the newest posts, for agents.
pub async fn instagram_comments(state: &AppState, u: &User) -> ApiResult<Vec<Value>> {
    let t = tokens(state, u)?;
    let data = instagram_data(state, u).await?;
    let mut comments = Vec::new();
    for account in data["accounts"].as_array().into_iter().flatten() {
        let key = format!("instagram:{}", account["id"].as_str().unwrap_or_default());
        for post in account["media"].as_array().into_iter().flatten().take(6) {
            let Some(id) = post["id"].as_str().filter(|id| numeric(id)) else { continue };
            if let Ok(page) = get(state, &format!("{id}/comments"), &[("fields", "id,text,username,timestamp".into()), ("limit", "50".into())], t.for_asset(&key)).await {
                for c in page["data"].as_array().into_iter().flatten() {
                    comments.push(json!({ "username": c["username"], "text": c["text"], "post": post["caption"].as_str().unwrap_or("").chars().take(120).collect::<String>() }));
                }
            }
        }
    }
    Ok(comments)
}

pub fn inbox_rows(state: &AppState, u: &User) -> ApiResult<Vec<Value>> {
    let ids: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(",");
    let db = lock(&state.db);
    let mut stmt = db.prepare(&format!("SELECT id,kind,asset_id,sender,text,created FROM events WHERE asset_id IN ({marks}) ORDER BY id DESC LIMIT 100"))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "asset_id": r.get::<_, String>(2)?, "sender": r.get::<_, String>(3)?, "text": r.get::<_, String>(4)?, "created": r.get::<_, i64>(5)? }))
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
    Ok(Json(json!({ "items": inbox_rows(&s, &u)? })))
}

pub struct Event {
    pub kind: String,
    pub asset_id: String,
    pub sender: String,
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
                for m in v["messages"].as_array().into_iter().flatten() {
                    let text = clip(&m["text"]["body"]);
                    if !text.is_empty() {
                        out.push(Event { kind: "whatsapp".into(), asset_id: phone.clone(), sender: clip(&m["from"]), text, dedupe: format!("wa:{}", clip(&m["id"])) });
                    }
                }
            } else if object == "instagram" && change["field"] == "comments" {
                let sender = Some(clip(&v["from"]["username"])).filter(|s| !s.is_empty()).unwrap_or_else(|| clip(&v["from"]["id"]));
                out.push(Event { kind: "instagram_comment".into(), asset_id: entry_id.clone(), sender, text: clip(&v["text"]), dedupe: format!("igc:{}", clip(&v["id"])) });
            }
        }
        for m in entry["messaging"].as_array().into_iter().flatten() {
            let message = &m["message"];
            let text = clip(&message["text"]);
            if text.is_empty() || message["is_echo"].as_bool() == Some(true) {
                continue;
            }
            let kind = if object == "instagram" { "instagram" } else { "messenger" };
            out.push(Event { kind: kind.into(), asset_id: entry_id.clone(), sender: clip(&m["sender"]["id"]), text, dedupe: format!("{kind}:{}", clip(&message["mid"])) });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_shapes() {
        let wa = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55"},"messages":[{"id":"m1","from":"91","text":{"body":"price?"}}]}}]}]});
        let e = parse_webhook(&wa);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str(), e[0].text.as_str()), ("whatsapp", "55", "price?"));
        let ig = json!({"object":"instagram","entry":[{"id":"77","messaging":[{"sender":{"id":"9"},"message":{"mid":"x","text":"hi"}},{"sender":{"id":"77"},"message":{"mid":"y","text":"echo","is_echo":true}}]}]});
        let e = parse_webhook(&ig);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str()), ("instagram", "77"));
        assert!(numeric("act_123") && !numeric("act_") && !numeric("12a"));
    }
}
