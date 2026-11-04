//! What the agent needs from the person, and what it did. "Needs you" holds only ready drafts and open
//! questions; a healthy state is empty. Answering a question resumes its ticket; nothing here sends.
use crate::{control, executor, lock, now, user, ApiResult, AppError, AppState, User};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

pub async fn home(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let ids: Vec<String> = u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect();
    let db = lock(&s.db);
    let (proactive, rules): (bool, String) = db.query_row("SELECT agent_proactive,agent_rules FROM users WHERE id=?1", [&u.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    // The newest draft per message, while the message can still be answered and nobody has.
    let mut stmt = db.prepare(
        "SELECT d.id,d.event_id,d.text,d.source,d.created,e.kind,e.asset_id,e.sender,e.sender_name,e.text,l.answer,l.created,d.styled,e.matched_json FROM drafts d JOIN events e ON e.id=d.event_id
         LEFT JOIN learned l ON l.id=d.learned_id AND l.user_id=d.user_id
         WHERE d.id IN (SELECT MAX(id) FROM drafts WHERE user_id=?1 GROUP BY event_id)
           AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.event_id=d.event_id AND r.error IS NULL)
           AND (e.kind='instagram_comment' OR e.created>?2)
         ORDER BY d.id DESC LIMIT 20")?;
    let drafts = stmt.query_map(params![u.id, now() - 86_400], |r| Ok((r.get::<_, String>(6)?, json!({ "type": "draft", "id": r.get::<_, i64>(0)?,
        "event_id": r.get::<_, i64>(1)?, "text": r.get::<_, String>(2)?, "source": r.get::<_, String>(3)?, "created": r.get::<_, i64>(4)?,
        "message": { "kind": r.get::<_, String>(5)?, "sender": r.get::<_, String>(7)?, "sender_name": r.get::<_, Option<String>>(8)?, "text": r.get::<_, String>(9)? },
        "styled": r.get::<_, bool>(12)?, "matched_post": crate::tools::matched(r.get(13)?, &u.id),
        "used": r.get::<_, Option<String>>(10)?.map(|a| -> rusqlite::Result<Value> { Ok(json!({ "answer": a, "told": r.get::<_, i64>(11)? })) }).transpose()? }))))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter().filter(|(asset, _)| ids.contains(asset)).map(|(_, v)| v);
    let mut stmt = db.prepare(
        "SELECT k.id,q.text,q.created,e.kind,e.sender,e.sender_name,e.text FROM tickets k
         JOIN reports q ON q.id=(SELECT MAX(id) FROM reports WHERE ticket_id=k.id AND kind='question')
         LEFT JOIN triggers t ON t.id=k.trigger_id LEFT JOIN events e ON e.id=t.event_id
         WHERE k.user_id=?1 AND k.state='open' AND (SELECT kind FROM reports WHERE ticket_id=k.id ORDER BY id DESC LIMIT 1)='waiting'
         ORDER BY k.id DESC LIMIT 10")?;
    let questions = stmt.query_map([&u.id], |r| Ok(json!({ "type": "question", "id": r.get::<_, i64>(0)?, "question": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)?,
        "ask_first": r.get::<_, String>(1)? == control::ASK_FIRST,
        "message": r.get::<_, Option<String>>(3)?.map(|kind| -> rusqlite::Result<Value> { Ok(json!({ "kind": kind, "sender": r.get::<_, String>(4)?, "sender_name": r.get::<_, Option<String>>(5)?, "text": r.get::<_, String>(6)? })) }).transpose()? })))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = db.prepare(
        "SELECT k.id,k.job,k.state,k.created,e.kind,e.sender,e.sender_name FROM tickets k LEFT JOIN triggers t ON t.id=k.trigger_id LEFT JOIN events e ON e.id=t.event_id
         WHERE k.user_id=?1 ORDER BY k.id DESC LIMIT 15")?;
    let mut tickets = stmt.query_map([&u.id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "job": r.get::<_, String>(1)?, "state": r.get::<_, String>(2)?,
        "created": r.get::<_, i64>(3)?, "message": r.get::<_, Option<String>>(4)?.map(|kind| -> rusqlite::Result<Value> { Ok(json!({ "kind": kind, "sender": r.get::<_, String>(5)?, "sender_name": r.get::<_, Option<String>>(6)? })) }).transpose()?, "reports": [] })))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = db.prepare("SELECT kind,text,created FROM reports WHERE ticket_id=?1 ORDER BY id")?;
    for t in &mut tickets {
        t["reports"] = json!(stmt.query_map([t["id"].as_i64()], |r| Ok(json!({ "kind": r.get::<_, String>(0)?, "text": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)? })))?
            .collect::<Result<Vec<_>, _>>()?);
    }
    let needs: Vec<Value> = questions.into_iter().chain(drafts).collect();
    let (watching, last_checked) = watching(&db, &u)?;
    let facts = facts(&db, &u.id)?;
    Ok(Json(json!({ "needs": needs, "tickets": tickets, "proactive": proactive, "rules": rules, "facts": facts, "watching": watching, "last_checked": last_checked })))
}

