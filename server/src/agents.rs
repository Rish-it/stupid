//! Background agents on Muse Spark Open. Each run prepares work for the person; nothing is sent or changed.
use crate::{lock, meta, now, tickets, user, ApiResult, AppError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

const AGENTS: &[(&str, &str)] = &[
    ("leads", "You find sales leads for a creator or small business. From the comments and messages given, list people who show buying intent or ask about price, availability, booking or collaboration. Return JSON {\"leads\":[{\"who\":string,\"channel\":string,\"said\":string,\"why\":string,\"next_step\":string}]}. Quote what they said exactly. Return an empty list if nobody qualifies. Never invent people. Never guess sensitive traits such as health, religion, ethnicity, politics, sexuality or money troubles, and never rate anyone for credit, housing, jobs or insurance. next_step is a reply the business can send now; if hours_ago is 24 or more, say that a WhatsApp template or a new message from the customer is needed first."),
    ("ideas", "You are a content strategist for a creator or small business. From their recent posts and how each performed, write three new post ideas in their voice. Return JSON {\"ideas\":[{\"hook\":string,\"caption\":string,\"format\":\"reel\"|\"carousel\"|\"photo\"|\"story\",\"why\":string}]}. Base \"why\" only on the numbers given."),
    ("replies", "You draft replies to customer messages for a small business. Be warm, short and specific. Never promise prices, discounts or dates that are not in the conversation; ask instead. Return JSON {\"replies\":[{\"event_id\":number,\"to\":string,\"draft\":string}]}."),
    ("ads", "You review Meta ad results for a small business owner who is not a marketer. Use plain words and only the numbers given. Return JSON {\"summary\":string,\"actions\":[{\"campaign\":string,\"do\":\"pause\"|\"keep\"|\"scale\"|\"fix\",\"why\":string}]}."),
];
// Baseten list price for Muse Spark Open, USD per million tokens (input, output).
const PRICE: (f64, f64) = (1.25, 4.25);
// Reasoning tokens count toward this limit, so it leaves room for low-effort thinking plus the answer.
const MAX_TOKENS: u32 = 4000;
const MAX_INPUT_CHARS: usize = 12_000;

/// The person's own key for the provider at `muse_base` (Baseten by default), decrypted, if they saved one.
pub fn own_key(s: &AppState, user_id: &str) -> ApiResult<Option<String>> {
    let blob: Option<String> = lock(&s.db).query_row("SELECT ai_key_blob FROM users WHERE id=?1", [user_id], |r| r.get(0)).optional()?.flatten();
    let (Some(blob), Some(f)) = (blob, s.fernet.as_ref()) else { return Ok(None) };
    Ok(f.decrypt(&blob).ok().and_then(|k| String::from_utf8(k).ok()))
}

/// Whether the workspace key can still pay for a run.
pub fn workspace_ready(s: &AppState) -> ApiResult<bool> {
    let spent: f64 = lock(&s.db).query_row("SELECT COALESCE(SUM(usd),0) FROM spend WHERE own=0", [], |r| r.get(0))?;
    Ok(!s.cfg.muse_key.is_empty() && s.cfg.muse_budget_usd > spent)
}

fn saved_at(s: &AppState, user_id: &str) -> ApiResult<Option<i64>> {
    Ok(lock(&s.db).query_row("SELECT ai_key_saved_at FROM users WHERE id=?1", [user_id], |r| r.get(0)).optional()?.flatten())
}

pub async fn settings(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    Ok(Json(json!({ "has_key": own_key(&s, &u.id)?.is_some(), "key_saved_at": saved_at(&s, &u.id)?, "model": s.cfg.muse_model, "workspace_ai": workspace_ready(&s)? })))
}

#[derive(Deserialize)]
pub struct KeyBody {
    api_key: String,
    #[serde(default)]
    consent: bool,
}

/// Save the person's own Baseten API key after one tiny test call, or remove it when empty. It never leaves the server.
/// Never a Meta Model API key: those may not be shared with another service (Model API ToS §3.1).
/// Saving needs the person's consent to send what agents read to their own account; the time is kept as proof.
pub async fn save_key(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<KeyBody>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let key = body.api_key.trim();
    let blob = if key.is_empty() {
        None
    } else {
        if !(16..=512).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(AppError::new(400, "That does not look like an API key."));
        }
        if !body.consent {
            return Err(AppError::new(400, "Tick the box to send the messages agents read to your own AI account."));
        }
        let fernet = s.fernet.as_ref().ok_or_else(|| AppError::new(503, "Key storage is not configured."))?;
        let test = json!({ "model": s.cfg.muse_model, "max_tokens": 1, "messages": [{ "role": "user", "content": "ok" }] });
        let response = s.http.post(format!("{}/chat/completions", s.cfg.muse_base.trim_end_matches('/'))).bearer_auth(key).json(&test).send().await
            .map_err(|_| AppError::new(502, "Could not check the key. Try again."))?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err(AppError::new(400, "That key was refused.")),
            404 => return Err(AppError::new(400, format!("That key cannot use {}.", s.cfg.muse_model))),
            _ => return Err(AppError::new(502, "Could not check the key. Try again.")),
        }
        Some(fernet.encrypt(key.as_bytes()))
    };
    let at = blob.is_some().then(now);
    lock(&s.db).execute("UPDATE users SET ai_key_blob=?1, ai_key_saved_at=?2 WHERE id=?3", params![blob, at, u.id])?;
    Ok(Json(json!({ "has_key": blob.is_some(), "key_saved_at": at, "model": s.cfg.muse_model })))
}

