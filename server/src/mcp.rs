//! Stupid as an MCP server for Muse custom connectors: JSON-RPC 2.0 over streamable HTTP, one JSON answer per
//! request, behind a Bearer access key the person creates in Settings. It exposes the agent's own tool registry,
//! read and prepare only. Muse can queue a reply draft or start a job; it can never send, post or spend.
use crate::{agents, digest, lock, now, random_token, tickets, tools, user, user_by_id, ApiResult, AppError, AppState, User};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Registry tools Muse may read with.
const READS: &[&str] = &["get_today", "list_inbox", "read_thread", "list_leads", "list_drafts", "get_ad_advice"];
const QUEUED: &str = "Queued in Stupid. Tap Send in Stupid's Inbox to deliver.";

fn unauthorized(why: &str) -> Response {
    let mut res = (StatusCode::UNAUTHORIZED, Json(json!({ "error": why }))).into_response();
    res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"Stupid\""));
    res
}

/// The person a Bearer key belongs to, if the key is live. Marks it used.
fn key_owner(s: &AppState, headers: &HeaderMap) -> Option<String> {
    let key = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?.trim();
    let db = lock(&s.db);
    let owner: String = db.query_row("SELECT user_id FROM access_keys WHERE hash=?1 AND revoked IS NULL", [digest(key)], |r| r.get(0)).optional().ok()??;
    let _ = db.execute("UPDATE access_keys SET last_used=?2 WHERE hash=?1", params![digest(key), now()]);
    Some(owner)
}

/// Every tool Muse sees, in MCP's shape.
fn tool_list() -> Vec<Value> {
    let mut list: Vec<Value> = tools::specs().into_iter().map(|t| t["function"].clone())
        .filter(|f| f["name"].as_str().is_some_and(|n| READS.contains(&n)))
        .map(|f| json!({ "name": f["name"], "description": f["description"], "inputSchema": f["parameters"], "annotations": { "readOnlyHint": true } }))
        .collect();
    list.push(json!({ "name": "queue_reply_draft", "annotations": { "readOnlyHint": false, "destructiveHint": false },
        "description": "Queue a reply draft for one inbox message (an id from list_inbox). It is not sent: the owner checks it and taps Send in Stupid's Inbox.",
        "inputSchema": { "type": "object", "properties": { "item_id": { "type": "integer" }, "text": { "type": "string", "description": "The reply, at most 1000 characters." } }, "required": ["item_id", "text"] } }));
    list.push(json!({ "name": "run_agent", "annotations": { "readOnlyHint": false, "destructiveHint": false },
        "description": "Start one of Stupid's jobs: leads, ideas, reels, replies or ads. Same daily limit and spend cap as in Stupid; results show in Stupid.",
        "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "enum": ["leads", "ideas", "reels", "replies", "ads"] } }, "required": ["name"] } }));
    list
}

async fn call_tool(s: &AppState, u: User, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "queue_reply_draft" => {
            let id = args["item_id"].as_i64().ok_or("`item_id` must be a number.")?;
            let text = args["text"].as_str().map(str::trim).filter(|t| !t.is_empty() && t.chars().count() <= 1000).ok_or("`text` must be 1 to 1000 characters.")?;
            let ticket = {
                let db = lock(&s.db);
                tickets::open_explicit(&db, &u.id, &format!("muse:{id}"), "mcp", &format!("mcp:{}", random_token()), Some(id), "replies").map_err(|_| "Storage failed.".to_string())?
            };
            let saved = tools::save_draft(s, &u, Some(ticket), id, text, "muse");
            let (kind, report) = match &saved { Ok(()) => ("ready", "Muse queued a reply draft."), Err(_) => ("failed", "Muse's draft was for a message that isn't in this inbox.") };
            tickets::close_job(&lock(&s.db), ticket, kind, report).map_err(|_| "Storage failed.".to_string())?;
            saved.map(|()| json!({ "queued": true, "message": QUEUED }))
        }
        "run_agent" => {
            let job = args["name"].as_str().ok_or("`name` is required.")?;
            agents::start(s, u, job).await.map_err(|e| e.1).map(|v| json!({ "status": v["status"], "message": "Started. The result shows in Stupid's Agents screen." }))
        }
        _ if READS.contains(&name) => tools::call(s, &u, None, name, args).await,
        _ => Err(format!("Stupid has no tool called {name}.")),
    }
}

fn answer(id: &Value, result: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}
fn failure(id: &Value, code: i64, message: &str) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).into_response()
}

