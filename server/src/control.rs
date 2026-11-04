//! The owner's say over each agent: off (never runs), ask (asks before preparing anything) or draft
//! (prepares and waits for a tap), plus one sentence of instruction that goes into that agent's prompt.
use crate::{lock, user, ApiResult, AppError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub const AGENTS: [&str; 5] = ["leads", "ideas", "replies", "reels", "ads"];
pub const MAX_NOTE: usize = 280;
/// The question an agent in ask mode puts to the owner before drafting a reply.
pub const ASK_FIRST: &str = "Shall I draft a reply to this message?";

/// This agent's mode and note; `draft` with no note until the owner changes it.
pub fn get(db: &rusqlite::Connection, user_id: &str, agent: &str) -> rusqlite::Result<(String, String)> {
    Ok(db.query_row("SELECT mode,note FROM agent_controls WHERE user_id=?1 AND agent=?2", params![user_id, agent], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?.unwrap_or_else(|| ("draft".into(), String::new())))
}

/// Every agent's control: `{"leads": {"mode": "draft", "note": ""}, …}`.
pub fn all(db: &rusqlite::Connection, user_id: &str) -> rusqlite::Result<Value> {
    let mut out = serde_json::Map::new();
    for agent in AGENTS {
        let (mode, note) = get(db, user_id, agent)?;
        out.insert(agent.into(), json!({ "mode": mode, "note": note }));
    }
    Ok(Value::Object(out))
}

/// The prompt line that carries the owner's note. Safety rules come first and still win.
pub fn note_line(note: &str) -> String {
    if note.is_empty() { String::new() } else { " owner_note is the owner's own instruction for this job; follow it unless it breaks a rule above.".into() }
}

#[derive(Deserialize)]
pub struct Control {
    mode: String,
    #[serde(default)]
    note: String,
}

/// PUT /api/agents/{name}/control {mode, note}.
pub async fn save(State(s): State<AppState>, headers: HeaderMap, Path(agent): Path<String>, Json(body): Json<Control>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    if !AGENTS.contains(&agent.as_str()) {
        return Err(AppError::new(404, "Unknown agent."));
    }
    if !["off", "ask", "draft"].contains(&body.mode.as_str()) {
        return Err(AppError::new(400, "Choose off, ask or draft."));
    }
    let note = body.note.trim();
    if note.chars().count() > MAX_NOTE {
        return Err(AppError::new(400, "Keep the note to one sentence, under 280 characters."));
    }
    lock(&s.db).execute("INSERT INTO agent_controls (user_id,agent,mode,note) VALUES (?1,?2,?3,?4)
                         ON CONFLICT(user_id,agent) DO UPDATE SET mode=excluded.mode, note=excluded.note", params![u.id, agent, body.mode, note])?;
    Ok(Json(json!({ "agent": agent, "mode": body.mode, "note": note })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{signed_in, state_with_user};

    #[tokio::test]
    async fn controls_default_to_draft_and_save_per_agent() {
        let (s, _) = state_with_user();
        let h = signed_in(&s);
        assert_eq!(all(&lock(&s.db), "u").unwrap()["leads"], json!({ "mode": "draft", "note": "" }));
        let put = |agent: &str, mode: &str, note: String| save(State(s.clone()), h.clone(), Path(agent.into()), Json(Control { mode: mode.into(), note }));
        let Json(saved) = put("replies", "ask", " Always sign off as Asha. ".into()).await.unwrap();
        assert_eq!(saved, json!({ "agent": "replies", "mode": "ask", "note": "Always sign off as Asha." }));
        assert_eq!(put("ideas", "off", String::new()).await.unwrap().0["mode"], "off");
        let controls = all(&lock(&s.db), "u").unwrap();
        assert_eq!((controls["replies"]["mode"].as_str(), controls["ideas"]["mode"].as_str(), controls["ads"]["mode"].as_str()), (Some("ask"), Some("off"), Some("draft")));
        assert_eq!(put("replies", "maybe", String::new()).await.unwrap_err().0, 400);
        assert_eq!(put("replies", "draft", "x".repeat(281)).await.unwrap_err().0, 400);
        assert_eq!(put("nope", "draft", String::new()).await.unwrap_err().0, 404);
        assert_eq!(get(&lock(&s.db), "u", "replies").unwrap(), ("ask".into(), "Always sign off as Asha.".into()), "a refused save changes nothing");
        assert_eq!(all(&lock(&s.db), "someone").unwrap()["replies"], json!({ "mode": "draft", "note": "" }), "one owner's controls never apply to another");
    }

    #[tokio::test]
    async fn off_never_runs_and_ask_waits_for_the_owner() {
        let (s, u) = state_with_user();
        let h = signed_in(&s);
        let set = |agent: &str, mode: &str| lock(&s.db).execute("INSERT OR REPLACE INTO agent_controls (user_id,agent,mode,note) VALUES ('u',?1,?2,'')", [agent, mode]).unwrap();
        set("leads", "off");
        let off = crate::agents::start(&s, crate::user_by_id(&s, "u").unwrap(), "leads").await.unwrap_err();
        assert_eq!((off.0.as_u16(), off.1.as_str()), (409, "This agent is off. Turn it on to run it."));
        let Json(list) = crate::agents::list(State(s.clone()), h.clone()).await.unwrap();
        assert_eq!(list["controls"]["leads"], json!({ "mode": "off", "note": "" }));
        assert_eq!(list["controls"]["replies"], json!({ "mode": "draft", "note": "" }));

        // Muse can't start an ask-first agent for the owner.
        set("ideas", "ask");
        let refused = crate::mcp::call_tool(&s, u, "run_agent", &json!({ "name": "ideas" })).await.unwrap_err();
        assert!(refused.contains("asked to be asked first"), "{refused}");

        // A replies ticket already open when the owner turns Reply drafts off ends without a draft.
        {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (id,kind,asset_id,sender,sender_name,text,created) VALUES (1,'whatsapp','p1','9198','Asha','price?',?1)", [crate::now()]).unwrap();
            db.execute("INSERT INTO triggers (id,user_id,thread_id,source,ref,event_id,created) VALUES (1,'u',1,'inbox','a',1,?1)", [crate::now()]).unwrap();
            db.execute("INSERT INTO tickets (id,user_id,thread_id,trigger_id,job,created) VALUES (1,'u',1,1,'replies',?1)", [crate::now()]).unwrap();
        }
        set("replies", "off");
        crate::executor::work(&s, 1).await.unwrap();
        let (state, said): (String, String) = lock(&s.db).query_row("SELECT state,(SELECT text FROM reports WHERE ticket_id=1 ORDER BY id DESC LIMIT 1) FROM tickets WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((state.as_str(), said.as_str()), ("ended", "Reply drafts is off."));

        // The ask-first question is marked for Home, and saying yes to it isn't kept as a fact.
        {
            let db = lock(&s.db);
            db.execute("INSERT INTO tickets (id,user_id,thread_id,trigger_id,job,created) VALUES (2,'u',1,1,'replies',?1)", [crate::now()]).unwrap();
            db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (2,'question',?1,?2),(2,'waiting','Waiting for your answer.',?2)", params![ASK_FIRST, crate::now()]).unwrap();
        }
        let Json(home) = crate::attention::home(State(s.clone()), h.clone()).await.unwrap();
        assert_eq!((home["needs"][0]["question"].as_str(), home["needs"][0]["ask_first"].as_bool()), (Some(ASK_FIRST), Some(true)));
        let yes = serde_json::from_value(json!({ "text": "Yes" })).unwrap();
        assert_eq!(crate::attention::answer(State(s.clone()), h, Path(2), Json(yes)).await.unwrap().0["state"], "open");
        assert_eq!(crate::attention::facts(&lock(&s.db), "u").unwrap(), Vec::<Value>::new());
    }
}