pub async fn list(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let db = lock(&s.db);
    let mut stmt = db.prepare(
        "SELECT agent,status,result_json,error,cost_usd,created,finished FROM agent_runs
         WHERE id IN (SELECT MAX(id) FROM agent_runs WHERE user_id=?1 GROUP BY agent)",
    )?;
    let runs = stmt.query_map([&u.id], |r| {
        let result: Option<String> = r.get(2)?;
        Ok(json!({ "agent": r.get::<_, String>(0)?, "status": r.get::<_, String>(1)?,
            "result": result.and_then(|v| serde_json::from_str::<Value>(&v).ok()), "error": r.get::<_, Option<String>>(3)?,
            "cost_usd": r.get::<_, f64>(4)?, "created": r.get::<_, i64>(5)?, "finished": r.get::<_, Option<i64>>(6)? }))
    })?.collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(db);
    let own = own_key(&s, &u.id)?.is_some();
    Ok(Json(json!({ "runs": runs, "ai_ready": own || workspace_ready(&s)?, "own_key": own, "model": s.cfg.muse_model })))
}

pub async fn run(State(s): State<AppState>, headers: HeaderMap, Path(agent): Path<String>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let (name, system) = AGENTS.iter().find(|(n, _)| *n == agent).copied().ok_or_else(|| AppError::new(404, "Unknown agent."))?;
    let own = own_key(&s, &u.id)?;
    if own.is_none() && s.cfg.muse_key.is_empty() {
        return Err(AppError::new(503, "Add an AI key in Settings to run agents."));
    }
    // Checked again below under the same lock as the insert; this only avoids Meta calls for a refused run.
    busy(&lock(&s.db), &u.id, name)?;
    let context = match name {
        // The inbox already holds Instagram comments next to messages.
        "leads" => json!({ "messages": for_model(meta::fresh_inbox(&s, &u).await?) }),
        "ideas" => instagram_context(&meta::instagram_data(&s, &u).await?),
        "replies" => json!({ "messages": for_model(meta::fresh_inbox(&s, &u).await?.into_iter().filter(|m| m["kind"] != "instagram_comment").take(20).collect()) }),
        _ => meta::ads_data(&s, &u).await?,
    };
    let empty = context.as_object().is_some_and(|o| o.values().all(|v| v.as_array().is_some_and(|a| a.is_empty())));
    let (id, ticket) = {
        let db = lock(&s.db);
        busy(&db, &u.id, name)?;
        if empty {
            db.execute("INSERT INTO agent_runs (user_id,agent,status,result_json,created,finished) VALUES (?1,?2,'done','{\"empty\":true}',?3,?3)", params![u.id, name, now()])?;
            let ticket = tickets::open_job(&db, &u.id, name, db.last_insert_rowid())?;
            tickets::close_job(&db, ticket, "dropped", "Nothing to read yet.")?;
            return Ok(Json(json!({ "agent": name, "status": "done", "result": { "empty": true } })));
        }
        db.execute("INSERT INTO agent_runs (user_id,agent,status,created) VALUES (?1,?2,'running',?3)", params![u.id, name, now()])?;
        let id = db.last_insert_rowid();
        (id, tickets::open_job(&db, &u.id, name, id)?)
    };
    let state = s.clone();
    let inbox: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    tokio::spawn(async move {
        let outcome = muse(&state, name, system, &context, own.as_deref()).await;
        let db = lock(&state.db);
        let saved = match outcome {
            Ok((result, cost)) => db.execute("UPDATE agent_runs SET status='done',result_json=?1,cost_usd=?2,finished=?3 WHERE id=?4", params![result.to_string(), cost, now(), id])
                .and_then(|_| keep_drafts(&db, &u.id, ticket, &inbox, &result))
                .and_then(|_| { let (kind, text) = tickets::summary(name, &result); tickets::close_job(&db, ticket, kind, &text) }),
            Err(e) => db.execute("UPDATE agent_runs SET status='failed',error=?1,finished=?2 WHERE id=?3", params![e.1, now(), id])
                .and_then(|_| tickets::close_job(&db, ticket, "failed", &e.1)),
        };
        if let Err(e) = saved {
            tracing::error!("agent run {id}: {e}");
        }
    });
    Ok(Json(json!({ "agent": name, "status": "running" })))
}