/// The most facts kept per person; the oldest goes first.
pub const MAX_FACTS: i64 = 50;

/// Keep what the owner told the agent, once per question; the same question again replaces the old answer.
pub(crate) fn learn(db: &rusqlite::Connection, user_id: &str, question: &str, answer: &str) -> rusqlite::Result<()> {
    db.execute("INSERT INTO learned (user_id,question,answer,created) VALUES (?1,?2,?3,?4)
                ON CONFLICT(user_id,question) DO UPDATE SET answer=excluded.answer, created=excluded.created", params![user_id, question, answer, now()])?;
    db.execute("DELETE FROM learned WHERE user_id=?1 AND id NOT IN (SELECT id FROM learned WHERE user_id=?1 ORDER BY created DESC, id DESC LIMIT ?2)", params![user_id, MAX_FACTS])?;
    Ok(())
}

/// What the owner told the agent, newest first: `[{id, question, answer, created}]`.
pub fn facts(db: &rusqlite::Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT id,question,answer,created FROM learned WHERE user_id=?1 ORDER BY created DESC, id DESC")?;
    let rows = stmt.query_map([user_id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "question": r.get::<_, String>(1)?, "answer": r.get::<_, String>(2)?, "created": r.get::<_, i64>(3)? })))?;
    rows.collect()
}

/// The facts as the model reads them: owner text with the day it was told and the id a draft cites.
pub fn facts_for_model(db: &rusqlite::Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    Ok(facts(db, user_id)?.into_iter().map(|f| json!({ "fact_id": f["id"], "told_on": f["created"].as_i64().map(|t| executor::today(t)[..10].to_string()),
        "question": f["question"], "answer": f["answer"] })).collect())
}

/// DELETE /api/agent/facts/{id}: the agent forgets one thing it was told. Drafts that used it keep their text.
pub async fn forget(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let db = lock(&s.db);
    if db.execute("DELETE FROM learned WHERE id=?1 AND user_id=?2", params![id, u.id])? == 0 {
        return Err(AppError::new(404, "That fact is already gone."));
    }
    Ok(Json(json!({ "facts": facts(&db, &u.id)? })))
}

/// The switched-on channels the agent reads, and when a message last arrived or Stupid last read them from Meta.
fn watching(db: &rusqlite::Connection, u: &User) -> rusqlite::Result<(Vec<&'static str>, Option<i64>)> {
    let channels: Vec<&str> = ["whatsapp", "messenger", "instagram"].into_iter().filter(|k| !u.selected_assets(k).is_empty()).collect();
    let ids: Vec<String> = channels.iter().flat_map(|k| u.selected_assets(k)).map(|a| a.id.clone()).collect();
    let pulled: Option<i64> = db.query_row("SELECT last_pull FROM users WHERE id=?1", [&u.id], |r| r.get(0))?;
    let arrived: Option<i64> = db.query_row("SELECT MAX(created) FROM events WHERE asset_id IN (SELECT value FROM json_each(?1))", [json!(ids).to_string()], |r| r.get(0))?;
    Ok((channels, pulled.max(arrived)))
}

