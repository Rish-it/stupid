//! The agent's tools, one registry for the executor and for Muse over MCP. Read tools look; prepare tools
//! save a draft, an idea, ad advice or one question for the person. None of them can send, post or spend:
//! a draft reaches a customer only when the person taps Send in Stupid's Inbox.
use crate::{agents, lock, meta, now, AppState, User};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Tool results are cut to this many characters before they go back to the model.
const MAX_RESULT_CHARS: usize = 8000;

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description,
        "parameters": { "type": "object", "properties": properties, "required": required } } })
}

/// Every tool, as function schemas for Muse's tool calling.
pub fn specs() -> Vec<Value> {
    let none = json!({});
    vec![
        tool("get_today", "Counts for today: messages waiting for a reply in the last 24 hours, drafts waiting for the owner, open tasks.", none.clone(), &[]),
        tool("list_inbox", "Recent messages and comments not yet replied to, newest first.", none.clone(), &[]),
        tool("read_thread", "The whole conversation that one inbox message belongs to, oldest first.", json!({ "event_id": { "type": "integer" } }), &["event_id"]),
        tool("get_ads", "Last 7 days of results for the owner's ad accounts.", none.clone(), &[]),
        tool("get_instagram", "The owner's Instagram bio, followers and recent posts with likes and comments.", none.clone(), &[]),
        tool("list_leads", "The latest leads found by Lead finder.", none.clone(), &[]),
        tool("get_ad_advice", "The Ad watcher's latest advice on the owner's campaigns: pause, keep, scale or fix, and why.", none.clone(), &[]),
        tool("watch_video", "Muse Wonder watches one of the owner's own Instagram videos (an id from get_instagram) and answers a question about it.",
            json!({ "media_id": { "type": "string" }, "question": { "type": "string" } }), &["media_id", "question"]),
        tool("list_drafts", "Reply drafts already prepared, so you don't repeat one.", none.clone(), &[]),
        tool("transcribe_voice_note", "The words of a customer's voice note, or what their photo or video shows (an inbox event id), working it out now if that hasn't happened yet.",
            json!({ "event_id": { "type": "integer" } }), &["event_id"]),
        tool("find_subject", "SAM 3.1 finds a subject (a short noun like \"ceramic mug\") in one of the owner's own Instagram pictures (an id from get_instagram) and returns its box in pixels.",
            json!({ "media_id": { "type": "string" }, "subject": { "type": "string" } }), &["media_id", "subject"]),
        tool("save_reply_draft", "Save a reply draft for one inbox message. The owner reviews it and taps Send; this sends nothing.",
            json!({ "event_id": { "type": "integer" }, "text": { "type": "string", "description": "The reply, at most 1000 characters." } }), &["event_id", "text"]),
        tool("save_idea", "Save one post idea for the owner.", json!({ "hook": { "type": "string" }, "caption": { "type": "string" },
            "format": { "type": "string", "enum": ["reel", "carousel", "photo", "story"] }, "why": { "type": "string" } }), &["hook", "caption", "format", "why"]),
        tool("save_ad_advice", "Save one piece of advice about a campaign. Nothing in Ads changes.", json!({ "campaign": { "type": "string" },
            "do": { "type": "string", "enum": ["pause", "keep", "scale", "fix"] }, "why": { "type": "string" } }), &["campaign", "do", "why"]),
        tool("ask_person", "Ask the owner one concrete question when a fact you need (a price, stock, a date) is missing. Don't guess instead.",
            json!({ "question": { "type": "string" } }), &["question"]),
    ]
}

/// Whether a tool prepares work for the person, rather than only reading.
pub fn prepares(name: &str) -> bool {
    matches!(name, "save_reply_draft" | "save_idea" | "save_ad_advice" | "ask_person")
}

fn text_arg(args: &Value, key: &str, max: usize) -> Result<String, String> {
    let v = args[key].as_str().map(str::trim).unwrap_or_default();
    if v.is_empty() || v.chars().count() > max {
        return Err(format!("`{key}` must be 1 to {max} characters."));
    }
    Ok(v.to_string())
}

/// Ids of the accounts the person has switched on.
fn selected_ids(u: &User) -> Vec<String> {
    u.assets.iter().filter(|a| u.selected.contains(&a.key)).map(|a| a.id.clone()).collect()
}