/// What the model may see of Instagram: bio, followers, and each recent post's caption and counts.
pub fn instagram_context(ig: &Value) -> Value {
    json!({ "accounts": ig["accounts"].as_array().into_iter().flatten().map(|a| json!({
        "bio": a["profile"]["biography"], "followers": a["profile"]["followers_count"],
        "posts": a["media"].as_array().into_iter().flatten().map(|m| json!({ "caption": m["caption"], "type": m["media_product_type"], "likes": m["like_count"], "comments": m["comments_count"], "when": m["timestamp"] })).collect::<Vec<_>>() })).collect::<Vec<_>>() })
}

/// Only what a draft needs from inbox rows. The sender's phone number, PSID or IGSID and the asset id never reach the model.
pub fn for_model(rows: Vec<Value>) -> Vec<Value> {
    let t = now();
    rows.into_iter().map(|m| json!({ "id": m["id"], "kind": m["kind"], "sender_name": m["sender_name"], "text": m["text"],
        "hours_ago": m["created"].as_i64().map(|c| (t - c).max(0) / 3600) })).collect()
}

/// Reply drafts from a Reply drafts run become durable drafts, for messages in this person's own inbox only.
fn keep_drafts(db: &rusqlite::Connection, user_id: &str, ticket: i64, inbox: &[String], result: &Value) -> rusqlite::Result<()> {
    for r in result["replies"].as_array().into_iter().flatten() {
        let event = r["event_id"].as_i64().or_else(|| r["event_id"].as_str().and_then(|v| v.parse().ok()));
        let (Some(event), Some(text)) = (event, r["draft"].as_str().filter(|t| !t.trim().is_empty())) else { continue };
        let asset: Option<String> = db.query_row("SELECT asset_id FROM events WHERE id=?1", [event], |r| r.get(0)).optional()?;
        if asset.is_some_and(|a| inbox.contains(&a)) {
            db.execute("INSERT INTO drafts (user_id,ticket_id,event_id,text,source,created) VALUES (?1,?2,?3,?4,'agent',?5)",
                params![user_id, ticket, event, text.chars().take(1000).collect::<String>(), now()])?;
        }
    }
    Ok(())
}

/// Refuse a second run of the same agent, and more than the daily limit of runs and evals per person.
fn busy(db: &rusqlite::Connection, user_id: &str, agent: &str) -> ApiResult<()> {
    let running: i64 = db.query_row("SELECT COUNT(*) FROM agent_runs WHERE user_id=?1 AND agent=?2 AND status='running'", params![user_id, agent], |r| r.get(0))?;
    if running > 0 {
        return Err(AppError::new(409, "This agent is already working."));
    }
    if tickets::calls_today(db, user_id)? >= tickets::CALLS_PER_DAY {
        return Err(AppError::new(429, "That is enough agent runs for today. Try again tomorrow."));
    }
    Ok(())
}

/// One Muse call with a JSON answer, under the workspace spend cap unless the person brought their own key.
/// Returns the parsed JSON answer and its cost in USD.
pub async fn muse(s: &AppState, agent: &str, system: &str, context: &Value, own_key: Option<&str>) -> ApiResult<(Value, f64)> {
    let mut input = context.to_string();
    if input.len() > MAX_INPUT_CHARS {
        input = input.chars().take(MAX_INPUT_CHARS).collect();
    }
    let messages = [json!({ "role": "system", "content": format!("{system} Reply with the JSON object only.") }), json!({ "role": "user", "content": input })];
    let (data, cost) = chat(s, agent, &messages, None, own_key).await?;
    Ok((extract_json(answer(&data)?).ok_or_else(|| AppError::new(502, "Muse answered without the expected format."))?, cost))
}