#[derive(Deserialize)]
pub struct Answer {
    #[serde(default)]
    text: String,
    #[serde(default)]
    skip: bool,
}

/// The person answers the agent's one question, or skips it. An answer resumes the ticket on its thread's worker.
pub async fn answer(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<i64>, Json(body): Json<Answer>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let text = body.text.trim();
    if !body.skip && !(1..=1000).contains(&text.chars().count()) {
        return Err(AppError::new(400, "Write an answer of up to 1000 characters, or skip the question."));
    }
    let thread = {
        let db = lock(&s.db);
        let waiting: Option<i64> = db.query_row(
            "SELECT thread_id FROM tickets k WHERE id=?1 AND user_id=?2 AND state='open' AND (SELECT kind FROM reports WHERE ticket_id=k.id ORDER BY id DESC LIMIT 1)='waiting'",
            params![id, u.id], |r| r.get(0)).optional()?;
        let thread = waiting.ok_or_else(|| AppError::new(404, "That question was already answered."))?;
        if body.skip {
            db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (?1,'dropped','You skipped the question.',?2)", params![id, now()])?;
            db.execute("UPDATE tickets SET state='ended',ended=?2 WHERE id=?1", params![id, now()])?;
            return Ok(Json(json!({ "state": "ended" })));
        }
        db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (?1,'answer',?2,?3)", params![id, text, now()])?;
        // Remembered past this ticket, so the agent asks once.
        let question: Option<String> = db.query_row("SELECT text FROM reports WHERE ticket_id=?1 AND kind='question' ORDER BY id DESC LIMIT 1", [id], |r| r.get(0)).optional()?;
        if let Some(q) = question.filter(|q| q != control::ASK_FIRST) {
            learn(&db, &u.id, &q, text)?;
        }
        db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (?1,'progress','Working with your answer.',?2)", params![id, now()])?;
        thread
    };
    let state = s.clone();
    s.queue.push(thread, Duration::ZERO, move || {
        let state = state.clone();
        async move {
            if let Err(e) = executor::work(&state, id).await {
                tracing::error!("agent resume {id}: {}", e.1);
            }
        }
    });
    Ok(Json(json!({ "state": "open" })))
}

#[derive(Deserialize)]
pub struct Settings {
    proactive: bool,
    rules: String,
}