/// An inbox message, only if it reached one of the person's switched-on accounts.
fn own_event(s: &AppState, u: &User, event_id: i64) -> Result<(String, String), String> {
    let found: Option<(String, String)> = lock(&s.db)
        .query_row("SELECT asset_id,sender FROM events WHERE id=?1", [event_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional().map_err(|_| "Storage failed.".to_string())?;
    found.filter(|(asset, _)| selected_ids(u).contains(asset)).ok_or_else(|| format!("No message {event_id} in this inbox."))
}

fn report(s: &AppState, ticket: Option<i64>, kind: &str, text: &str) -> Result<(), String> {
    let ticket = ticket.ok_or("This tool needs a task.")?;
    lock(&s.db).execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (?1,?2,?3,?4)", params![ticket, kind, text, now()])
        .map(drop).map_err(|_| "Storage failed.".to_string())
}

fn rows(s: &AppState, sql: &str, args: impl rusqlite::Params, map: impl Fn(&rusqlite::Row) -> rusqlite::Result<Value>) -> Result<Vec<Value>, String> {
    let db = lock(&s.db);
    let mut stmt = db.prepare(sql).map_err(|_| "Storage failed.".to_string())?;
    let out = stmt.query_map(args, map).and_then(|r| r.collect::<Result<Vec<_>, _>>()).map_err(|_| "Storage failed.".to_string());
    out
}

/// Run one tool for the person. `ticket` is the task it works for, when there is one.
/// Errors come back in plain words, for the model or the person to read.
pub async fn call(s: &AppState, u: &User, ticket: Option<i64>, name: &str, args: &Value) -> Result<Value, String> {
    let result = match name {
        "get_today" => {
            let ids = selected_ids(u);
            let marks = vec!["?"; ids.len().max(1)].join(",");
            let mut values: Vec<rusqlite::types::Value> = ids.iter().cloned().map(Into::into).collect();
            if values.is_empty() {
                values.push(String::new().into());
            }
            values.push((now() - 86_400).into());
            let waiting = rows(s, &format!("SELECT COUNT(*) FROM events e WHERE asset_id IN ({marks}) AND created>?{} AND NOT EXISTS(SELECT 1 FROM replies r WHERE r.event_id=e.id AND r.error IS NULL)", values.len()),
                rusqlite::params_from_iter(values), |r| Ok(json!(r.get::<_, i64>(0)?)))?;
            let drafts = rows(s, "SELECT COUNT(*) FROM drafts d WHERE user_id=?1 AND NOT EXISTS(SELECT 1 FROM replies r WHERE r.event_id=d.event_id AND r.error IS NULL)", [&u.id], |r| Ok(json!(r.get::<_, i64>(0)?)))?;
            let open = rows(s, "SELECT COUNT(*) FROM tickets WHERE user_id=?1 AND state='open'", [&u.id], |r| Ok(json!(r.get::<_, i64>(0)?)))?;
            let apps: Vec<&str> = ["whatsapp", "messenger", "instagram", "ads"].into_iter().filter(|k| !u.selected_assets(k).is_empty()).collect();
            json!({ "connected": apps, "unreplied_last_24h": waiting[0], "drafts_waiting": drafts[0], "open_tasks": open[0],
                "note": if apps.is_empty() { "Nothing is connected yet." } else { "Counts come from Stupid's own records." } })
        }
        "list_inbox" => {
            let inbox = meta::fresh_inbox(s, u).await.map_err(|e| e.1)?;
            json!(agents::for_model(inbox.into_iter().filter(|m| m["replied"] != true).take(30).collect()))
        }
        "read_thread" => {
            let id = args["event_id"].as_i64().ok_or("`event_id` must be a number.")?;
            let (asset, sender) = own_event(s, u, id)?;
            let conversation = rows(s, "SELECT id,kind,sender_name,text,created FROM events WHERE asset_id=?1 AND sender=?2 ORDER BY created, id",
                params![asset, sender], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "sender_name": r.get::<_, Option<String>>(2)?,
                    "text": r.get::<_, String>(3)?, "created": r.get::<_, i64>(4)? })))?;
            json!(agents::for_model(conversation))
        }
        "get_ads" => meta::ads_data(s, u).await.map_err(|e| e.1)?,
        "get_instagram" => agents::instagram_context(&meta::instagram_data(s, u).await.map_err(|e| e.1)?),
        "list_leads" => {
            let found = rows(s, "SELECT result_json FROM agent_runs WHERE user_id=?1 AND agent='leads' AND status='done' ORDER BY id DESC LIMIT 1", [&u.id],
                |r| Ok(r.get::<_, Option<String>>(0)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Value::Null)))?;
            found.into_iter().next().map(|r| r["leads"].clone()).filter(Value::is_array).unwrap_or_else(|| json!([]))
        }
        "watch_video" => {
            let id = text_arg(args, "media_id", 64)?;
            let question = text_arg(args, "question", 500)?;
            let ig = meta::instagram_data(s, u).await.map_err(|e| e.1)?;
            let url = ig["accounts"].as_array().into_iter().flatten().flat_map(|a| a["media"].as_array().into_iter().flatten())
                .find(|m| m["id"] == id.as_str() && m["media_type"] == "VIDEO").and_then(|m| m["media_url"].as_str()).map(str::to_owned)
                .ok_or_else(|| format!("No video {id} on this Instagram account."))?;
            json!({ "notes": crate::reels::watch(s, &u.id, &url, &question).await.map_err(|e| e.1)? })
        }
        "transcribe_voice_note" => {
            let id = args["event_id"].as_i64().ok_or("`event_id` must be a number.")?;
            own_event(s, u, id)?;
            let (voice, pending, text): (bool, Option<String>, String) = lock(&s.db).query_row("SELECT voice,media,text FROM events WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|_| "Storage failed.".to_string())?;
            if let Some(media) = pending {
                let heard = crate::voice::hear(s, id).await;
                crate::voice::store(&lock(&s.db), id, crate::voice::media_kind(&media).0, heard).map_err(|_| "Storage failed.".to_string())?;
                let text: String = lock(&s.db).query_row("SELECT text FROM events WHERE id=?1", [id], |r| r.get(0)).map_err(|_| "Storage failed.".to_string())?;
                json!({ "transcript": text })
            } else if voice {
                json!({ "transcript": text })
            } else {
                return Err(format!("Message {id} is text, not a voice note."));
            }
        }
        "find_subject" => {
            let id = text_arg(args, "media_id", 64)?;
            let subject = text_arg(args, "subject", 60)?;
            let ig = meta::instagram_data(s, u).await.map_err(|e| e.1)?;
            let media = ig["accounts"].as_array().into_iter().flatten().flat_map(|a| a["media"].as_array().into_iter().flatten()).find(|m| m["id"] == id.as_str()).cloned()
                .ok_or_else(|| format!("No picture {id} on this Instagram account."))?;
            let url = if media["media_type"] == "VIDEO" { media["thumbnail_url"].as_str() } else { media["media_url"].as_str() }.ok_or("That post has no picture.")?;
            json!({ "box": crate::crops::find(s, &u.id, url, &subject).await.map_err(|e| e.1)? })
        }
        "get_ad_advice" => {
            let found = rows(s, "SELECT result_json,finished FROM agent_runs WHERE user_id=?1 AND agent='ads' AND status='done' ORDER BY id DESC LIMIT 1", [&u.id],
                |r| Ok(json!({ "advice": r.get::<_, Option<String>>(0)?.and_then(|v| serde_json::from_str::<Value>(&v).ok()), "finished": r.get::<_, Option<i64>>(1)? })))?;
            let mut latest = found.into_iter().next().unwrap_or_else(|| json!({ "advice": null, "note": "Ad watcher hasn't run yet." }));
            // The pack's boxes mean nothing without the pictures; Stupid shows those.
            if let Some(advice) = latest["advice"].as_object_mut() {
                advice.remove("creative_pack");
            }
            latest
        }
        "list_drafts" => json!(rows(s, "SELECT event_id,text,source,created FROM drafts WHERE user_id=?1 ORDER BY id DESC LIMIT 20", [&u.id],
            |r| Ok(json!({ "event_id": r.get::<_, i64>(0)?, "text": r.get::<_, String>(1)?, "source": r.get::<_, String>(2)?, "created": r.get::<_, i64>(3)? })))?),
        "save_reply_draft" => {
            let id = args["event_id"].as_i64().ok_or("`event_id` must be a number.")?;
            let text = text_arg(args, "text", 1000)?;
            save_draft(s, u, ticket, id, &text, "agent")?;
            json!({ "saved": true, "note": "Saved as a draft. The owner reviews it and taps Send in Stupid's Inbox." })
        }
        "save_idea" => {
            let idea = json!({ "hook": text_arg(args, "hook", 300)?, "caption": text_arg(args, "caption", 2200)?, "format": text_arg(args, "format", 20)?, "why": text_arg(args, "why", 500)? });
            report(s, ticket, "idea", &idea.to_string())?;
            json!({ "saved": true })
        }
        "save_ad_advice" => {
            let advice = json!({ "campaign": text_arg(args, "campaign", 200)?, "do": text_arg(args, "do", 10)?, "why": text_arg(args, "why", 500)? });
            report(s, ticket, "advice", &advice.to_string())?;
            json!({ "saved": true, "note": "Nothing in Ads changes until the owner does it." })
        }
        "ask_person" => {
            report(s, ticket, "question", &text_arg(args, "question", 300)?)?;
            json!({ "asked": true, "note": "Stop here; the owner will answer in Stupid." })
        }
        _ => return Err(format!("There is no tool called {name}.")),
    };
    Ok(result)
}

