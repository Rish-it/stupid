//! Background agents on Muse Spark Open. Each run prepares work for the person; nothing is sent or changed.
use crate::{attention, control, crops, lock, meta, now, reels, tickets, user, ApiResult, AppError, AppState, User};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

/// Who the lead finder looks for when the person hasn't said whether they are a creator or a business.
const LEADS: &str = "You find sales leads for a creator or small business. From the comments and messages given, list people who show buying intent or ask about price, availability, booking or collaboration.";
/// The lead finder's rules for every persona: output shape, no invented people, no sensitive guesses, the 24-hour window.
const LEAD_RULES: &str = "Return JSON {\"leads\":[{\"who\":string,\"channel\":string,\"said\":string,\"why\":string,\"next_step\":string}]}. Quote what they said exactly. Return an empty list if nobody qualifies. Never invent people. Never guess sensitive traits such as health, religion, ethnicity, politics, sexuality or money troubles, and never rate anyone for credit, housing, jobs or insurance. next_step is a reply the business can send now; if hours_ago is 24 or more, say that a WhatsApp template or a new message from the customer is needed first. owner_facts are answers the owner gave before, such as prices or terms; use them in next_step instead of guessing.";
const AGENTS: &[(&str, &str)] = &[
    ("leads", LEADS),
    ("ideas", "You are a content strategist for a creator or small business. From their recent posts and how each performed, write three new post ideas in their voice. Return JSON {\"ideas\":[{\"hook\":string,\"caption\":string,\"format\":\"reel\"|\"carousel\"|\"photo\"|\"story\",\"why\":string}]}. Base \"why\" only on the numbers given."),
    ("replies", "You draft replies to customer messages for a small business. Be warm, short and specific. Never promise prices, discounts or dates that are not in the conversation or owner_facts; ask instead. owner_facts are answers the owner gave before; when a draft relies on one, set its fact_id, otherwise null. Return JSON {\"replies\":[{\"event_id\":number,\"to\":string,\"draft\":string,\"fact_id\":number|null}]}."),
    ("reels", reels::FROM_CAPTIONS),
    ("ads", "You review Meta ad results for a small business owner who is not a marketer. Use plain words and only the numbers given. Return JSON {\"summary\":string,\"actions\":[{\"campaign\":string,\"do\":\"pause\"|\"keep\"|\"scale\"|\"fix\",\"why\":string}]}."),
];

/// One line of who the owner is, so drafts sound like them. Empty until they pick.
pub fn owner_line(persona: Option<&str>) -> &'static str {
    match persona {
        Some("creator") => "The owner is a creator: fans, followers and brands write to them, so sound like a friendly creator, not a shop. ",
        Some("business") => "The owner is a small business: customers write about products, prices, orders and bookings. ",
        _ => "",
    }
}

/// The agent's instructions for this person. The lead finder hunts brand deals for creators and buyers
/// for businesses; reply drafts learn who the owner is. Every rule in the base prompt stays.
fn system_for(agent: &str, base: &str, persona: Option<&str>) -> String {
    match (agent, persona) {
        ("leads", Some("creator")) => format!("You find brand deals and sales leads for a creator. From the comments and messages given, list brands or people who offer or ask about a brand deal, collab, sponsorship, paid post or affiliate deal, and people who show buying intent or ask about price, availability or booking. {LEAD_RULES}"),
        ("leads", Some("business")) => format!("You find sales leads for a small business. From the comments and messages given, list people who show buying intent: they ask about price, stock, availability, delivery, booking or how to order. {LEAD_RULES}"),
        ("leads", _) => format!("{base} {LEAD_RULES}"),
        ("replies", _) => format!("{}{base}", owner_line(persona)),
        _ => base.to_string(),
    }
}

