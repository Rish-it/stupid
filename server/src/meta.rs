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
    /// What stops or limits this account, in plain words, from Meta's own health check.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<Issue>,
    /// The Meta business a WhatsApp number belongs to, for links to that business's own screens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub business: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Issue {
    pub blocking: bool,
    pub text: String,
    pub fix: String,
    pub link: String,
}

/// Meta's WhatsApp health check turned into plain words and a link to the exact screen that fixes it.
fn whatsapp_issues(health: &Value, business: &str, waba: &str) -> Vec<Issue> {
    let mut out: Vec<Issue> = Vec::new();
    let mut seen = Vec::new();
    for entity in health["entities"].as_array().into_iter().flatten() {
        let blocked = entity["can_send_message"] == "BLOCKED";
        for e in entity["errors"].as_array().into_iter().flatten() {
            let code = e["error_code"].as_i64().unwrap_or_default();
            // A missing payment method stops only business-started template chats, which Stupid never sends.
            let blocking = blocked && code != TEMPLATES_ONLY;
            // Calling over SIP is not something Stupid uses.
            if matches!(code, 138024 | 138025) || seen.contains(&code) {
                continue;
            }
            seen.push(code);
            let (text, fix, link) = match code {
                TEMPLATES_ONLY => ("Meta wants a payment method before this account can start chats with templates.", "Replies to customers who message you still send. Stupid never sends templates. To add one anyway, open Billing & payments, select this WhatsApp account, then Payment methods. Messages can be charged by Meta.", format!("https://business.facebook.com/billing_hub/accounts/details/?business_id={business}&asset_id={waba}")),
                141007 => ("This WhatsApp account has no time zone.", "Set a time zone for the WhatsApp account.", format!("https://business.facebook.com/latest/settings/whatsapp_account?business_id={business}")),
                141010 => ("Your business isn't verified, so new chats per day are limited.", "Open Security Center and follow the verification steps Meta asks for. This is different from a paid Meta Verified badge.", format!("https://business.facebook.com/latest/settings/security_center?business_id={business}")),
                131031 => ("Meta has restricted this WhatsApp account.", VERIFY, security_center(Some(business))),
                131042 => ("WhatsApp couldn't use this account's billing setup.", "Open Billing & payments, select this account and check Payment methods, its balance, currency and time zone.", "https://business.facebook.com/latest/billing_hub/payment_methods/".into()),
                131045 | 133010 => ("This WhatsApp number isn't registered for messaging.", "In WhatsApp Manager, select this account and Phone numbers. Finish verifying and registering your number before trying again.", "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration".into()),
                131000 => ("Your business profile is missing its legal name, country or website.", "Fill in your business info.", format!("https://business.facebook.com/latest/settings/business_info?business_id={business}")),
                _ => (e["error_description"].as_str().unwrap_or("Meta reported a problem with this account."), e["possible_solution"].as_str().unwrap_or("Open WhatsApp Manager to see what Meta needs."), format!("https://business.facebook.com/wa/manage/home/?business_id={business}&waba_id={waba}")),
            };
            out.push(Issue { blocking, text: text.chars().take(300).collect(), fix: fix.chars().take(300).collect(), link });
        }
    }
    let payment_only = |e: &Value| e["errors"].as_array().into_iter().flatten().any(|x| x["error_code"] == TEMPLATES_ONLY);
    let entities = || health["entities"].as_array().into_iter().flatten();
    if ((health["can_send_message"] == "BLOCKED" && !entities().any(payment_only))
        || entities().any(|e| e["can_send_message"] == "BLOCKED" && !payment_only(e)))
        && !out.iter().any(|issue| issue.blocking)
    {
        out.push(Issue {
            blocking: true,
            text: "Meta is blocking messages from this WhatsApp account.".into(),
            fix: "Open Business Support Home, select this account and follow the requirement shown. Meta hasn't shared a more specific reason yet.".into(),
            link: "https://business.facebook.com/business-support-home/".into(),
        });
    }
    out
}

/// Meta's "no payment method" code, which blocks only template messages a business starts.
const TEMPLATES_ONLY: i64 = 141006;

const VERIFY: &str = "Meta has restricted your business. Open Security Center and verify your business (not the paid Meta Verified badge). \
If Meta shows another reason, follow it in Business Support Home. Sending works here again as soon as Meta lifts it.";

fn security_center(business: Option<&str>) -> String {
    match business.filter(|b| numeric(b)) {
        Some(b) => format!("https://business.facebook.com/latest/settings/security_center?business_id={b}"),
        None => "https://business.facebook.com/latest/settings/security_center".into(),
    }
}

/// Meta codes that stop every WhatsApp send from a business until Meta lifts them. Meta's health check can still
/// say AVAILABLE meanwhile, so the refusal itself is what Stupid goes by.
const BUSINESS_BLOCKS: [i64; 1] = [131031];

/// Keep a business-level refusal for a WhatsApp number, or clear it once Meta reports a message from it as sent.
pub fn whatsapp_sent(db: &rusqlite::Connection, asset_id: &str, refusal: Option<(&str, i64)>) -> rusqlite::Result<()> {
    match refusal {
        Some((reason, code)) if BUSINESS_BLOCKS.contains(&code) => db.execute(
            "INSERT INTO wa_blocks (asset_id,reason,at) VALUES (?1,?2,?3) ON CONFLICT(asset_id) DO UPDATE SET reason=?2,at=?3",
            params![asset_id, reason.chars().take(300).collect::<String>(), now()],
        ),
        Some(_) => Ok(0),
        None => db.execute("DELETE FROM wa_blocks WHERE asset_id=?1", [asset_id]),
    }
    .map(drop)
}

/// A refused send from a WhatsApp number, if it was a business-level one, is kept for that number.
pub fn whatsapp_refused(db: &rusqlite::Connection, asset_id: &str, error: &str) -> rusqlite::Result<()> {
    match crate::owner::meta_code(error) {
        Some(code) => whatsapp_sent(db, asset_id, Some((error.trim_start_matches("Meta: "), code))),
        None => Ok(()),
    }
}

/// Is this WhatsApp number refused by Meta at the business level right now?
pub fn whatsapp_blocked(db: &rusqlite::Connection, asset_id: &str) -> rusqlite::Result<bool> {
    db.query_row("SELECT 1 FROM wa_blocks WHERE asset_id=?1", [asset_id], |_| Ok(())).optional().map(|r| r.is_some())
}

/// Meta's own refusal of a WhatsApp number's sends, as an issue on that number, ahead of what the health check says.
pub fn add_refusals(db: &rusqlite::Connection, assets: &mut [Asset]) -> rusqlite::Result<()> {
    for a in assets.iter_mut().filter(|a| a.kind == "whatsapp") {
        // ponytail: accounts read from Meta before 141006 stopped blocking keep it stored as blocking; drop once every account has refreshed.
        for i in a.issues.iter_mut().filter(|i| i.text.starts_with("WhatsApp needs a payment method")) {
            i.blocking = false;
        }
        let reason: Option<String> = db.query_row("SELECT reason FROM wa_blocks WHERE asset_id=?1", [&a.id], |r| r.get(0)).optional()?;
        if let Some(reason) = reason {
            a.issues.retain(|i| !i.blocking);
            a.issues.insert(0, Issue { blocking: true, text: format!("Meta refused to send from this number: {reason}"), fix: VERIFY.into(), link: security_center(a.business.as_deref()) });
        }
    }
    Ok(())
}