/// Keep a reply draft for one of the person's own messages. `source` says who wrote it: the agent, or Muse.
pub fn save_draft(s: &AppState, u: &User, ticket: Option<i64>, event_id: i64, text: &str, source: &str) -> Result<(), String> {
    own_event(s, u, event_id)?;
    lock(&s.db).execute("INSERT INTO drafts (user_id,ticket_id,event_id,text,source,created) VALUES (?1,?2,?3,?4,?5,?6)", params![u.id, ticket, event_id, text, source, now()])
        .map(drop).map_err(|_| "Storage failed.".to_string())
}

/// A tool result as the text the model reads, cut to size.
pub fn for_model(result: &Value) -> String {
    let text = result.to_string();
    if text.len() > MAX_RESULT_CHARS { text.chars().take(MAX_RESULT_CHARS).collect::<String>() + "…(cut)" } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::state_with_user;

    #[tokio::test]
    async fn prepare_tools_write_drafts_and_send_nothing() {
        let (s, u) = state_with_user();
        let event: i64 = {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (kind,asset_id,sender,sender_name,text,created) VALUES ('whatsapp','p1','9198','Asha','price?',?1)", [now()]).unwrap();
            db.last_insert_rowid()
        };
        let saved = call(&s, &u, None, "save_reply_draft", &json!({ "event_id": event, "text": "It's ₹450. Want one?" })).await.unwrap();
        assert_eq!(saved["saved"], true);
        let db = lock(&s.db);
        let (text, source): (String, String) = db.query_row("SELECT text,source FROM drafts WHERE event_id=?1", [event], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((text.as_str(), source.as_str()), ("It's ₹450. Want one?", "agent"));
        let replies: i64 = db.query_row("SELECT COUNT(*) FROM replies", [], |r| r.get(0)).unwrap();
        assert_eq!(replies, 0, "a draft is not a reply");
    }

    #[tokio::test]
    async fn tools_refuse_other_inboxes_and_bad_input() {
        let (s, u) = state_with_user();
        let other: i64 = {
            let db = lock(&s.db);
            db.execute("INSERT INTO events (kind,asset_id,sender,text,created) VALUES ('whatsapp','someone-else','1','hi',?1)", [now()]).unwrap();
            db.last_insert_rowid()
        };
        assert!(call(&s, &u, None, "save_reply_draft", &json!({ "event_id": other, "text": "hi" })).await.unwrap_err().contains("No message"));
        assert!(call(&s, &u, None, "read_thread", &json!({ "event_id": other })).await.is_err());
        assert!(call(&s, &u, None, "ask_person", &json!({ "question": "" })).await.is_err());
        assert!(call(&s, &u, None, "ask_person", &json!({ "question": "Price?" })).await.unwrap_err().contains("needs a task"));
        assert!(call(&s, &u, None, "deliver_now", &json!({})).await.unwrap_err().contains("no tool"));
        assert!(specs().iter().all(|t| !t["function"]["name"].as_str().unwrap().contains("send")));
    }
}