/// The one switch and the owner's rules in plain words, which the agent reads as prompt text.
pub async fn settings(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<Settings>) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let rules = body.rules.trim();
    if rules.chars().count() > 2000 {
        return Err(AppError::new(400, "Keep your rules under 2000 characters."));
    }
    lock(&s.db).execute("UPDATE users SET agent_proactive=?1, agent_rules=?2 WHERE id=?3", params![body.proactive, rules, u.id])?;
    Ok(Json(json!({ "proactive": body.proactive, "rules": rules })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{signed_in, state_with_user};

    #[tokio::test]
    async fn needs_you_holds_only_ready_drafts_and_open_questions() {
        let (s, _) = state_with_user();
        let h = signed_in(&s);
        {
            let db = lock(&s.db);
            for (id, created) in [(1, now() - 60), (2, now() - 90_000), (3, now() - 60)] {
                db.execute("INSERT INTO events (id,kind,asset_id,sender,sender_name,text,created) VALUES (?1,'whatsapp','p1','9198','Asha','price?',?2)", params![id, created]).unwrap();
                db.execute("INSERT INTO drafts (user_id,event_id,text,source,created) VALUES ('u',?1,'It is 450.','agent',?2)", params![id, now()]).unwrap();
            }
            db.execute("INSERT INTO replies (event_id,user_id,text,created) VALUES (3,'u','sent',?1)", [now()]).unwrap();
            db.execute("INSERT INTO triggers (id,user_id,thread_id,source,ref,event_id,created) VALUES (1,'u',1,'inbox','wa:x',1,?1)", [now()]).unwrap();
            db.execute("INSERT INTO tickets (id,user_id,thread_id,trigger_id,job,created) VALUES (1,'u',1,1,'replies',?1)", [now()]).unwrap();
            for (kind, text) in [("progress", "Asks the price."), ("question", "What does the tote cost?"), ("waiting", "Waiting for your answer.")] {
                db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (1,?1,?2,?3)", params![kind, text, now()]).unwrap();
            }
        }
        let Json(home) = home(State(s.clone()), h.clone()).await.unwrap();
        let needs = home["needs"].as_array().unwrap();
        assert_eq!(needs.len(), 2, "the old message and the replied one are left out: {needs:?}");
        assert_eq!(needs[0]["type"], "question");
        assert_eq!(needs[0]["question"], "What does the tote cost?");
        assert_eq!(needs[1]["event_id"], 1);
        assert_eq!(home["tickets"][0]["reports"].as_array().unwrap().len(), 3);
        assert_eq!(home["proactive"], true);

        let skipped = answer(State(s.clone()), h.clone(), Path(1), Json(Answer { text: String::new(), skip: true })).await.unwrap();
        assert_eq!(skipped.0["state"], "ended");
        assert!(answer(State(s.clone()), h.clone(), Path(1), Json(Answer { text: "450".into(), skip: false })).await.is_err(), "answered once");
        let Json(after) = super::home(State(s.clone()), h).await.unwrap();
        assert_eq!(after["needs"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn home_says_what_the_agent_watches_and_when_it_last_looked() {
        let (s, _) = state_with_user();
        let h = signed_in(&s);
        let Json(home) = super::home(State(s.clone()), h.clone()).await.unwrap();
        assert_eq!((home["watching"].clone(), home["last_checked"].clone()), (json!(["whatsapp"]), Value::Null));
        let t = now();
        lock(&s.db).execute("INSERT INTO events (kind,asset_id,sender,text,created) VALUES ('whatsapp','p1','9198','hi',?1)", [t - 100]).unwrap();
        // Messages on an account that isn't switched on don't count.
        lock(&s.db).execute("INSERT INTO events (kind,asset_id,sender,text,created) VALUES ('whatsapp','other','9198','hi',?1)", [t]).unwrap();
        assert_eq!(super::home(State(s.clone()), h.clone()).await.unwrap().0["last_checked"], t - 100);
        lock(&s.db).execute("UPDATE users SET last_pull=?1 WHERE id='u'", [t - 5]).unwrap();
        assert_eq!(super::home(State(s.clone()), h.clone()).await.unwrap().0["last_checked"], t - 5);
        lock(&s.db).execute("UPDATE users SET selected_json='[]' WHERE id='u'", []).unwrap();
        assert_eq!(super::home(State(s.clone()), h).await.unwrap().0["watching"], json!([]));
    }

    #[tokio::test]
    async fn an_answer_is_remembered_used_in_the_next_draft_and_deletable() {
        let (s, u) = state_with_user();
        let h = signed_in(&s);
        {
            let db = lock(&s.db);
            for id in [1, 2] {
                db.execute("INSERT INTO events (id,kind,asset_id,sender,sender_name,text,created) VALUES (?1,'whatsapp','p1','9198','Asha','price of the tote?',?2)", params![id, now()]).unwrap();
                db.execute("INSERT INTO triggers (id,user_id,thread_id,source,ref,event_id,created) VALUES (?1,'u',1,'inbox',?1,?1,?2)", params![id, now()]).unwrap();
                db.execute("INSERT INTO tickets (id,user_id,thread_id,trigger_id,job,created) VALUES (?1,'u',1,?1,'replies',?2)", params![id, now()]).unwrap();
            }
            for (kind, text) in [("question", "What does the tote cost?"), ("waiting", "Waiting for your answer.")] {
                db.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (1,?1,?2,?3)", params![kind, text, now()]).unwrap();
            }
        }
        assert_eq!(answer(State(s.clone()), h.clone(), Path(1), Json(Answer { text: " ₹450 ".into(), skip: false })).await.unwrap().0["state"], "open");
        let Json(home) = super::home(State(s.clone()), h.clone()).await.unwrap();
        let fact = home["facts"][0].clone();
        assert_eq!((fact["question"].as_str(), fact["answer"].as_str()), (Some("What does the tote cost?"), Some("₹450")));

        // The next message's ticket reads it, with the day it was told.
        let input = executor::context(&lock(&s.db), "u", 2, 2).unwrap();
        assert_eq!(input["owner_facts"][0]["answer"], "₹450");
        assert_eq!(input["owner_facts"][0]["told_on"].as_str().unwrap(), &executor::today(now())[..10]);
        assert_eq!(input["owner_answers"], json!([]), "this ticket's own answers stay its own");

        // A draft that relies on it says so on its card; a fact id that isn't theirs is dropped.
        crate::tools::save_draft(&s, &u, Some(2), 2, "It's ₹450.", "agent", fact["id"].as_i64()).unwrap();
        crate::tools::save_draft(&s, &u, Some(2), 1, "Hello.", "agent", Some(999)).unwrap();
        let Json(home) = super::home(State(s.clone()), h.clone()).await.unwrap();
        let used: Vec<&Value> = home["needs"].as_array().unwrap().iter().map(|n| &n["used"]).collect();
        assert_eq!(used, [&Value::Null, &json!({ "answer": "₹450", "told": fact["created"] })]);

        // The same question again replaces the answer; deleting forgets it, and only the owner can.
        lock(&s.db).execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (2,'question','What does the tote cost?',?1),(2,'waiting','Waiting for your answer.',?1)", [now()]).unwrap();
        assert_eq!(answer(State(s.clone()), h.clone(), Path(2), Json(Answer { text: "₹500".into(), skip: false })).await.unwrap().0["state"], "open");
        let all = facts(&lock(&s.db), "u").unwrap();
        assert_eq!((all.len(), all[0]["answer"].as_str()), (1, Some("₹500")));
        lock(&s.db).execute("INSERT INTO learned (user_id,question,answer,created) VALUES ('someone','q','a',1)", []).unwrap();
        let other: i64 = lock(&s.db).query_row("SELECT id FROM learned WHERE user_id='someone'", [], |r| r.get(0)).unwrap();
        assert!(forget(State(s.clone()), h.clone(), Path(other)).await.is_err());
        let Json(left) = forget(State(s.clone()), h.clone(), Path(all[0]["id"].as_i64().unwrap())).await.unwrap();
        assert_eq!(left["facts"], json!([]));
        assert_eq!(executor::context(&lock(&s.db), "u", 2, 2).unwrap()["owner_facts"], json!([]));
        assert!(forget(State(s), h, Path(all[0]["id"].as_i64().unwrap())).await.is_err(), "already gone");
    }

    #[test]
    fn facts_are_capped() {
        let (s, _) = state_with_user();
        let db = lock(&s.db);
        for i in 0..MAX_FACTS + 3 {
            learn(&db, "u", &format!("q{i}"), "a").unwrap();
        }
        let kept = facts(&db, "u").unwrap();
        assert_eq!(kept.len() as i64, MAX_FACTS);
        assert_eq!(kept[0]["question"], format!("q{}", MAX_FACTS + 2), "newest kept, oldest dropped");
    }

    #[tokio::test]
    async fn settings_keep_the_switch_and_rules() {
        let (s, _) = state_with_user();
        let h = signed_in(&s);
        let _ = settings(State(s.clone()), h.clone(), Json(Settings { proactive: false, rules: " Closed Sundays. ".into() })).await.unwrap();
        let Json(home) = home(State(s.clone()), h.clone()).await.unwrap();
        assert_eq!((home["proactive"].as_bool(), home["rules"].as_str()), (Some(false), Some("Closed Sundays.")));
        assert!(settings(State(s), h, Json(Settings { proactive: true, rules: "x".repeat(2001) })).await.is_err());
    }
}