/// With several WhatsApp numbers switched on, only one is judged: the one the owner is paired on, else the healthiest.
/// The others' problems stay listed on them but no longer block or warn, so an old broken number can't hide a working one.
pub fn judge_numbers(assets: &mut [Asset], selected: &[String], paired: Option<&str>) {
    let on: Vec<usize> = (0..assets.len()).filter(|&i| assets[i].kind == "whatsapp" && selected.contains(&assets[i].key)).collect();
    if on.len() < 2 {
        return;
    }
    let blocks = |a: &Asset| a.issues.iter().filter(|i| i.blocking).count();
    let judged = on.iter().copied().find(|&i| Some(assets[i].id.as_str()) == paired)
        .or_else(|| on.iter().copied().min_by_key(|&i| blocks(&assets[i])));
    for i in on.into_iter().filter(|&i| Some(i) != judged) {
        for issue in &mut assets[i].issues {
            issue.blocking = false;
        }
    }
}

/// Per WhatsApp number in a status webhook: a business-level refusal, or None once a message was sent.
pub fn whatsapp_states(payload: &Value) -> Vec<(String, Option<(String, i64)>)> {
    let values = payload["entry"].as_array().into_iter().flatten().flat_map(|e| e["changes"].as_array().into_iter().flatten()).map(|c| &c["value"]);
    let mut out = Vec::new();
    for v in values {
        let Some(phone) = v["metadata"]["phone_number_id"].as_str() else { continue };
        for st in v["statuses"].as_array().into_iter().flatten() {
            let e = &st["errors"][0];
            match (st["status"].as_str(), e["code"].as_i64()) {
                (Some("sent" | "delivered" | "read"), _) => out.push((phone.to_string(), None)),
                (Some("failed"), Some(code)) if BUSINESS_BLOCKS.contains(&code) => {
                    let reason = format!("{} ({code})", e["error_data"]["details"].as_str().or(e["title"].as_str()).unwrap_or("refused"));
                    out.push((phone.to_string(), Some((reason, code))));
                }
                _ => {}
            }
        }
    }
    out
}

fn ad_account_issues(account: &Value) -> Vec<Issue> {
    let (text, fix, link) = match account["account_status"].as_i64() {
        Some(2) => ("Meta has disabled this ad account.", "Select this ad account in Business Support Home. Read the restriction and choose Request review if offered.", "https://business.facebook.com/business-support-home/"),
        Some(3) => ("This ad account has an unpaid balance.", "In Billing & payments, select this ad account and resolve the balance or failed payment. Reading past results doesn't require a new campaign.", "https://business.facebook.com/latest/billing_hub/payment_methods/"),
        Some(7..=9) => ("Meta is reviewing this ad account or its payment setup.", "Select this ad account in Business Support Home and check for a review or a payment requirement. Come back here and check again after Meta updates it.", "https://business.facebook.com/business-support-home/"),
        Some(100 | 101) => ("This ad account is closing or closed.", "Choose another ad account in Stupid, or review this account in Ads Manager. Past results may still be available.", "https://adsmanager.facebook.com/adsmanager/manage/campaigns/"),
        _ => return Vec::new(),
    };
    vec![Issue { blocking: true, text: text.into(), fix: fix.into(), link: link.into() }]
}

fn page_issues(page: &Value) -> Vec<Issue> {
    let Some(tasks) = page["tasks"].as_array() else { return Vec::new() };
    if tasks.iter().any(|task| task == "MESSAGING" || task == "MANAGE") {
        return Vec::new();
    }
    vec![Issue {
        blocking: true,
        text: "Your Page access doesn't include messages.".into(),
        fix: "Ask someone with full control to open Settings, select this Page and assign you messaging access. Then connect again. In the Page's settings, also check How people find and contact you allows messages.".into(),
        link: "https://www.facebook.com/business/help/1101781386943864".into(),
    }]
}