/// The Meta models that made a finished run, by name, so the Agents screen says what actually ran.
/// Reels from videos ran on Muse Wonder alone; a creative pack adds SAM 3.1 when it looked at a picture.
fn models(agent: &str, result: &Value, ai: &Ai) -> Vec<&'static str> {
    let brain = if *ai == Ai::Meta { "Muse Spark 1.3" } else { "Muse Spark Open" };
    let mut out = vec![if agent == "reels" && result["from_captions_only"] == false { "Muse Wonder" } else { brain }];
    let sam = result["creative_pack"].as_array().into_iter().flatten()
        .any(|c| !c["box"].is_null() || c["note"].as_str().is_some_and(|n| n.starts_with("SAM 3.1")));
    if sam {
        out.push("SAM 3.1");
    }
    out
}

/// The agents in the order this person sees them.
pub fn order(persona: Option<&str>) -> Vec<&'static str> {
    match persona {
        Some("creator") => vec!["reels", "ideas", "leads", "replies", "ads"],
        Some("business") => vec!["replies", "leads", "ads", "ideas", "reels"],
        _ => AGENTS.iter().map(|(name, _)| *name).collect(),
    }
}

// Baseten list price for Muse Spark Open, USD per million tokens (input, output).
const PRICE: (f64, f64) = (1.25, 4.25);
// Reasoning tokens count toward this limit, so it leaves room for low-effort thinking plus the answer.
const MAX_TOKENS: u32 = 4000;
const MAX_INPUT_CHARS: usize = 12_000;
/// Post ideas look at up to this many of the best post pictures.
const IDEA_PICTURES: usize = 6;

/// The person's own key for the provider at `muse_base` (Baseten by default), decrypted, if they saved one.
pub fn own_key(s: &AppState, user_id: &str) -> ApiResult<Option<String>> {
    let blob: Option<String> = lock(&s.db).query_row("SELECT ai_key_blob FROM users WHERE id=?1", [user_id], |r| r.get(0)).optional()?.flatten();
    let (Some(blob), Some(f)) = (blob, s.fernet.as_ref()) else { return Ok(None) };
    Ok(f.decrypt(&blob).ok().and_then(|k| String::from_utf8(k).ok()))
}

/// Which model runs a person's agents, and who pays for it.
#[derive(Clone, Debug, PartialEq)]
pub enum Ai {
    /// Muse Spark Open at `muse_base` on Stupid's key, under STUPID_MUSE_BUDGET_USD.
    Workspace,
    /// Muse Spark Open on the person's own Baseten key.
    Own(String),
    /// Muse Spark 1.3 on Meta's Model API with Stupid's key, under STUPID_META_API_BUDGET_USD.
    Meta,
}

/// The Model API model that runs agents when the person picks Meta's API. Multimodal, with tool calling.
pub const META_MODEL: &str = "muse-spark-1.3";

impl Ai {
    pub fn model<'a>(&self, s: &'a AppState) -> &'a str {
        if *self == Ai::Meta { META_MODEL } else { &s.cfg.muse_model }
    }
    pub fn own(&self) -> bool {
        matches!(self, Ai::Own(_))
    }
}

/// What the person picked in Settings: Meta's API when chosen (or when it is the only one set up), else their own
/// Baseten key, else Stupid's Baseten key.
pub fn ai(s: &AppState, user_id: &str) -> ApiResult<Ai> {
    let choice: Option<String> = lock(&s.db).query_row("SELECT ai_brain FROM users WHERE id=?1", [user_id], |r| r.get(0)).optional()?;
    let meta = !s.cfg.meta_api_key.is_empty();
    if meta && choice.as_deref() == Some("meta") {
        return Ok(Ai::Meta);
    }
    if let Some(key) = own_key(s, user_id)? {
        return Ok(Ai::Own(key));
    }
    Ok(if meta && s.cfg.muse_key.is_empty() { Ai::Meta } else { Ai::Workspace })
}

/// Whether this model can still be paid for.
pub fn ready(s: &AppState, ai: &Ai) -> ApiResult<bool> {
    match ai {
        Ai::Own(_) => Ok(true),
        Ai::Workspace => workspace_ready(s),
        Ai::Meta => Ok(meta_spent(s)? < s.cfg.meta_api_budget_usd),
    }
}

