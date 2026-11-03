//! Background agents on Muse Spark. Each run prepares work for the person; nothing is sent or changed.
use crate::{lock, meta, now, user, ApiResult, AppError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::params;
use serde_json::{json, Value};

const AGENTS: &[(&str, &str)] = &[
    ("leads", "You find sales leads for a creator or small business. From the comments and messages given, list people who show buying intent or ask about price, availability, booking or collaboration. Return JSON {\"leads\":[{\"who\":string,\"channel\":string,\"said\":string,\"why\":string,\"next_step\":string}]}. Quote what they said exactly. Return an empty list if nobody qualifies. Never invent people."),
    ("ideas", "You are a content strategist for a creator or small business. From their recent posts and how each performed, write three new post ideas in their voice. Return JSON {\"ideas\":[{\"hook\":string,\"caption\":string,\"format\":\"reel\"|\"carousel\"|\"photo\"|\"story\",\"why\":string}]}. Base \"why\" only on the numbers given."),
    ("replies", "You draft replies to customer messages for a small business. Be warm, short and specific. Never promise prices, discounts or dates that are not in the conversation; ask instead. Return JSON {\"replies\":[{\"event_id\":number,\"to\":string,\"draft\":string}]}."),
    ("ads", "You review Meta ad results for a small business owner who is not a marketer. Use plain words and only the numbers given. Return JSON {\"summary\":string,\"actions\":[{\"campaign\":string,\"do\":\"pause\"|\"keep\"|\"scale\"|\"fix\",\"why\":string}]}."),
];
// Baseten list price for Muse Spark Open, USD per million tokens (input, output).
const PRICE: (f64, f64) = (1.25, 4.25);
const MAX_TOKENS: u32 = 1200;
const MAX_INPUT_CHARS: usize = 12_000;

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
    let spent: f64 = db.query_row("SELECT COALESCE(SUM(usd),0) FROM spend", [], |r| r.get(0))?;
    Ok(Json(json!({ "runs": runs, "ai_ready": !s.cfg.muse_key.is_empty() && s.cfg.muse_budget_usd > spent, "model": s.cfg.muse_model })))
}

pub async fn run(State(s): State<AppState>, headers: HeaderMap, Path(agent): Path<String>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let (name, system) = AGENTS.iter().find(|(n, _)| *n == agent).copied().ok_or_else(|| AppError::new(404, "Unknown agent."))?;
    if s.cfg.muse_key.is_empty() {
        return Err(AppError::new(503, "Add an AI key in Settings to run agents."));
    }
    let context = match name {
        "leads" => json!({ "instagram_comments": meta::instagram_comments(&s, &u).await.unwrap_or_default(), "messages": meta::inbox_rows(&s, &u)? }),
        "ideas" => {
            let ig = meta::instagram_data(&s, &u).await?;
            json!({ "accounts": ig["accounts"].as_array().into_iter().flatten().map(|a| json!({
                "bio": a["profile"]["biography"], "followers": a["profile"]["followers_count"],
                "posts": a["media"].as_array().into_iter().flatten().map(|m| json!({ "caption": m["caption"], "type": m["media_product_type"], "likes": m["like_count"], "comments": m["comments_count"], "when": m["timestamp"] })).collect::<Vec<_>>() })).collect::<Vec<_>>() })
        }
        "replies" => json!({ "messages": meta::inbox_rows(&s, &u)?.into_iter().filter(|m| m["kind"] != "instagram_comment").take(20).collect::<Vec<_>>() }),
        _ => meta::ads_data(&s, &u).await?,
    };
    let empty = context.as_object().is_some_and(|o| o.values().all(|v| v.as_array().is_some_and(|a| a.is_empty())));
    let id = {
        let db = lock(&s.db);
        let busy: i64 = db.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE user_id=?1 AND agent=?2 AND status='running' AND created>?3",
            params![u.id, name, now() - 300], |r| r.get(0))?;
        if busy > 0 {
            return Err(AppError::new(409, "This agent is already working."));
        }
        if empty {
            db.execute("INSERT INTO agent_runs (user_id,agent,status,result_json,created,finished) VALUES (?1,?2,'done','{\"empty\":true}',?3,?3)", params![u.id, name, now()])?;
            return Ok(Json(json!({ "agent": name, "status": "done", "result": { "empty": true } })));
        }
        db.execute("INSERT INTO agent_runs (user_id,agent,status,created) VALUES (?1,?2,'running',?3)", params![u.id, name, now()])?;
        db.last_insert_rowid()
    };
    let state = s.clone();
    tokio::spawn(async move {
        let outcome = muse(&state, system, &context).await;
        let db = lock(&state.db);
        let _ = match outcome {
            Ok((result, cost)) => db.execute("UPDATE agent_runs SET status='done',result_json=?1,cost_usd=?2,finished=?3 WHERE id=?4", params![result.to_string(), cost, now(), id]),
            Err(e) => db.execute("UPDATE agent_runs SET status='failed',error=?1,finished=?2 WHERE id=?3", params![e.1, now(), id]),
        };
    });
    Ok(Json(json!({ "agent": name, "status": "running" })))
}

/// One Muse call under the spend cap. Returns the parsed JSON answer and its cost in USD.
async fn muse(s: &AppState, system: &str, context: &Value) -> ApiResult<(Value, f64)> {
    let mut input = context.to_string();
    if input.len() > MAX_INPUT_CHARS {
        input = input.chars().take(MAX_INPUT_CHARS).collect();
    }
    // Rough worst case: 3 characters per token, every output token used.
    let estimate = ((input.len() + system.len()) as f64 / 3.0 * PRICE.0 + MAX_TOKENS as f64 * PRICE.1) / 1e6;
    {
        let db = lock(&s.db);
        let spent: f64 = db.query_row("SELECT COALESCE(SUM(usd),0) FROM spend", [], |r| r.get(0))?;
        // ponytail: check-then-record, so parallel runs can pass the cap by one call (about $0.01).
        if spent + estimate > s.cfg.muse_budget_usd {
            return Err(AppError::new(402, "The AI budget for this workspace is used up."));
        }
    }
    let body = json!({ "model": s.cfg.muse_model, "max_tokens": MAX_TOKENS, "temperature": 0.4, "messages": [
        { "role": "system", "content": format!("{system} Reply with the JSON object only.") },
        { "role": "user", "content": input },
    ]});
    let response = s.http.post(format!("{}/chat/completions", s.cfg.muse_base.trim_end_matches('/'))).bearer_auth(&s.cfg.muse_key).json(&body).send().await
        .map_err(|_| AppError::new(502, "Muse could not be reached."))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|_| AppError::new(502, "Muse sent an unreadable answer."))?;
    if !status.is_success() {
        tracing::warn!("Muse error {status}");
        return Err(AppError::new(502, "Muse refused the request."));
    }
    let usage = &data["usage"];
    let cost = (usage["prompt_tokens"].as_f64().unwrap_or(0.0) * PRICE.0 + usage["completion_tokens"].as_f64().unwrap_or(MAX_TOKENS as f64) * PRICE.1) / 1e6;
    lock(&s.db).execute("INSERT INTO spend (usd,created) VALUES (?1,?2)", params![cost, now()])?;
    let text = data["choices"][0]["message"]["content"].as_str().unwrap_or_default();
    Ok((extract_json(text).ok_or_else(|| AppError::new(502, "Muse answered without the expected format."))?, cost))
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
}