/// `POST /mcp`. Only a Bearer key opens it; cookies are ignored, so a web page can't ride a signed-in session.
pub async fn handle(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(owner) = key_owner(&s, &headers) else { return unauthorized("Create an access key in Stupid's Settings, then send it as a Bearer token.") };
    let Ok(request) = serde_json::from_slice::<Value>(&body) else { return failure(&Value::Null, -32700, "Parse error.") };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request["method"].as_str().unwrap_or_default();
    // A notification (no id) gets no answer.
    if request.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    match method {
        "initialize" => {
            let asked = request["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            answer(&id, json!({ "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "stupid", "title": "Stupid", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Stupid is a creator's Meta inbox and agent. Read with the list and get tools. queue_reply_draft only queues a draft: nothing reaches a customer until the owner taps Send in Stupid." }))
        }
        "ping" => answer(&id, json!({})),
        "tools/list" => answer(&id, json!({ "tools": tool_list() })),
        "tools/call" => {
            let u = match user_by_id(&s, &owner) { Ok(u) => u, Err(e) => return failure(&id, -32001, &e.1) };
            let name = request["params"]["name"].as_str().unwrap_or_default();
            let args = request["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            tracing::info!(tool = name, user = owner, "mcp call");
            match call_tool(&s, u, name, &args).await {
                Ok(v) => answer(&id, json!({ "content": [{ "type": "text", "text": v.to_string() }], "structuredContent": v, "isError": false })),
                Err(e) => answer(&id, json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        _ => failure(&id, -32601, "Method not found."),
    }
}

// ---------- the person's access key, from Settings ----------

/// Whether a key is live, when it was made and last used, and the URL to give Muse.
pub async fn key_status(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let found: Option<(i64, Option<i64>)> = lock(&s.db).query_row("SELECT created,last_used FROM access_keys WHERE user_id=?1 AND revoked IS NULL", [&u.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let url = format!("{}/mcp", s.cfg.public_url.trim_end_matches('/'));
    Ok(Json(json!({ "has_key": found.is_some(), "created": found.map(|f| f.0), "last_used": found.and_then(|f| f.1), "url": url })))
}

/// Make a new key, shown once. Any older key stops working.
pub async fn create_key(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let key = format!("stupid_{}", random_token());
    let db = lock(&s.db);
    db.execute("UPDATE access_keys SET revoked=?2 WHERE user_id=?1 AND revoked IS NULL", params![u.id, now()])?;
    db.execute("INSERT INTO access_keys (user_id,hash,created) VALUES (?1,?2,?3)", params![u.id, digest(&key), now()])?;
    Ok(Json(json!({ "key": key, "created": now() })))
}

pub async fn revoke_key(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let n = lock(&s.db).execute("UPDATE access_keys SET revoked=?2 WHERE user_id=?1 AND revoked IS NULL", params![u.id, now()])?;
    if n == 0 {
        return Err(AppError::new(404, "There is no key to revoke."));
    }
    Ok(Json(json!({ "has_key": false })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{signed_in, state_with_user};

    fn bearer(key: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {key}")).unwrap());
        h
    }
    async fn rpc(s: &AppState, h: HeaderMap, body: Value) -> (StatusCode, Value) {
        let res = handle(State(s.clone()), h, Bytes::from(body.to_string())).await;
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    async fn new_key(s: &AppState) -> String {
        let Json(made) = create_key(State(s.clone()), signed_in(s)).await.unwrap();
        made["key"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn without_a_live_key_it_answers_401() {
        let (s, _) = state_with_user();
        let res = handle(State(s.clone()), HeaderMap::new(), Bytes::from_static(b"{}")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(res.headers()[header::WWW_AUTHENTICATE], "Bearer realm=\"Stupid\"");
        let (status, _) = rpc(&s, bearer("stupid_wrong"), json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn it_lists_read_and_prepare_tools_only() {
        let (s, _) = state_with_user();
        let key = new_key(&s).await;
        let (_, init) = rpc(&s, bearer(&key), json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await;
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        let (_, list) = rpc(&s, bearer(&key), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_today", "list_inbox", "read_thread", "list_leads", "get_ad_advice", "list_drafts", "queue_reply_draft", "run_agent"]);
        assert!(names.iter().all(|n| !n.contains("send") && !n.contains("post") && !n.starts_with("save_")));
        let (status, _) = rpc(&s, bearer(&key), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn queue_reply_draft_stores_a_draft_and_sends_nothing() {
        let (s, _) = state_with_user();
        let key = new_key(&s).await;
        lock(&s.db).execute("INSERT INTO events (id,kind,asset_id,sender,text,created) VALUES (5,'whatsapp','p1','91','price?',?1)", [now()]).unwrap();
        let call = |id: i64| json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "queue_reply_draft", "arguments": { "item_id": id, "text": "It's ₹450." } } });
        let (_, done) = rpc(&s, bearer(&key), call(5)).await;
        assert_eq!(done["result"]["isError"], false);
        assert_eq!(done["result"]["structuredContent"]["message"], QUEUED);
        let (_, other) = rpc(&s, bearer(&key), call(99)).await;
        assert_eq!(other["result"]["isError"], true, "only this inbox's messages");
        let db = lock(&s.db);
        let (text, source): (String, String) = db.query_row("SELECT text,source FROM drafts WHERE event_id=5", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((text.as_str(), source.as_str()), ("It's ₹450.", "muse"));
        let replies: i64 = db.query_row("SELECT COUNT(*) FROM replies", [], |r| r.get(0)).unwrap();
        assert_eq!(replies, 0);
        let reports: Vec<String> = db.prepare("SELECT kind FROM reports ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(reports, ["progress", "ready", "progress", "failed"]);
    }

    #[tokio::test]
    async fn a_revoked_or_replaced_key_is_refused() {
        let (s, _) = state_with_user();
        let first = new_key(&s).await;
        let second = new_key(&s).await;
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        assert_eq!(rpc(&s, bearer(&first), ping.clone()).await.0, StatusCode::UNAUTHORIZED, "a new key replaces the old one");
        assert_eq!(rpc(&s, bearer(&second), ping.clone()).await.0, StatusCode::OK);
        let Json(status) = key_status(State(s.clone()), signed_in(&s)).await.unwrap();
        assert!(status["last_used"].is_number());
        let _ = revoke_key(State(s.clone()), signed_in(&s)).await.unwrap();
        assert_eq!(rpc(&s, bearer(&second), ping).await.0, StatusCode::UNAUTHORIZED);
    }
}