fn meta_spent(s: &AppState) -> ApiResult<f64> {
    Ok(lock(&s.db).query_row("SELECT COALESCE(SUM(usd),0) FROM meta_api_spend", [], |r| r.get(0))?)
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
    let ai = ai(&s, &u.id)?;
    Ok(Json(json!({ "has_key": own_key(&s, &u.id)?.is_some(), "key_saved_at": saved_at(&s, &u.id)?, "model": ai.model(&s), "workspace_ai": workspace_ready(&s)?,
        "brain": if ai == Ai::Meta { "meta" } else { "open" }, "meta_brain": !s.cfg.meta_api_key.is_empty(), "open_model": s.cfg.muse_model, "meta_model": META_MODEL })))
}

#[derive(Deserialize)]
pub struct BrainBody {
    brain: String,
}

/// Pick the model that runs the person's agents: Muse Spark Open (`open`) or Muse Spark 1.3 on Meta's Model API (`meta`).
pub async fn save_brain(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<BrainBody>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    match body.brain.as_str() {
        "open" => {}
        "meta" if !s.cfg.meta_api_key.is_empty() => {}
        "meta" => return Err(AppError::new(400, "Meta's Model API is not set up on this server.")),
        _ => return Err(AppError::new(400, "Pick open or meta.")),
    }
    lock(&s.db).execute("UPDATE users SET ai_brain=?1 WHERE id=?2", params![body.brain, u.id])?;
    settings(State(s), headers).await
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
        "SELECT agent,status,result_json,error,cost_usd,created,finished,models_json FROM agent_runs
         WHERE id IN (SELECT MAX(id) FROM agent_runs WHERE user_id=?1 GROUP BY agent)",
    )?;
    let runs = stmt.query_map([&u.id], |r| {
        let result: Option<String> = r.get(2)?;
        Ok(json!({ "agent": r.get::<_, String>(0)?, "status": r.get::<_, String>(1)?,
            "result": result.and_then(|v| serde_json::from_str::<Value>(&v).ok()), "error": r.get::<_, Option<String>>(3)?,
            "cost_usd": r.get::<_, f64>(4)?, "created": r.get::<_, i64>(5)?, "finished": r.get::<_, Option<i64>>(6)?,
            "models": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap_or_else(|_| json!([])) }))
    })?.collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let controls = control::all(&db, &u.id)?;
    drop(db);
    let ai = ai(&s, &u.id)?;
    Ok(Json(json!({ "runs": runs, "ai_ready": ready(&s, &ai)?, "own_key": ai.own(), "model": ai.model(&s), "order": order(u.persona.as_deref()), "controls": controls })))
}

pub async fn run(State(s): State<AppState>, headers: HeaderMap, Path(agent): Path<String>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    start(&s, u, &agent).await.map(Json)
}