/// One chat call to Muse with these messages and, for the agent's executor, its tools.
/// Spend is recorded whatever the answer says. Returns the whole answer and its cost in USD.
pub async fn chat(s: &AppState, agent: &str, messages: &[Value], tools: Option<&[Value]>, own_key: Option<&str>) -> ApiResult<(Value, f64)> {
    // Rough worst case: 3 characters per token, every output token used.
    let chars = Value::from(messages.to_vec()).to_string().len() + tools.map_or(0, |t| Value::from(t.to_vec()).to_string().len());
    let estimate = (chars as f64 / 3.0 * PRICE.0 + MAX_TOKENS as f64 * PRICE.1) / 1e6;
    if own_key.is_none() {
        let db = lock(&s.db);
        let spent: f64 = db.query_row("SELECT COALESCE(SUM(usd),0) FROM spend WHERE own=0", [], |r| r.get(0))?;
        // ponytail: check-then-record, so parallel runs can pass the cap by one call (about $0.01).
        if spent + estimate > s.cfg.muse_budget_usd {
            return Err(AppError::new(402, "The AI budget for this workspace is used up."));
        }
    }
    // Muse Spark Open defaults to xhigh reasoning, which can use up max_tokens before the answer starts.
    let mut body = json!({ "model": s.cfg.muse_model, "max_tokens": MAX_TOKENS, "reasoning_effort": "low", "messages": messages });
    if let Some(tools) = tools {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    let started = std::time::Instant::now();
    let response = s.http.post(format!("{}/chat/completions", s.cfg.muse_base.trim_end_matches('/'))).bearer_auth(own_key.unwrap_or(&s.cfg.muse_key)).timeout(std::time::Duration::from_secs(120)).json(&body).send().await
        .map_err(|e| if e.is_timeout() { AppError::new(504, refusal(504, None)) } else { AppError::new(502, "Muse could not be reached.") })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(agent, model = %s.cfg.muse_model, %status, "muse refused");
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
        return Err(AppError::new(502, refusal(status.as_u16(), retry_after.as_deref())));
    }
    let data: Value = response.json().await.map_err(|_| AppError::new(502, "Muse sent an unreadable answer."))?;
    let usage = &data["usage"];
    // Without a usage report, charge the worst-case estimate rather than nothing.
    let cost = match (usage["prompt_tokens"].as_f64(), usage["completion_tokens"].as_f64()) {
        (Some(i), Some(o)) => (i * PRICE.0 + o * PRICE.1) / 1e6,
        _ => estimate,
    };
    lock(&s.db).execute("INSERT INTO spend (usd,created,own) VALUES (?1,?2,?3)", params![cost, now(), own_key.is_some()])?;
    tracing::info!(agent, model = %s.cfg.muse_model, prompt_tokens = usage["prompt_tokens"].as_u64(), completion_tokens = usage["completion_tokens"].as_u64(),
        cost_usd = format!("{cost:.4}"), ms = started.elapsed().as_millis() as u64, own_key = own_key.is_some(), "muse call");
    Ok((data, cost))
}

/// The answer text, or a plain-words error when Muse stopped at the token limit.
pub fn answer(data: &Value) -> ApiResult<&str> {
    let choice = &data["choices"][0];
    if choice["finish_reason"] == "length" {
        return Err(AppError::new(502, "Muse ran out of room before it finished. Run it again."));
    }
    Ok(choice["message"]["content"].as_str().unwrap_or_default())
}

/// What a refused Muse call means, in plain words.
fn refusal(status: u16, retry_after: Option<&str>) -> String {
    match status {
        402 => "The AI account is out of credit or has no billing set up.".into(),
        429 => match retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
            Some(secs) => format!("Muse is busy. Try again in {secs} seconds."),
            None => "Muse is busy. Try again in a minute.".into(),
        },
        504 => "Muse took too long to answer. Try again.".into(),
        401 | 403 => "The AI key was refused.".into(),
        _ => "Muse refused the request.".into(),
    }
}

fn extract_json(text: &str) -> Option<Value> {
    let text = text.rsplit_once("</think>").map(|(_, t)| t).unwrap_or(text);
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    serde_json::from_str(text.get(start..=end)?).ok().filter(Value::is_object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_from_model_text() {
        assert_eq!(extract_json("<think>{no}</think>\n```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert!(extract_json("no json here").is_none());
        assert!(extract_json("[1,2]").is_none());
    }

    #[test]
    fn the_model_never_sees_sender_ids() {
        let row = json!({ "id": 7, "kind": "whatsapp", "asset_id": "1234", "sender": "919876543210", "sender_name": "Asha", "text": "price?", "created": now() - 7200, "replied": false });
        let sent = for_model(vec![row]);
        assert_eq!(sent, vec![json!({ "id": 7, "kind": "whatsapp", "sender_name": "Asha", "text": "price?", "hours_ago": 2 })]);
        assert!(!sent[0].to_string().contains("919876543210") && !sent[0].to_string().contains("1234"));
    }

    #[test]
    fn a_cut_off_answer_is_an_error() {
        let cut = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{\"a\":" } }] });
        assert_eq!(answer(&cut).unwrap_err().1, "Muse ran out of room before it finished. Run it again.");
        let done = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{\"a\":1}" } }] });
        assert_eq!(answer(&done).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn refusals_in_plain_words() {
        assert!(refusal(402, None).contains("credit"));
        assert_eq!(refusal(429, Some("30")), "Muse is busy. Try again in 30 seconds.");
        assert_eq!(refusal(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")), "Muse is busy. Try again in a minute.");
        assert!(refusal(504, None).contains("too long"));
    }
}