/// Graph shows a Page's Instagram only when it is a professional account linked to that Page, so a Page
/// without one gets both snags. They don't block the Page's own messages.
pub const NO_INSTAGRAM: &str = "No Instagram account is linked to this Page.";
pub const NOT_PROFESSIONAL: &str = "Only a professional Instagram account (Creator or Business) can be linked.";
fn instagram_issues(page: &Value) -> Vec<Issue> {
    if page["instagram_business_account"].is_object() {
        return Vec::new();
    }
    vec![
        Issue {
            blocking: false,
            text: NOT_PROFESSIONAL.into(),
            fix: "If your Instagram is a personal account, switch it to Creator or Business in the Instagram app; it's free. Then link it to this Page and connect again.".into(),
            link: "https://help.instagram.com/502981923235522".into(),
        },
        Issue {
            blocking: false,
            text: NO_INSTAGRAM.into(),
            fix: "Link your professional Instagram to this Page from the Page's linked accounts, then connect again in Stupid.".into(),
            link: "https://www.facebook.com/business/help/898752960195806".into(),
        },
    ]
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
    AppError::new(502, format!("Meta: {message} ({})", e["code"].as_i64().unwrap_or_default()))
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
        async { rows(state, "me/adaccounts", "id,name,account_status", token).await },
        async { rows(state, "me/accounts", "id,name,access_token,tasks,instagram_business_account{id,username}", token).await },
        async { rows(state, "me/businesses", "id", token).await },
        async { rows(state, "me/permissions", "permission,status", token).await },
    );
    let (ad_accounts, pages, businesses, permissions) =
        (take("Ad accounts", ad_accounts), take("Facebook Pages", pages), take("Businesses", businesses), take("Permissions", permissions));
    let mut wabas = Vec::new();
    for business in &businesses {
        let Some(b) = business["id"].as_str().filter(|b| numeric(b)) else { continue };
        let owned = take("WhatsApp accounts", rows(state, &format!("{b}/owned_whatsapp_business_accounts"), "id,name", token).await);
        wabas.extend(owned.into_iter().map(|w| (w, b.to_string())));
    }
    let mut numbers = Vec::new();
    let mut issues = HashMap::new();
    let mut business_of = HashMap::new();
    for account in &ad_accounts {
        if let Some(id) = account["id"].as_str() {
            issues.insert(format!("ads:{id}"), ad_account_issues(account));
        }
    }
    for page in &pages {
        if let Some(id) = page["id"].as_str() {
            issues.insert(format!("messenger:{id}"), [page_issues(page), instagram_issues(page)].concat());
        }
    }
    for (waba, b) in &wabas {
        let Some(w) = waba["id"].as_str().filter(|w| numeric(w)) else { continue };
        let found = take("WhatsApp numbers", rows(state, &format!("{w}/phone_numbers"), "id,verified_name,display_phone_number,health_status", token).await);
        for n in &found {
            issues.insert(format!("whatsapp:{}", n["id"].as_str().unwrap_or_default()), whatsapp_issues(&n["health_status"], b, w));
            business_of.insert(format!("whatsapp:{}", n["id"].as_str().unwrap_or_default()), b.clone());
        }
        numbers.extend(found);
        // Meta forwards a WhatsApp account's messages only once the app is subscribed to it.
        let what = format!("Messages from {}", waba["name"].as_str().unwrap_or("a WhatsApp account"));
        take(&what, post(state, &format!("{w}/subscribed_apps"), &json!({}), token).await.map(|_| Vec::new()));
    }
    // Meta forwards a Page's messages only once the app is subscribed to that Page.
    let mut subscribed = 0;
    for row in &pages {
        let (Some(id), Some(t)) = (row["id"].as_str().filter(|i| numeric(i)), row["access_token"].as_str()) else { continue };
        // Setting the fields replaces the list, so every field Stupid reads goes in each time.
        match post(state, &format!("{id}/subscribed_apps"), &json!({ "subscribed_fields": "messages,messaging_postbacks,message_reactions,feed" }), t).await {
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
        // Meta can list one WhatsApp account under more than one business.
        if assets.iter().any(|a: &Asset| a.key == key) {
            return;
        }
        if let Some(t) = token {
            page_tokens.insert(key.clone(), t.to_string());
        }
        let name: String = name.as_str().unwrap_or(fallback).chars().take(200).collect();
        assets.push(Asset { key, kind: kind.into(), id, name, issues: Vec::new(), business: None });
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
    for a in &mut assets {
        a.issues = issues.remove(&a.key).unwrap_or_default();
        a.business = business_of.remove(&a.key);
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
                async {
                    get(state, &format!("{}/insights", a.id), &[
                        ("level", "campaign".into()),
                        ("date_preset", "last_7d".into()),
                        ("fields", "campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions".into()),
                        ("limit", "50".into()),
                    ], &token).await
                },
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
                async {
                    get(state, &format!("{}/media", a.id), &[
                        ("fields", "id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url".into()),
                        ("limit", "12".into()),
                    ], &token).await
                },
                // Insights need their own permission; the rest of the screen still works without it.
                async {
                    get(state, &format!("{}/insights", a.id), &[
                        ("metric", "reach,views,accounts_engaged,total_interactions".into()),
                        ("period", "day".into()),
                        ("metric_type", "total_value".into()),
                        ("since", (until - 7 * 86400).to_string()),
                        ("until", until.to_string()),
                    ], &token).await
                },
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
/// Instagram conversations and Instagram comments directly, at most every 15 seconds per account.
/// Rows share the webhook de-duplication keys, so a message never appears twice.
/// kind, sender, sender name, text, created, de-duplication key, voice-note audio, the post a comment is on.
type Pulled = (String, String, String, String, i64, String, Option<String>, Option<String>);

/// What an Instagram DM carries besides words, said in front of them: a story reply, a shared post or Reel,
/// a story mention. Meta's links to those are kept out; they need the person's own Instagram to open.
fn with_notes(notes: &[&str], text: &str) -> String {
    let mut notes: Vec<&str> = notes.to_vec();
    notes.dedup();
    notes.into_iter().chain(Some(text).filter(|t| !t.is_empty())).collect::<Vec<_>>().join(" ")
}

const STORY_REPLY: &str = "(Replied to your story)";
const STORY_MENTION: &str = "(Mentioned you in their story)";
const SHARED_POST: &str = "(Shared a post)";
const SHARED_REEL: &str = "(Shared a Reel)";

pub async fn pull(state: &AppState, u: &User) -> ApiResult<()> {
    let t = tokens(state, u)?;
    let oldest = now() - 30 * 86400;
    for a in u.assets.iter().filter(|a| u.selected.contains(&a.key) && (a.kind == "messenger" || a.kind == "instagram")) {
        let token = t.for_asset(&a.key).to_string();
        let fetched = cached(state, format!("{}:pull:{}", u.id, a.key), Duration::from_secs(15), || async {
            let mut rows: Vec<Pulled> = Vec::new();
            let fields = "messages.limit(10){id,message,from,created_time,shares{link},story,attachments{mime_type,file_url,image_data,video_data}}".to_string();
            let conversations = get(state, "me/conversations", &[("platform", a.kind.clone()), ("fields", fields), ("limit", "20".into())], &token).await?;
            for conv in conversations["data"].as_array().into_iter().flatten() {
                for m in conv["messages"]["data"].as_array().into_iter().flatten() {
                    let from = &m["from"];
                    let (id, handle) = (from["id"].as_str().unwrap_or_default(), from["username"].as_str().or(from["name"].as_str()).unwrap_or_default());
                    let notes: Vec<&str> = [
                        (m["story"]["reply_to"].is_object(), STORY_REPLY),
                        (m["story"]["mention"].is_object(), STORY_MENTION),
                        (m["shares"]["data"].as_array().is_some_and(|d| !d.is_empty()), SHARED_POST),
                    ].into_iter().filter(|(on, _)| *on).map(|(_, n)| n).collect();
                    let text = &with_notes(&notes, m["message"].as_str().unwrap_or_default());
                    // A voice note, photo or video comes as an attachment; it is put into words after it is stored.
                    let audio = m["attachments"]["data"].as_array().into_iter().flatten().find_map(|x| {
                        let mime = x["mime_type"].as_str()?;
                        let prefix = if mime.starts_with("audio/") { "" } else if mime.starts_with("image/") { "photo:" } else if mime.starts_with("video/") { "video:" } else { return None };
                        x["file_url"].as_str().or(x["image_data"]["url"].as_str()).or(x["video_data"]["url"].as_str()).map(|u| format!("{prefix}url:{u}"))
                    });
                    // Skip the account's own messages and anything the 30-day sweep would remove.
                    let created = m["created_time"].as_str().and_then(graph_time).unwrap_or_else(now);
                    if (text.is_empty() && audio.is_none()) || id.is_empty() || id == a.id || handle == a.name || created < oldest {
                        continue;
                    }
                    rows.push((a.kind.clone(), id.into(), handle.into(), text.chars().take(4000).collect(), created, format!("{}:{}", a.kind, m["id"].as_str().unwrap_or_default()), audio, None));
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
                        rows.push(("instagram_comment".into(), who.into(), who.into(), text.chars().take(4000).collect(), created, format!("igc:{}", c["id"].as_str().unwrap_or_default()), None,
                            post["id"].as_str().map(str::to_owned)));
                    }
                }
            }
            let mut added = Vec::new();
            let mut from_owner = Vec::new();
            let db = lock(&state.db);
            for (kind, sender, name, text, created, dedupe, media, post_id) in &rows {
                // The owner writing to their own Page on Messenger is talking to their agent, never a customer.
                if let Some(owned) = crate::owner::take_owner(&db, kind, &a.id, sender, text, dedupe, *created)? {
                    from_owner.push(owned);
                    continue;
                }
                if db.execute(
                    "INSERT OR IGNORE INTO events (kind,asset_id,sender,sender_name,text,created,dedupe,media,post_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![kind, a.id, sender, name, text, created, dedupe, media, post_id],
                )? == 1 {
                    added.push(db.last_insert_rowid());
                }
            }
            db.execute("UPDATE users SET last_pull=?1 WHERE id=?2", params![now(), u.id])?;
            drop(db);
            crate::voice::arrived(state, &added);
            // Answered by the owner worker, in order (the agent's own tools pull the inbox, so not from here).
            for owned in from_owner {
                crate::owner::later(owned);
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
    // Numbered, because the draft lookups below name the person as the last parameter.
    let marks = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let db = lock(&state.db);
    let mut stmt = db.prepare(&format!("SELECT events.id,kind,asset_id,sender,events.text,events.created,EXISTS(SELECT 1 FROM replies r WHERE r.event_id=events.id AND r.error IS NULL),sender_name,
          (SELECT error FROM replies r WHERE r.event_id=events.id),voice,media,d.text,d.source,matched_json,heard_json,d.model,d.styled,l.answer,l.created,post_id,
          (SELECT text FROM replies r WHERE r.event_id=events.id AND r.error IS NULL),
          EXISTS(SELECT 1 FROM skips k WHERE k.event_id=events.id AND k.user_id=?{u})
          FROM events LEFT JOIN drafts d ON d.id=(SELECT MAX(id) FROM drafts WHERE event_id=events.id AND user_id=?{u})
          LEFT JOIN learned l ON l.id=d.learned_id AND l.user_id=d.user_id
          WHERE asset_id IN ({marks}) ORDER BY events.created DESC, events.id DESC LIMIT 100", u = ids.len() + 1))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter().chain([&u.id])), |r| {
        let media: Option<String> = r.get(10)?;
        let (_, photo, described_by) = crate::voice::trace(r.get(14)?);
        Ok(json!({ "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "asset_id": r.get::<_, String>(2)?, "sender": r.get::<_, String>(3)?, "text": r.get::<_, String>(4)?, "created": r.get::<_, i64>(5)?, "replied": r.get::<_, bool>(6)?, "sender_name": r.get::<_, Option<String>>(7)?, "reply_error": r.get::<_, Option<String>>(8)?,
            "voice": r.get::<_, bool>(9)?,
            "photo": !photo.is_null() || media.as_deref().is_some_and(|m| crate::voice::media_kind(m).0 == crate::voice::Media::Photo),
            // A voice note, photo or video still being put into words.
            "transcribing": media.as_deref().map(|m| crate::voice::media_kind(m).0.name()),
            "draft": r.get::<_, Option<String>>(11)?.map(|text| -> rusqlite::Result<Value> { Ok(json!({ "text": text, "source": r.get::<_, String>(12)?,
                "models": crate::tools::models(described_by.clone(), r.get(15)?), "styled": r.get::<_, bool>(16)?,
                "used": r.get::<_, Option<String>>(17)?.map(|a| -> rusqlite::Result<Value> { Ok(json!({ "answer": a, "told": r.get::<_, i64>(18)? })) }).transpose()? })) }).transpose()?,
            "matched_post": crate::tools::matched(r.get(13)?, &u.id),
            // The owner's post a comment is on, as Stupid's own copy of its picture.
            "post_picture": r.get::<_, Option<String>>(19)?.map(|id| format!("/api/instagram/media/{id}/image")),
            // What the owner sent, so a replied thread shows it.
            "reply_text": r.get::<_, Option<String>>(20)?,
            // The owner chose not to answer it.
            "skipped": r.get::<_, bool>(21)? }))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Version marks for what a signed-in screen shows, so the live stream can say what changed.
pub fn marks(state: &AppState, u: &User) -> ApiResult<Value> {
    let ids: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    let marks = vec!["?"; ids.len().max(1)].join(",");
    let db = lock(&state.db);
    let inbox: String = db.query_row(
        &format!("SELECT IFNULL(MAX(id),0)||':'||COUNT(*)||':'||IFNULL(SUM(voice),0) FROM events WHERE asset_id IN ({marks})"),
        rusqlite::params_from_iter(ids.iter().map(String::as_str).chain(ids.is_empty().then_some(""))),
        |r| r.get(0),
    )?;
    let replies: String = db.query_row("SELECT COUNT(*)||':'||COUNT(error) FROM replies WHERE user_id=?1", [&u.id], |r| r.get(0))?;
    let runs: String = db.query_row("SELECT IFNULL(MAX(id),0)||':'||IFNULL(SUM(status='running'),0) FROM agent_runs WHERE user_id=?1", [&u.id], |r| r.get(0))?;
    let agent: String = db.query_row(
        "SELECT IFNULL((SELECT MAX(r.id) FROM reports r JOIN tickets k ON k.id=r.ticket_id WHERE k.user_id=?1),0)||':'||IFNULL((SELECT MAX(id) FROM drafts WHERE user_id=?1),0)",
        [&u.id], |r| r.get(0))?;
    let connections = format!("{}:{}:{}", to_json(&u.assets).len(), u.selected.len(), u.problems.len());
    Ok(json!({ "inbox": inbox, "replies": replies, "runs": runs, "agent": agent, "connections": connections }))
}

pub async fn ads(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(ads_data(&s, &u).await?))
}
pub async fn instagram(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(for_browser(instagram_data(&s, &u).await?)))
}

/// Instagram's own file links stay on the server; each post with a picture points at Stupid's copy instead.
fn for_browser(mut ig: Value) -> Value {
    for a in ig["accounts"].as_array_mut().into_iter().flatten() {
        if let Some(p) = a["profile"].as_object_mut() {
            p.remove("profile_picture_url");
        }
        for m in a["media"].as_array_mut().into_iter().flatten() {
            let picture = crate::crops::picture(m).is_some();
            let id = m["id"].as_str().unwrap_or_default().to_string();
            if let Some(o) = m.as_object_mut() {
                o.remove("media_url");
                o.remove("thumbnail_url");
                if picture {
                    o.insert("picture".into(), json!(format!("/api/instagram/media/{id}/image")));
                }
            }
        }
    }
    ig
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
    send_reply(&s, &u, id, &body.text).await?;
    Ok(Json(json!({ "sent": true })))
}

/// `POST /api/inbox/{id}/skip`: the owner won't answer this message. Nothing is sent; its draft leaves Needs you.
pub async fn skip(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let ids: Vec<&str> = u.assets.iter().map(|a| a.id.as_str()).collect();
    let db = lock(&s.db);
    let asset: Option<String> = db.query_row("SELECT asset_id FROM events WHERE id=?1", [id], |r| r.get(0)).optional()?;
    if !asset.is_some_and(|a| ids.contains(&a.as_str())) {
        return Err(AppError::new(404, "That message isn't in your inbox."));
    }
    db.execute("INSERT OR IGNORE INTO skips (user_id,event_id,created) VALUES (?1,?2,?3)", params![u.id, id, now()])?;
    Ok(Json(json!({ "skipped": true })))
}

/// The one send path for a reply to a customer: the app's Send tap, and the owner's "1" on WhatsApp.
pub async fn send_reply(s: &AppState, u: &User, id: i64, text: &str) -> ApiResult<()> {
    let text = text.trim();
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
    let t = tokens(s, u)?;
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
    let sent = match post(s, &path, &payload, t.for_asset(&asset.key)).await {
        Ok(sent) => sent,
        Err(e) => {
            let db = lock(&s.db);
            let _ = db.execute("DELETE FROM replies WHERE event_id=?1", [id]);
            if kind == "whatsapp" {
                whatsapp_refused(&db, &asset_id, &e.1)?;
            }
            return Err(e);
        }
    };
    // Meta's id for the sent message, so a later delivery failure can be matched to this reply.
    let message_id = [&sent["messages"][0]["id"], &sent["message_id"], &sent["id"]].into_iter().find_map(|v| v.as_str());
    lock(&s.db).execute("UPDATE replies SET message_id=?2 WHERE event_id=?1", params![id, message_id])?;
    Ok(())
}

pub struct Event {
    pub kind: String,
    pub asset_id: String,
    pub sender: String,
    pub sender_name: String,
    pub text: String,
    pub dedupe: String,
    /// A voice note, photo or video waiting to be put into words: `wa:<media id>` or `url:<attachment url>`,
    /// after `photo:` or `video:` for those.
    pub media: Option<String>,
    /// The owner's post an Instagram comment is on.
    pub post_id: Option<String>,
}

/// One log line about a webhook's shape: per change its field, business number id and how many messages and
/// statuses (with their values). Never message text, customer numbers or tokens.
pub fn webhook_summary(payload: &Value) -> String {
    let changes: Vec<String> = payload["entry"].as_array().into_iter().flatten().flat_map(|entry| {
        let messaging = entry["messaging"].as_array().map(|m| format!("messaging={}", m.len()));
        entry["changes"].as_array().into_iter().flatten().map(|c| {
            let v = &c["value"];
            let statuses: Vec<&str> = v["statuses"].as_array().into_iter().flatten().filter_map(|s| s["status"].as_str()).collect();
            format!("field={} phone_number_id={} messages={} statuses={} [{}]", c["field"].as_str().unwrap_or("-"), v["metadata"]["phone_number_id"].as_str().unwrap_or("-"),
                v["messages"].as_array().map_or(0, Vec::len), v["statuses"].as_array().map_or(0, Vec::len), statuses.join(","))
        }).chain(messaging).collect::<Vec<_>>()
    }).collect();
    format!("object={} {}", payload["object"].as_str().unwrap_or("-"), if changes.is_empty() { "no changes".into() } else { changes.join("; ") })
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
                    // A photo or video may carry a caption, which stays as the text.
                    let kind = clip(&m["type"]);
                    let text = Some(clip(&m["text"]["body"])).filter(|t| !t.is_empty()).unwrap_or_else(|| clip(&m[kind.as_str()]["caption"]));
                    let prefix = match kind.as_str() { "audio" => Some(""), "image" => Some("photo:"), "video" => Some("video:"), _ => None };
                    let media = prefix.zip(Some(clip(&m[kind.as_str()]["id"])).filter(|id| !id.is_empty())).map(|(p, id)| format!("{p}wa:{id}"));
                    if !text.is_empty() || media.is_some() {
                        let sender = clip(&m["from"]);
                        let sender_name = contacts.iter().find(|c| clip(&c["wa_id"]) == sender).map(|c| clip(&c["profile"]["name"])).unwrap_or_default();
                        out.push(Event { kind: "whatsapp".into(), asset_id: phone.clone(), sender, sender_name, text, dedupe: format!("wa:{}", clip(&m["id"])), media, post_id: None });
                    }
                }
            } else if object == "instagram" && change["field"] == "comments" && clip(&v["from"]["id"]) != entry_id {
                // The account's own comments, such as a reply sent from Stupid, are not someone writing in.
                let sender = Some(clip(&v["from"]["username"])).filter(|s| !s.is_empty()).unwrap_or_else(|| clip(&v["from"]["id"]));
                out.push(Event { kind: "instagram_comment".into(), asset_id: entry_id.clone(), sender_name: clip(&v["from"]["username"]), sender, text: clip(&v["text"]), dedupe: format!("igc:{}", clip(&v["id"])), media: None,
                    post_id: Some(clip(&v["media"]["id"])).filter(|m| numeric(m)) });
            }
        }
        // Instagram DMs come as `messaging`, or as a `messages` change (Meta's dashboard test, Instagram Login), same shape.
        let as_changes = entry["changes"].as_array().into_iter().flatten().filter(|c| object == "instagram" && c["field"] == "messages").map(|c| &c["value"]);
        for m in entry["messaging"].as_array().into_iter().flatten().chain(as_changes) {
            let message = &m["message"];
            let kinds: Vec<&str> = message["attachments"].as_array().into_iter().flatten().filter_map(|x| x["type"].as_str()).collect();
            let notes: Vec<&str> = std::iter::once((message["reply_to"]["story"].is_object(), STORY_REPLY))
                .chain(kinds.iter().map(|k| (true, match *k { "story_mention" => STORY_MENTION, "share" | "ig_post" => SHARED_POST, "ig_reel" | "reel" => SHARED_REEL, _ => "" })))
                .filter(|(on, n)| *on && !n.is_empty()).map(|(_, n)| n).collect();
            let text = with_notes(&notes, &clip(&message["text"]));
            let media = message["attachments"].as_array().into_iter().flatten().find_map(|x| {
                let prefix = match x["type"].as_str()? { "audio" => "", "image" => "photo:", "video" => "video:", _ => return None };
                Some(clip(&x["payload"]["url"])).filter(|u| !u.is_empty()).map(|u| format!("{prefix}url:{u}"))
            });
            if (text.is_empty() && media.is_none()) || message["is_echo"].as_bool() == Some(true) {
                continue;
            }
            let kind = if object == "instagram" { "instagram" } else { "messenger" };
            out.push(Event { kind: kind.into(), asset_id: entry_id.clone(), sender: clip(&m["sender"]["id"]), sender_name: String::new(), text, dedupe: format!("{kind}:{}", clip(&message["mid"])), media, post_id: None });
        }
    }
    out
}

/// Webhook DMs carry only the person's id; Graph gives their @handle or name, so the Inbox says who wrote.
pub async fn name_senders(s: &AppState, ids: &[i64]) {
    for id in ids {
        let found = lock(&s.db).query_row(
            "SELECT kind,asset_id,sender FROM events WHERE id=?1 AND IFNULL(sender_name,'')='' AND kind IN ('instagram','messenger')", [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).optional();
        let Ok(Some((kind, asset, sender))) = found else { continue };
        let owner = crate::tickets::owners(&lock(&s.db), &asset).ok().and_then(|o| o.into_iter().next());
        let (Some(u), true) = (owner.and_then(|o| crate::user_by_id(s, &o).ok()), numeric(&sender)) else { continue };
        let Ok(t) = tokens(s, &u) else { continue };
        let fields = if kind == "instagram" { "username,name" } else { "name" };
        match get(s, &sender, &[("fields", fields.into())], t.for_asset(&format!("{kind}:{asset}"))).await {
            Ok(p) => if let Some(name) = p["username"].as_str().or(p["name"].as_str()) {
                let _ = lock(&s.db).execute("UPDATE events SET sender_name=?2 WHERE id=?1", params![id, name.chars().take(200).collect::<String>()]);
            },
            Err(e) => tracing::warn!(event = id, "sender name: {}", e.1),
        }
    }
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
    fn inbox_rows_carry_the_newest_draft_for_this_person() {
        let (s, u) = crate::tests_support::state_with_user();
        {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (id,kind,asset_id,sender,text,created) VALUES (1,'whatsapp','p1','91','price?',1),(2,'whatsapp','p1','92','hi',2)", []).unwrap();
            db.execute("INSERT INTO drafts (user_id,event_id,text,source,created) VALUES ('u',1,'old','agent',1),('u',1,'It is 450.','muse',2),('someone',2,'not yours','muse',3)", []).unwrap();
            db.execute("INSERT INTO replies (event_id,user_id,text,created) VALUES (2,'u','Hello!',3)", []).unwrap();
        }
        let rows = inbox_rows(&s, &u).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0]["replied"].clone(), rows[0]["reply_text"].clone(), rows[1]["reply_text"].clone()), (json!(true), json!("Hello!"), Value::Null), "a replied thread shows what was sent");
        assert_eq!(rows[1]["draft"], json!({ "text": "It is 450.", "source": "muse", "models": {}, "styled": false, "used": null }), "Muse over MCP: its model is not known");
        assert_eq!(rows[0]["draft"], Value::Null, "another person's draft stays theirs");
        assert_eq!((rows[1]["photo"].clone(), rows[1]["voice"].clone()), (json!(false), json!(false)));
    }

    #[tokio::test]
    async fn skipping_a_message_files_it_away_without_sending() {
        let (s, _) = crate::tests_support::state_with_user();
        let h = crate::tests_support::signed_in(&s);
        {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (id,kind,asset_id,sender,text,created) VALUES (1,'whatsapp','p1','91','price?',?1),(2,'whatsapp','elsewhere','92','hi',?1)", [now()]).unwrap();
            db.execute("INSERT INTO drafts (user_id,event_id,text,source,created) VALUES ('u',1,'It is 450.','agent',?1)", [now()]).unwrap();
        }
        let Json(home) = crate::attention::home(State(s.clone()), h.clone()).await.unwrap();
        assert_eq!(home["needs"].as_array().unwrap().len(), 1);
        assert!(skip(State(s.clone()), h.clone(), Path(2)).await.is_err_and(|e| e.0 == 404), "someone else's message can't be skipped");
        let _ = skip(State(s.clone()), h.clone(), Path(1)).await.unwrap();
        let _ = skip(State(s.clone()), h.clone(), Path(1)).await.unwrap();
        let Json(home) = crate::attention::home(State(s.clone()), h.clone()).await.unwrap();
        assert!(home["needs"].as_array().unwrap().is_empty(), "the skipped draft left Needs you");
        let u = crate::user(&s, &h).unwrap();
        assert_eq!(inbox_rows(&s, &u).unwrap()[0]["skipped"], json!(true));
        assert_eq!(lock(&s.db).query_row("SELECT COUNT(*) FROM replies", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "nothing was sent");
    }

    #[test]
    fn inbox_rows_trace_how_a_draft_was_made() {
        let (s, u) = crate::tests_support::state_with_user();
        {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (id,kind,asset_id,sender,text,created,media) VALUES (1,'whatsapp','p1','91','',1,'wa:7'),(2,'whatsapp','p1','92','Blue?',2,'photo:wa:8'),(3,'whatsapp','p1','93','',3,'photo:wa:9')", []).unwrap();
            crate::voice::store(&db, 1, crate::voice::Media::Voice, Ok(("Do you deliver to Pune?".into(), crate::meta_ai::VOICE.into()))).unwrap();
            crate::voice::store(&db, 2, crate::voice::Media::Photo, Ok(("A blue tote bag.".into(), "meta-models/muse-spark-open-1026".into()))).unwrap();
            db.execute("INSERT INTO learned (id,user_id,question,answer,created) VALUES (4,'u','Do you deliver to Pune?','Yes, in 2 days',1762214400)", []).unwrap();
            db.execute("INSERT INTO drafts (user_id,ticket_id,event_id,text,source,created,learned_id) VALUES ('u',5,1,'Yes, in 2 days!','agent',4,4),('u',6,2,'Yes, in blue.','agent',5,NULL)", []).unwrap();
            crate::tools::drafted_by(&db, 5, "meta-models/muse-spark-open-1026").unwrap();
            crate::tools::drafted_by(&db, 5, "muse-spark-1.3").unwrap();
            crate::style::mark(&db, 5).unwrap();
        }
        let rows = inbox_rows(&s, &u).unwrap();
        let (pending, photo, voice) = (&rows[0], &rows[1], &rows[2]);
        assert_eq!((voice["voice"].clone(), voice["photo"].clone()), (json!(true), json!(false)));
        assert_eq!(voice["draft"], json!({ "text": "Yes, in 2 days!", "source": "agent", "styled": true, "used": { "answer": "Yes, in 2 days", "told": 1762214400 },
            "models": { "described_by": "muse-voice-transcribe-1.0", "drafted_by": "meta-models/muse-spark-open-1026" } }), "the first model to write keeps the draft");
        assert_eq!((photo["photo"].clone(), photo["voice"].clone()), (json!(true), json!(false)));
        assert_eq!(photo["draft"]["models"], json!({ "described_by": "meta-models/muse-spark-open-1026" }), "a draft not yet named has no drafted_by");
        assert_eq!((pending["photo"].clone(), pending["transcribing"].clone(), pending["draft"].clone()), (json!(true), json!("photo"), Value::Null), "a photo still being looked at");
    }

    #[test]
    fn webhook_summary_says_the_shape_and_nothing_private() {
        let wa = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55","display_phone_number":"15550001234"},
            "contacts":[{"wa_id":"919812345678","profile":{"name":"Asha"}}],"messages":[{"id":"m1","from":"919812345678","text":{"body":"secret price?"}}],
            "statuses":[{"id":"w1","status":"failed","recipient_id":"919800000000"},{"id":"w2","status":"delivered","recipient_id":"919800000000"}]}}]}]});
        let line = webhook_summary(&wa);
        assert_eq!(line, "object=whatsapp_business_account field=messages phone_number_id=55 messages=1 statuses=2 [failed,delivered]");
        for private in ["secret", "9198", "Asha", "access_token"] {
            assert!(!line.contains(private), "{line}");
        }
        let ig = json!({"object":"instagram","entry":[{"id":"77","messaging":[{"sender":{"id":"9"},"message":{"mid":"x","text":"hi"}}]}]});
        assert_eq!(webhook_summary(&ig), "object=instagram messaging=1");
        assert_eq!(webhook_summary(&json!({})), "object=- no changes");
    }

    #[test]
    fn webhook_shapes() {
        let wa = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55"},"contacts":[{"wa_id":"91","profile":{"name":"Asha"}}],"messages":[{"id":"m1","from":"91","text":{"body":"price?"}}]}}]}]});
        let e = parse_webhook(&wa);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str(), e[0].text.as_str(), e[0].sender_name.as_str()), ("whatsapp", "55", "price?", "Asha"));
        let ig = json!({"object":"instagram","entry":[{"id":"77","messaging":[{"sender":{"id":"9"},"message":{"mid":"x","text":"hi"}},{"sender":{"id":"77"},"message":{"mid":"y","text":"echo","is_echo":true}}]}]});
        let e = parse_webhook(&ig);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str()), ("instagram", "77"));
        // Meta's documented comment shape, and the account's own reply under it, which is not someone writing in.
        let comments = json!({"object":"instagram","entry":[{"id":"77","time":1730700000,"changes":[
            {"field":"comments","value":{"from":{"id":"232323232","username":"brandco"},"media":{"id":"123","media_product_type":"REELS"},"id":"17865799348089039","text":"Love this! DM us about a paid collab?"}},
            {"field":"comments","value":{"from":{"id":"77","username":"me"},"media":{"id":"123"},"id":"17865799348089040","parent_id":"17865799348089039","text":"Thanks!"}}]}]});
        let e = parse_webhook(&comments);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].kind.as_str(), e[0].asset_id.as_str(), e[0].sender.as_str(), e[0].dedupe.as_str()), ("instagram_comment", "77", "brandco", "igc:17865799348089039"));
        assert_eq!(e[0].post_id.as_deref(), Some("123"), "the post it is on, for its picture in the Inbox");
        // Story replies, shared posts and Reels, and story mentions, as Meta's Instagram messaging webhook sends them.
        let dms = json!({"object":"instagram","entry":[{"id":"77","messaging":[
            {"sender":{"id":"9"},"message":{"mid":"s1","text":"so pretty!","reply_to":{"story":{"url":"https://lookaside/s","id":"55"}}}},
            {"sender":{"id":"9"},"message":{"mid":"s2","attachments":[{"type":"share","payload":{"url":"https://lookaside/p"}}]}},
            {"sender":{"id":"9"},"message":{"mid":"s3","attachments":[{"type":"ig_reel","payload":{"reel_video_id":"1","title":"t","url":"https://lookaside/r"}}],"text":"look"}},
            {"sender":{"id":"9"},"message":{"mid":"s4","attachments":[{"type":"story_mention","payload":{"url":"https://lookaside/m"}}]}},
            {"sender":{"id":"9"},"message":{"mid":"s5","attachments":[{"type":"audio","payload":{"url":"https://lookaside/v.mp4"}}]}}]}]});
        let e = parse_webhook(&dms);
        let said: Vec<&str> = e.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(said, ["(Replied to your story) so pretty!", "(Shared a post)", "(Shared a Reel) look", "(Mentioned you in their story)", ""]);
        assert_eq!(e[4].media.as_deref(), Some("url:https://lookaside/v.mp4"), "a voice note goes to transcription");
        assert!(!said.concat().contains("lookaside"));
        // A DM as a `messages` change, as Meta's dashboard test and Instagram Login send it.
        let changed = json!({"object":"instagram","entry":[{"id":"77","time":1730700000,"changes":[{"field":"messages","value":{"sender":{"id":"12334"},"recipient":{"id":"77"},"timestamp":"1527459824","message":{"mid":"random_mid","text":"random_text"}}}]}]});
        let e = parse_webhook(&changed);
        assert_eq!((e.len(), e[0].kind.as_str(), e[0].sender.as_str(), e[0].dedupe.as_str()), (1, "instagram", "12334", "instagram:random_mid"));
        assert!(parse_webhook(&json!({"object":"page","entry":[{"id":"5","changes":[{"field":"messages","value":{"sender":{"id":"1"},"message":{"mid":"m","text":"t"}}}]}]})).is_empty(), "only Instagram sends DMs as changes");
        assert!(numeric("act_123") && !numeric("act_") && !numeric("12a"));
        let voice = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55"},"messages":[{"id":"m2","from":"91","type":"audio","audio":{"id":"777","mime_type":"audio/ogg; codecs=opus","voice":true}}]}}]}]});
        let e = parse_webhook(&voice);
        assert_eq!((e[0].text.as_str(), e[0].media.as_deref()), ("", Some("wa:777")));
        let dm = json!({"object":"page","entry":[{"id":"5","messaging":[{"sender":{"id":"9"},"message":{"mid":"z","attachments":[{"type":"audio","payload":{"url":"https://cdn.example/a.mp4"}}]}}]}]});
        assert_eq!(parse_webhook(&dm)[0].media.as_deref(), Some("url:https://cdn.example/a.mp4"));
        let photo = json!({"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"55"},"messages":[{"id":"m3","from":"91","type":"image","image":{"id":"888","mime_type":"image/jpeg","caption":"this one in blue?"}},{"id":"m4","from":"91","type":"video","video":{"id":"999"}},{"id":"m5","from":"91","type":"sticker","sticker":{"id":"1"}}]}}]}]});
        let e = parse_webhook(&photo);
        assert_eq!(e.len(), 2, "a sticker alone is not a message to answer");
        assert_eq!((e[0].text.as_str(), e[0].media.as_deref()), ("this one in blue?", Some("photo:wa:888")));
        assert_eq!(e[1].media.as_deref(), Some("video:wa:999"));
        let dm = json!({"object":"instagram","entry":[{"id":"5","messaging":[{"sender":{"id":"9"},"message":{"mid":"p","attachments":[{"type":"image","payload":{"url":"https://cdn.example/p.jpg"}}]}}]}]});
        assert_eq!(parse_webhook(&dm)[0].media.as_deref(), Some("photo:url:https://cdn.example/p.jpg"));
        let st = json!({"entry":[{"changes":[{"value":{"statuses":[{"status":"delivered"},{"status":"failed","id":"wamid.1","recipient_id":"91","errors":[{"code":131031,"title":"Business Account locked","error_data":{"details":"Business account has been locked."}}]}]}}]}]});
        assert_eq!(failed_sends(&st), vec![("wamid.1".to_string(), "Business account has been locked. (131031)".to_string())]);
    }

    #[test]
    fn whatsapp_health_in_plain_words() {
        let health = json!({"can_send_message":"BLOCKED","entities":[
            {"entity_type":"PHONE_NUMBER","can_send_message":"AVAILABLE","errors":[{"error_code":138024,"error_description":"SIP"}]},
            {"entity_type":"WABA","can_send_message":"BLOCKED","errors":[{"error_code":141006,"error_description":"payment"}]},
            {"entity_type":"BUSINESS","can_send_message":"LIMITED","errors":[{"error_code":141010},{"error_code":999,"error_description":"Odd","possible_solution":"Do X"}]}]});
        let issues = whatsapp_issues(&health, "7", "8");
        assert_eq!(issues.len(), 3);
        assert!(!issues[0].blocking && issues[0].link.contains("business_id=7&asset_id=8"), "no payment method only stops templates");
        assert!(issues.iter().all(|i| !i.blocking), "a number that replies isn't shown as restricted: {issues:?}");
        assert!(!issues[1].blocking && issues[1].text.contains("verified"));
        assert_eq!((issues[2].text.as_str(), issues[2].fix.as_str()), ("Odd", "Do X"));
        assert!(whatsapp_issues(&Value::Null, "7", "8").is_empty());
    }

    #[test]
    fn a_restricted_business_points_to_verification() {
        let issues = whatsapp_issues(&json!({"entities":[{"entity_type":"BUSINESS","can_send_message":"BLOCKED","errors":[{"error_code":131031}]}]}), "7", "8");
        assert_eq!(issues.len(), 1);
        assert!(issues[0].blocking && issues[0].text.contains("restricted"));
        assert!(issues[0].fix.contains("verify your business"));
        assert_eq!(issues[0].link, "https://business.facebook.com/latest/settings/security_center?business_id=7");
    }

    #[test]
    fn a_verified_business_has_nothing_blocking() {
        let health = json!({"can_send_message":"AVAILABLE","entities":[
            {"entity_type":"PHONE_NUMBER","id":"1","can_send_message":"AVAILABLE"},
            {"entity_type":"WABA","id":"2","can_send_message":"AVAILABLE"},
            {"entity_type":"BUSINESS","id":"7","can_send_message":"AVAILABLE"},
            {"entity_type":"APP","id":"3","can_send_message":"AVAILABLE"}]});
        assert!(whatsapp_issues(&health, "7", "8").is_empty());
        // No refusal kept either: the number shows exactly what the health check says.
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE wa_blocks (asset_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);").unwrap();
        let mut assets = vec![Asset { key: "whatsapp:1".into(), kind: "whatsapp".into(), id: "1".into(), name: "n".into(), issues: Vec::new(), business: Some("7".into()) }];
        add_refusals(&db, &mut assets).unwrap();
        assert!(assets[0].issues.is_empty());
        whatsapp_sent(&db, "1", Some(("Business account has been locked. (131031)", 131031))).unwrap();
        whatsapp_sent(&db, "1", Some(("Message undeliverable. (131026)", 131026))).unwrap();
        add_refusals(&db, &mut assets).unwrap();
        assert_eq!((assets[0].issues.len(), assets[0].issues[0].link.as_str()), (1, "https://business.facebook.com/latest/settings/security_center?business_id=7"));
        whatsapp_sent(&db, "1", None).unwrap();
        assert!(!whatsapp_blocked(&db, "1").unwrap(), "a sent message clears it");
    }

    #[test]
    fn whatsapp_billing_errors_explain_what_to_check() {
        let issues = whatsapp_issues(&json!({"entities":[{"can_send_message":"BLOCKED","errors":[{"error_code":131042}]}]}), "7", "8");
        assert!(issues[0].fix.contains("currency and time zone"));
        assert!(issues[0].link.ends_with("/payment_methods/"));
    }

    #[test]
    fn whatsapp_registration_errors_link_to_registration() {
        for code in [131045, 133010] {
            let issues = whatsapp_issues(&json!({"entities":[{"can_send_message":"BLOCKED","errors":[{"error_code":code}]}]}), "7", "8");
            assert!(issues[0].text.contains("isn't registered"));
            assert!(issues[0].link.ends_with("/registration"));
        }
    }

    #[test]
    fn blocked_health_without_error_details_is_never_ready() {
        for health in [json!({"can_send_message":"BLOCKED"}), json!({"entities":[{"can_send_message":"BLOCKED"}]})] {
            let issues = whatsapp_issues(&health, "7", "8");
            assert_eq!(issues.len(), 1);
            assert!(issues[0].blocking && issues[0].fix.contains("hasn't shared"));
        }
        assert!(whatsapp_issues(&json!({"can_send_message":"AVAILABLE"}), "7", "8").is_empty());
    }

    #[test]
    fn an_old_broken_number_does_not_block_the_working_one() {
        let issue = |blocking| Issue { blocking, text: "Not registered".into(), fix: "x".into(), link: "x".into() };
        let number = |id: &str, issues: Vec<Issue>| Asset { key: format!("whatsapp:{id}"), kind: "whatsapp".into(), id: id.into(), name: id.into(), issues, business: None };
        let on = vec!["whatsapp:old".to_string(), "whatsapp:new".to_string()];
        let mut assets = vec![number("old", vec![issue(true)]), number("new", vec![])];
        judge_numbers(&mut assets, &on, None);
        assert!(!assets[0].issues[0].blocking, "the healthy number is judged when nobody is paired");
        let mut assets = vec![number("old", vec![issue(true)]), number("new", vec![issue(true)])];
        judge_numbers(&mut assets, &on, Some("new"));
        assert!(!assets[0].issues[0].blocking && assets[1].issues[0].blocking, "the paired number is judged, even when broken");
        let mut one = vec![number("old", vec![issue(true)])];
        judge_numbers(&mut one, &on[..1], None);
        assert!(one[0].issues[0].blocking, "a single broken number still says so");
    }

    #[test]
    fn whatsapp_setup_never_promises_free_production_replies() {
        let issues = whatsapp_issues(&json!({"entities":[{"can_send_message":"BLOCKED","errors":[{"error_code":141006},{"error_code":141010}]}]}), "7", "8");
        assert!(issues[0].fix.contains("charged"));
        assert!(!issues[1].fix.contains("Replies still work"));
        assert!(issues[1].blocking);
    }

    #[test]
    fn disabled_ads_offer_a_review() {
        let issues = ad_account_issues(&json!({"account_status":2}));
        assert!(issues[0].blocking && issues[0].fix.contains("Request review"));
    }

    #[test]
    fn unsettled_ads_offer_billing() {
        let issues = ad_account_issues(&json!({"account_status":3}));
        assert!(issues[0].text.contains("unpaid balance"));
        assert!(issues[0].link.ends_with("/payment_methods/"));
    }

    #[test]
    fn pending_ads_explain_review() {
        for status in [7, 8, 9] {
            assert!(ad_account_issues(&json!({"account_status":status}))[0].text.contains("reviewing"));
        }
    }

    #[test]
    fn closed_ads_offer_another_account() {
        for status in [100, 101] {
            assert!(ad_account_issues(&json!({"account_status":status}))[0].fix.contains("another ad account"));
        }
        for account in [Value::Null, json!({"account_status":1})] {
            assert!(ad_account_issues(&account).is_empty());
        }
    }

    #[test]
    fn page_without_messaging_access_needs_the_owner() {
        let issues = page_issues(&json!({"tasks":["ANALYZE"]}));
        assert!(issues[0].blocking && issues[0].fix.contains("full control"));
        for page in [json!({"tasks":["MESSAGING"]}), json!({"tasks":["MANAGE"]}), Value::Null] {
            assert!(page_issues(&page).is_empty());
        }
    }

    #[test]
    fn a_page_without_a_professional_instagram_says_how_to_link_one() {
        let issues = instagram_issues(&json!({ "id": "1", "tasks": ["MANAGE"] }));
        assert_eq!(issues.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), [NOT_PROFESSIONAL, NO_INSTAGRAM]);
        assert!(issues.iter().all(|i| !i.blocking));
        assert_eq!(issues[0].link, "https://help.instagram.com/502981923235522");
        assert_eq!(issues[1].link, "https://www.facebook.com/business/help/898752960195806");
        assert!(instagram_issues(&json!({ "instagram_business_account": { "id": "9", "username": "me" } })).is_empty());
    }

    #[test]
    fn graph_errors_keep_the_code_for_delivery_help() {
        let error = graph_error(&json!({"error":{"code":131031,"message":"Business Account locked"}}));
        assert!(error.1.contains("(131031)"));
        assert_eq!(graph_error(&json!({"error":{"code":190}})).1, "Meta access expired. Connect again.");
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
    fn instagram_links_never_reach_the_browser() {
        let ig = json!({ "accounts": [{ "profile": { "username": "me", "profile_picture_url": "https://cdn/p.jpg" }, "media": [
            { "id": "1", "media_type": "VIDEO", "media_url": "https://cdn/v.mp4", "thumbnail_url": "https://cdn/v.jpg", "permalink": "https://www.instagram.com/reel/x/" },
            { "id": "2", "media_type": "VIDEO", "permalink": "https://www.instagram.com/reel/y/" }] }] });
        let out = for_browser(ig);
        assert!(!out.to_string().contains("cdn/"), "{out}");
        assert_eq!(out["accounts"][0]["media"][0]["picture"], "/api/instagram/media/1/image");
        assert!(out["accounts"][0]["media"][1].get("picture").is_none(), "no picture to show");
        assert_eq!(out["accounts"][0]["media"][0]["permalink"], "https://www.instagram.com/reel/x/");
    }

    #[test]
    fn graph_times() {
        assert_eq!(graph_time("1970-01-01T00:00:00+0000"), Some(0));
        assert_eq!(graph_time("2026-11-03T07:00:00+0000"), Some(1_793_689_200));
        assert_eq!(graph_time("2024-02-29T12:30:15+0000"), Some(1_709_209_815));
        assert_eq!(graph_time("garbage"), None);
    }
}