/// Start one job for the person, from a Run tap or from Muse over MCP: same spend cap and daily limit.
pub async fn start(s: &AppState, u: User, agent: &str) -> ApiResult<Value> {
    let (name, base) = AGENTS.iter().find(|(n, _)| *n == agent).copied().ok_or_else(|| AppError::new(404, "Unknown agent."))?;
    let (mode, note) = control::get(&lock(&s.db), &u.id, name)?;
    if mode == "off" {
        return Err(AppError::new(409, "This agent is off. Turn it on to run it."));
    }
    let system = format!("{}{}", system_for(name, base, u.persona.as_deref()), control::note_line(&note));
    let ai = ai(s, &u.id)?;
    if ai == Ai::Workspace && s.cfg.muse_key.is_empty() {
        return Err(AppError::new(503, "Add an AI key in Settings to run agents."));
    }
    // Checked again below under the same lock as the insert; this only avoids Meta calls for a refused run.
    busy(&lock(&s.db), &u.id, name)?;
    let mut pictures_for_ideas: Vec<String> = Vec::new();
    let context = match name {
        // The inbox already holds Instagram comments next to messages.
        "leads" => json!({ "messages": for_model(meta::fresh_inbox(s, &u).await?) }),
        "ideas" => {
            let ig = meta::instagram_data(s, &u).await?;
            pictures_for_ideas = crops::best(&ig, IDEA_PICTURES).iter().filter_map(|m| crops::picture(m).map(str::to_owned)).collect();
            instagram_context(&ig)
        }
        "reels" => reels::context(&meta::instagram_data(s, &u).await?),
        "replies" => json!({ "messages": for_model(meta::fresh_inbox(s, &u).await?.into_iter().filter(|m| m["kind"] != "instagram_comment").take(20).collect()) }),
        _ => meta::ads_data(s, &u).await?,
    };
    let empty = context.as_object().is_some_and(|o| o.values().all(|v| v.as_array().is_some_and(|a| a.is_empty())));
    let mut context = context;
    // What the owner told the agent before; added after the empty check, since facts alone are nothing to read.
    if matches!(name, "leads" | "replies") {
        context["owner_facts"] = json!(attention::facts_for_model(&lock(&s.db), &u.id)?);
    }
    if !note.is_empty() {
        context["owner_note"] = json!(note);
    }
    let styled = if name == "replies" { crate::style::current(s, &u).await? } else { None };
    let system = match &styled {
        Some(style) => { context["owner_style"] = style.clone(); format!("{system}{}", crate::style::STYLE_LINE) }
        None => system,
    };
    // Ad watcher also brings an ad creative pack cut from the creator's own best pictures.
    let pictures = if name == "ads" && !u.selected_assets("instagram").is_empty() { meta::instagram_data(s, &u).await.ok() } else { None };
    let (id, ticket) = {
        let db = lock(&s.db);
        busy(&db, &u.id, name)?;
        if empty {
            db.execute("INSERT INTO agent_runs (user_id,agent,status,result_json,created,finished) VALUES (?1,?2,'done','{\"empty\":true}',?3,?3)", params![u.id, name, now()])?;
            let ticket = tickets::open_job(&db, &u.id, name, db.last_insert_rowid())?;
            tickets::close_job(&db, ticket, "dropped", "Nothing to read yet.")?;
            return Ok(json!({ "agent": name, "status": "done", "result": { "empty": true } }));
        }
        db.execute("INSERT INTO agent_runs (user_id,agent,status,created) VALUES (?1,?2,'running',?3)", params![u.id, name, now()])?;
        let id = db.last_insert_rowid();
        (id, tickets::open_job(&db, &u.id, name, id)?)
    };
    let state = s.clone();
    let inbox: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    tokio::spawn(async move {
        let mut outcome = match name {
            "reels" => reels::direct(&state, &u.id, &context, &ai).await,
            "ideas" => ideas(&state, &system, &context, &pictures_for_ideas, &ai).await,
            _ => muse(&state, name, &system, &context, &ai).await,
        };
        if let (Ok((result, cost)), Some(ig)) = (&mut outcome, &pictures) {
            let (pack, more) = crops::pack(&state, &u.id, ig, &ai).await;
            result["creative_pack"] = json!(pack);
            *cost += more;
        }
        let db = lock(&state.db);
        let saved = match outcome {
            Ok((result, cost)) => db.execute("UPDATE agent_runs SET status='done',result_json=?1,cost_usd=?2,finished=?3,models_json=?4 WHERE id=?5",
                    params![result.to_string(), cost, now(), json!(models(name, &result, &ai)).to_string(), id])
                .and_then(|_| keep_drafts(&db, &u.id, ticket, &inbox, &result))
                .and_then(|_| if styled.is_some() { crate::style::mark(&db, ticket) } else { Ok(()) })
                .and_then(|_| { let (kind, text) = tickets::summary(name, &result); tickets::close_job(&db, ticket, kind, &text) }),
            Err(e) => db.execute("UPDATE agent_runs SET status='failed',error=?1,finished=?2 WHERE id=?3", params![e.1, now(), id])
                .and_then(|_| tickets::close_job(&db, ticket, "failed", &e.1)),
        };
        if let Err(e) = saved {
            tracing::error!("agent run {id}: {e}");
        }
    });
    Ok(json!({ "agent": name, "status": "running" }))
}

/// Post ideas that look at the creator's best pictures too. If a picture can't be fetched, it tries once more on text alone.
async fn ideas(s: &AppState, system: &str, context: &Value, pictures: &[String], ai: &Ai) -> ApiResult<(Value, f64)> {
    if !pictures.is_empty() {
        let seeing = format!("{system} You also see the pictures of their best posts, best first. Use what is in them (the product, setting, light, colours, people or not) in \"why\", and say which picture you mean.");
        match muse_seeing(s, "ideas", &seeing, context, pictures, ai).await {
            Ok((mut result, cost)) => {
                result["looked_at"] = json!(pictures.len());
                return Ok((result, cost));
            }
            Err(e) => tracing::warn!("ideas with pictures: {}; trying on text alone", e.1),
        }
    }
    let (mut result, cost) = muse(s, "ideas", system, context, ai).await?;
    result["looked_at"] = json!(0);
    Ok((result, cost))
}

/// What the model may see of Instagram: bio, followers, and each recent post's caption and counts.
pub fn instagram_context(ig: &Value) -> Value {
    json!({ "accounts": ig["accounts"].as_array().into_iter().flatten().map(|a| json!({
        "bio": a["profile"]["biography"], "followers": a["profile"]["followers_count"],
        "posts": a["media"].as_array().into_iter().flatten().map(|m| json!({ "id": m["id"], "caption": m["caption"], "type": m["media_product_type"], "likes": m["like_count"], "comments": m["comments_count"], "when": m["timestamp"] })).collect::<Vec<_>>() })).collect::<Vec<_>>() })
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
            db.execute("INSERT INTO drafts (user_id,ticket_id,event_id,text,source,created,learned_id) VALUES (?1,?2,?3,?4,'agent',?5,(SELECT id FROM learned WHERE id=?6 AND user_id=?1))",
                params![user_id, ticket, event, text.chars().take(1000).collect::<String>(), now(), r["fact_id"].as_i64()])?;
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
pub async fn muse(s: &AppState, agent: &str, system: &str, context: &Value, ai: &Ai) -> ApiResult<(Value, f64)> {
    muse_seeing(s, agent, system, context, &[], ai).await
}

/// Like `muse`, with pictures the model looks at after the text (Muse Spark Open on Baseten reads `image_url` parts).
pub async fn muse_seeing(s: &AppState, agent: &str, system: &str, context: &Value, images: &[String], ai: &Ai) -> ApiResult<(Value, f64)> {
    let mut input = context.to_string();
    if input.len() > MAX_INPUT_CHARS {
        input = input.chars().take(MAX_INPUT_CHARS).collect();
    }
    let content = if images.is_empty() { json!(input) } else {
        json!([json!({ "type": "text", "text": input })].into_iter().chain(images.iter().map(|url| json!({ "type": "image_url", "image_url": { "url": url } }))).collect::<Vec<_>>())
    };
    let messages = [json!({ "role": "system", "content": format!("{system} Reply with the JSON object only.") }), json!({ "role": "user", "content": content })];
    let (data, cost) = chat(s, agent, &messages, None, ai).await?;
    Ok((extract_json(answer(&data)?).ok_or_else(|| AppError::new(502, "Muse answered without the expected format."))?, cost))
}

/// One chat call to Muse with these messages and, for the agent's executor, its tools.
/// Spend is recorded whatever the answer says. Returns the whole answer and its cost in USD.
pub async fn chat(s: &AppState, agent: &str, messages: &[Value], tools: Option<&[Value]>, ai: &Ai) -> ApiResult<(Value, f64)> {
    // Rough worst case: 3 characters per token, every output token used.
    let chars = Value::from(messages.to_vec()).to_string().len() + tools.map_or(0, |t| Value::from(t.to_vec()).to_string().len());
    let estimate = (chars as f64 / 3.0 * PRICE.0 + MAX_TOKENS as f64 * PRICE.1) / 1e6;
    // ponytail: check-then-record, so parallel runs can pass a cap by one call (about $0.01).
    let over = match ai {
        Ai::Own(_) => false,
        Ai::Workspace => lock(&s.db).query_row("SELECT COALESCE(SUM(usd),0) FROM spend WHERE own=0", [], |r| r.get::<_, f64>(0))? + estimate > s.cfg.muse_budget_usd,
        Ai::Meta => meta_spent(s)? + estimate > s.cfg.meta_api_budget_usd,
    };
    if over {
        return Err(AppError::new(402, "The AI budget for this workspace is used up."));
    }
    let (base, key, model) = match ai {
        Ai::Workspace => (&s.cfg.muse_base, s.cfg.muse_key.as_str(), s.cfg.muse_model.as_str()),
        Ai::Own(key) => (&s.cfg.muse_base, key.as_str(), s.cfg.muse_model.as_str()),
        Ai::Meta => (&s.cfg.meta_api_base, s.cfg.meta_api_key.as_str(), META_MODEL),
    };
    // Muse Spark Open defaults to xhigh reasoning, which can use up max_tokens before the answer starts.
    let mut body = json!({ "model": model, "max_tokens": MAX_TOKENS, "reasoning_effort": "low", "messages": messages });
    if let Some(tools) = tools {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    let started = std::time::Instant::now();
    let response = s.http.post(format!("{}/chat/completions", base.trim_end_matches('/'))).bearer_auth(key).timeout(std::time::Duration::from_secs(120)).json(&body).send().await
        .map_err(|e| if e.is_timeout() { AppError::new(504, refusal(504, None)) } else { AppError::new(502, "Muse could not be reached.") })?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let detail: String = response.text().await.unwrap_or_default().chars().take(300).collect();
        tracing::warn!(agent, model, %status, detail, "muse refused");
        return Err(AppError::new(502, refusal(status.as_u16(), retry_after.as_deref())));
    }
    let data: Value = response.json().await.map_err(|_| AppError::new(502, "Muse sent an unreadable answer."))?;
    let usage = &data["usage"];
    // Without a usage report, charge the worst-case estimate rather than nothing.
    let cost = match (usage["prompt_tokens"].as_f64(), usage["completion_tokens"].as_f64()) {
        (Some(i), Some(o)) => (i * PRICE.0 + o * PRICE.1) / 1e6,
        _ => estimate,
    };
    // Muse Spark 1.3 has the same list price as Muse Spark Open, and is billed to the Model API ledger.
    if *ai == Ai::Meta {
        lock(&s.db).execute("INSERT INTO meta_api_spend (model,usd,created) VALUES (?1,?2,?3)", params![model, cost, now()])?;
    } else {
        lock(&s.db).execute("INSERT INTO spend (usd,created,own) VALUES (?1,?2,?3)", params![cost, now(), ai.own()])?;
    }
    tracing::info!(agent, model, prompt_tokens = usage["prompt_tokens"].as_u64(), completion_tokens = usage["completion_tokens"].as_u64(),
        cost_usd = format!("{cost:.4}"), ms = started.elapsed().as_millis() as u64, own_key = ai.own(), "muse call");
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

pub fn extract_json(text: &str) -> Option<Value> {
    let text = text.rsplit_once("</think>").map(|(_, t)| t).unwrap_or(text);
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    serde_json::from_str(text.get(start..=end)?).ok().filter(Value::is_object)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Does Muse Spark Open on Baseten see images? `STUPID_MUSE_API_KEY` set; `cargo test live_image_input -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_image_input() {
        let _ = tracing_subscriber::fmt().try_init();
        let (s, _) = crate::tests_support::state_with_user();
        let mut cfg = crate::Config::load();
        cfg.muse_budget_usd = 1.0;
        let s = AppState { cfg: std::sync::Arc::new(cfg), ..s };
        let messages = [json!({ "role": "user", "content": [
            { "type": "text", "text": "In five words or fewer, what is in this picture?" },
            { "type": "image_url", "image_url": { "url": "https://raw.githubusercontent.com/github/explore/main/topics/rust/rust.png" } },
        ] })];
        match chat(&s, "image-test", &messages, None, &Ai::Workspace).await {
            Ok((data, cost)) => println!("IMAGE ok ${cost:.4} tokens={} answer={}", data["usage"]["prompt_tokens"], answer(&data).unwrap_or("?")),
            Err(e) => println!("IMAGE refused: {}", e.1),
        }
    }

    /// The agent on Muse Spark 1.3 through Meta's Model API: a picture and a tool call.
    /// `STUPID_META_API_KEY` set; `cargo test live_meta_brain -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_meta_brain() {
        let _ = tracing_subscriber::fmt().try_init();
        let _ = dotenvy::dotenv();
        let (s, _) = crate::tests_support::state_with_user();
        let mut cfg = crate::Config::load();
        cfg.meta_api_budget_usd = 1.0;
        let s = AppState { cfg: std::sync::Arc::new(cfg), ..s };
        let tools = crate::tools::specs();
        let messages = [json!({ "role": "user", "content": [
            { "type": "text", "text": "A customer sent this picture and asks how much it costs. You don't know the price." },
            { "type": "image_url", "image_url": { "url": "https://raw.githubusercontent.com/github/explore/main/topics/rust/rust.png" } },
        ] })];
        let (data, cost) = chat(&s, "meta-test", &messages, Some(&tools), &Ai::Meta).await.unwrap();
        println!("META ${cost:.4} {}", data["choices"][0]["message"]);
    }

    /// Post ideas with a picture, and the text-only retry when a picture can't be fetched. `cargo test live_ideas_pictures -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_ideas_pictures() {
        let (s, _) = crate::tests_support::state_with_user();
        let mut cfg = crate::Config::load();
        cfg.muse_budget_usd = 1.0;
        let s = AppState { cfg: std::sync::Arc::new(cfg), ..s };
        let system = AGENTS.iter().find(|(n, _)| *n == "ideas").unwrap().1;
        let context = json!({ "accounts": [{ "bio": "Rust stickers and tees", "followers": 120, "posts": [{ "caption": "New Rust crab sticker drop", "likes": 40, "comments": 6 }] }] });
        for picture in ["https://raw.githubusercontent.com/github/explore/main/topics/rust/rust.png", "https://upload.wikimedia.org/wikipedia/commons/4/45/A_small_cup_of_coffee.JPG"] {
            let (result, cost) = ideas(&s, system, &context, &[picture.to_string()], &Ai::Workspace).await.unwrap();
            println!("IDEAS looked_at={} ${cost:.4} first why: {}", result["looked_at"], result["ideas"][0]["why"]);
        }
    }

    #[test]
    fn the_person_picks_which_model_runs_their_agents() {
        let (s, u) = crate::tests_support::state_with_user();
        let with = |muse: &str, meta: &str| {
            let mut cfg = crate::Config::load();
            (cfg.muse_key, cfg.meta_api_key) = (muse.into(), meta.into());
            AppState { cfg: std::sync::Arc::new(cfg), ..s.clone() }
        };
        let both = with("baseten", "meta");
        assert_eq!(ai(&both, &u.id).unwrap(), Ai::Workspace);
        lock(&s.db).execute("UPDATE users SET ai_brain='meta' WHERE id=?1", [&u.id]).unwrap();
        assert_eq!(ai(&both, &u.id).unwrap(), Ai::Meta);
        assert_eq!(Ai::Meta.model(&both), "muse-spark-1.3");
        // Picked Meta, but this server has no Model API key: Muse Spark Open runs instead.
        assert_eq!(ai(&with("baseten", ""), &u.id).unwrap(), Ai::Workspace);
        // Only the Model API is set up: it runs whatever was picked.
        lock(&s.db).execute("UPDATE users SET ai_brain='open' WHERE id=?1", [&u.id]).unwrap();
        assert_eq!(ai(&with("", "meta"), &u.id).unwrap(), Ai::Meta);
        // Meta's runs are paid from the Model API budget.
        let mut cfg = crate::Config::load();
        (cfg.meta_api_key, cfg.meta_api_budget_usd) = ("meta".into(), 0.01);
        let capped = AppState { cfg: std::sync::Arc::new(cfg), ..s.clone() };
        assert!(ready(&capped, &Ai::Meta).unwrap());
        lock(&s.db).execute("INSERT INTO meta_api_spend (model,usd,created) VALUES ('muse-spark-1.3',0.01,0)", []).unwrap();
        assert!(!ready(&capped, &Ai::Meta).unwrap());
    }

    #[test]
    fn prompts_and_order_follow_the_persona() {
        let base = |n: &str| AGENTS.iter().find(|(a, _)| *a == n).unwrap().1;
        let leads = |p| system_for("leads", base("leads"), p);
        assert!(leads(Some("creator")).contains("sponsorship") && leads(Some("creator")).contains("buying intent"));
        assert!(leads(Some("business")).contains("buying intent") && !leads(Some("business")).contains("sponsorship"));
        assert_eq!(leads(None), format!("{} {LEAD_RULES}", base("leads")));
        for p in [Some("creator"), Some("business"), None] {
            assert!(leads(p).contains("Never invent people") && leads(p).contains("Never guess sensitive traits") && leads(p).contains("hours_ago is 24"));
            assert!(system_for("replies", base("replies"), p).contains("Never promise prices"));
            assert_eq!(system_for("ads", base("ads"), p), base("ads"));
        }
        assert!(system_for("replies", base("replies"), Some("creator")).starts_with("The owner is a creator"));
        assert_eq!(system_for("replies", base("replies"), None), base("replies"));
        assert_eq!(order(Some("creator")), ["reels", "ideas", "leads", "replies", "ads"]);
        assert_eq!(order(Some("business")), ["replies", "leads", "ads", "ideas", "reels"]);
        assert_eq!(order(None), ["leads", "ideas", "replies", "reels", "ads"]);
    }

    #[test]
    fn runs_name_the_models_that_made_them() {
        let open = |agent: &str, result: Value| models(agent, &result, &Ai::Workspace);
        assert_eq!(open("leads", json!({ "leads": [] })), ["Muse Spark Open"]);
        assert_eq!(models("ideas", &json!({}), &Ai::Meta), ["Muse Spark 1.3"]);
        assert_eq!(models("ideas", &json!({}), &Ai::Own("k".into())), ["Muse Spark Open"]);
        assert_eq!(open("reels", json!({ "from_captions_only": false })), ["Muse Wonder"]);
        assert_eq!(open("reels", json!({ "from_captions_only": true })), ["Muse Spark Open"]);
        assert_eq!(open("ads", json!({ "creative_pack": [{ "box": [1, 2, 3, 4], "note": null }] })), ["Muse Spark Open", "SAM 3.1"]);
        assert_eq!(open("ads", json!({ "creative_pack": [{ "box": null, "note": "SAM 3.1 didn't find \"mug\" in this picture, so the crops are centred." }] })), ["Muse Spark Open", "SAM 3.1"]);
        // SAM 3.1 never answered (budget spent): the pack holds centred crops only.
        assert_eq!(open("ads", json!({ "creative_pack": [{ "box": null, "note": "The Meta Model API budget is spent." }] })), ["Muse Spark Open"]);
        assert_eq!(open("ads", json!({ "creative_pack": [] })), ["Muse Spark Open"]);
    }

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
