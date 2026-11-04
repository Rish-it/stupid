//! The owner's summary for WhatsApp, read straight from the database: no AI, no network. Messages in by
//! app, drafts and sends, who is waiting, new leads and the one thing to do first. An empty day says so.
// The owner channel's daily summary calls `build`; drop this once it does.
#![allow(dead_code)]
use rusqlite::{params, Connection, OptionalExtension};

pub struct Digest {
    pub text: String,
    pub waiting: usize,
    pub sent: usize,
    pub received: usize,
    pub leads: usize,
}

/// The person's switched-on account ids, as rows for `asset_id IN (…)`.
const IDS: &str = "SELECT json_extract(a.value,'$.id') FROM users u, json_each(u.assets_json) a
  WHERE u.id=?1 AND json_extract(a.value,'$.key') IN (SELECT value FROM json_each(u.selected_json))";

/// What happened between `since` and `now` for `user_id` (a `users.id`), in a few plain sentences.
pub fn build(conn: &Connection, user_id: &str, since: i64, now: i64) -> rusqlite::Result<Digest> {
    // Customer messages only: the owner's own echoes (sender is the account itself) don't count.
    let mut stmt = conn.prepare(&format!(
        "SELECT CASE WHEN kind LIKE 'instagram%' THEN 'Instagram' WHEN kind='messenger' THEN 'Messenger' WHEN kind='whatsapp' THEN 'WhatsApp' ELSE kind END app, COUNT(*) n
         FROM events WHERE asset_id IN ({IDS}) AND sender<>asset_id AND created>?2 AND created<=?3 GROUP BY app ORDER BY n DESC, app"))?;
    let apps = stmt.query_map(params![user_id, since, now], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    let received: usize = apps.iter().map(|(_, n)| n).sum();
    let drafted: usize = conn.query_row("SELECT COUNT(DISTINCT event_id) FROM drafts WHERE user_id=?1 AND created>?2 AND created<=?3", params![user_id, since, now], |r| r.get(0))?;
    let sent: usize = conn.query_row("SELECT COUNT(*) FROM replies WHERE user_id=?1 AND error IS NULL AND created>?2 AND created<=?3", params![user_id, since, now], |r| r.get(0))?;
    // ponytail: the newest lead run in the window counts, not a union of runs; leads have no ids to dedupe by.
    let leads: usize = conn.query_row(
        "SELECT COALESCE(CASE WHEN json_valid(result_json) THEN json_array_length(result_json,'$.leads') END,0) FROM agent_runs
         WHERE user_id=?1 AND agent='leads' AND status='done' AND created>?2 AND created<=?3 ORDER BY id DESC LIMIT 1",
        params![user_id, since, now], |r| r.get(0)).optional()?.unwrap_or(0);
    // The same "Needs you" as the app: unanswered drafts still inside the reply window, and open questions. Oldest first.
    let mut stmt = conn.prepare(&format!(
        "SELECT e.sender_name,e.kind,e.text,e.created FROM drafts d JOIN events e ON e.id=d.event_id
         WHERE d.id IN (SELECT MAX(id) FROM drafts WHERE user_id=?1 GROUP BY event_id) AND e.asset_id IN ({IDS})
           AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.event_id=d.event_id AND r.error IS NULL)
           AND (e.kind='instagram_comment' OR e.created>?2-86400)
         UNION ALL
         SELECT e.sender_name,e.kind,COALESCE(e.text,q.text),COALESCE(e.created,q.created) FROM tickets k
         JOIN reports q ON q.id=(SELECT MAX(id) FROM reports WHERE ticket_id=k.id AND kind='question')
         LEFT JOIN triggers t ON t.id=k.trigger_id LEFT JOIN events e ON e.id=t.event_id
         WHERE k.user_id=?1 AND k.state='open' AND (SELECT kind FROM reports WHERE ticket_id=k.id ORDER BY id DESC LIMIT 1)='waiting'
         ORDER BY 4"))?;
    let waiting = stmt.query_map(params![user_id, now], |r| {
        let (name, kind, text, at): (Option<String>, Option<String>, String, i64) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        let who = match name.filter(|n| !n.trim().is_empty()) {
            Some(n) => n,
            None => match kind.as_deref() {
                Some("whatsapp") => "someone on WhatsApp".into(),
                Some("messenger") => "someone on Messenger".into(),
                Some(_) => "someone on Instagram".into(),
                None => "a question from me".into(),
            },
        };
        Ok((who, about(&text), now - at))
    })?.collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::new();
    out.push(match apps.as_slice() {
        [] => "Today: no new messages.".to_string(),
        [(app, _)] => format!("Today: {} in on {app}.", plural(received, "message")),
        _ => format!("Today: {} in ({}).", plural(received, "message"), apps.iter().map(|(a, n)| format!("{n} {a}")).collect::<Vec<_>>().join(", ")),
    });
    match (drafted, sent) {
        (0, 0) => {}
        (d, 0) => out.push(format!("I drafted {d}.")),
        (0, s) => out.push(format!("You sent {s}.")),
        (d, s) => out.push(format!("I drafted {d}, you sent {s}.")),
    }
    if waiting.is_empty() {
        out.push("Nothing is waiting for you.".into());
    } else {
        let top: Vec<String> = waiting.iter().take(3).map(|(who, about, _)| if about.is_empty() { who.clone() } else { format!("{who} ({about})") }).collect();
        let more = waiting.len().saturating_sub(3);
        out.push(format!("Waiting for you: {}{}.", top.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() }));
    }
    if leads > 0 {
        out.push(format!("{}.", plural(leads, "new lead")));
    }
    if let Some((who, _, secs)) = waiting.first() {
        out.push(format!("One thing: answer {who}, waiting {}.", ago(*secs)));
    }
    Ok(Digest { text: out.join(" "), waiting: waiting.len(), sent, received, leads })
}

/// The first few words of what they wrote.
fn about(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let short = words[..words.len().min(5)].join(" ");
    if words.len() > 5 || short.chars().count() > 30 { format!("{}…", short.chars().take(30).collect::<String>().trim_end()) } else { short }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn ago(secs: i64) -> String {
    match secs.max(0) {
        s if s < 3600 => format!("{} min", (s / 60).max(1)),
        s if s < 2 * 86_400 => format!("{} h", s / 3600),
        s => format!("{} days", s / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = NOW - 86_400;

    /// A migrated in-memory database with one person; `selected` are the switched-on account keys.
    fn db(selected: &str) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO users (id,meta_user_id,name,token_blob,token_expires,assets_json,selected_json) VALUES ('u','1','n','b',0,?1,?2)", params![
            r#"[{"key":"whatsapp:p1","kind":"whatsapp","id":"p1","name":"Shop"},{"key":"instagram:i1","kind":"instagram","id":"i1","name":"Shop"},{"key":"messenger:f1","kind":"messenger","id":"f1","name":"Shop"},{"key":"whatsapp:p2","kind":"whatsapp","id":"p2","name":"Old"}]"#,
            selected]).unwrap();
        conn
    }

    fn message(conn: &Connection, id: i64, kind: &str, asset: &str, sender: &str, name: &str, text: &str, ago: i64) {
        conn.execute("INSERT INTO events (id,kind,asset_id,sender,sender_name,text,created) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![id, kind, asset, sender, name, text, NOW - ago]).unwrap();
    }

    fn draft(conn: &Connection, event: i64) {
        conn.execute("INSERT INTO drafts (user_id,event_id,text,source,created) VALUES ('u',?1,'Sure.','agent',?2)", params![event, NOW - 60]).unwrap();
    }

    #[test]
    fn an_empty_day_says_so() {
        let conn = db(r#"["whatsapp:p1"]"#);
        let d = build(&conn, "u", DAY, NOW).unwrap();
        assert_eq!(d.text, "Today: no new messages. Nothing is waiting for you.");
        assert_eq!((d.waiting, d.sent, d.received, d.leads), (0, 0, 0, 0));
    }

    #[test]
    fn a_busy_day_names_who_waits_and_the_oldest_first() {
        let conn = db(r#"["whatsapp:p1"]"#);
        message(&conn, 1, "whatsapp", "p1", "911", "Priya", "Can you do 40 boxes by Friday?", 3 * 3600);
        message(&conn, 2, "whatsapp", "p1", "912", "Ravi", "refund please", 5 * 3600);
        message(&conn, 3, "whatsapp", "p1", "913", "Meena", "price?", 3600);
        message(&conn, 4, "whatsapp", "p1", "914", "Asha", "thanks", 2 * 3600);
        message(&conn, 5, "whatsapp", "p1", "915", "Dev", "hello", 4 * 3600);
        // Not counted: the owner's own echo, an account that is switched off, and yesterday.
        message(&conn, 6, "whatsapp", "p1", "p1", "", "ok", 60);
        message(&conn, 7, "whatsapp", "p2", "916", "Old", "hi", 60);
        message(&conn, 8, "whatsapp", "p1", "917", "Late", "hi", 2 * 86_400);
        for e in [1, 2, 3, 4, 5] {
            draft(&conn, e);
        }
        conn.execute("INSERT INTO replies (event_id,user_id,text,created) VALUES (4,'u','You are welcome.',?1)", [NOW - 30]).unwrap();
        // A failed send leaves Dev waiting and doesn't count as sent.
        conn.execute("INSERT INTO replies (event_id,user_id,text,created,error) VALUES (5,'u','Hi!',?1,'window closed')", [NOW - 30]).unwrap();
        conn.execute("INSERT INTO agent_runs (user_id,agent,status,result_json,created) VALUES ('u','leads','done',?1,?2)",
            params![r#"{"leads":[{"who":"Priya"},{"who":"Meena"}]}"#, NOW - 600]).unwrap();
        let d = build(&conn, "u", DAY, NOW).unwrap();
        assert_eq!(d.text, "Today: 5 messages in on WhatsApp. I drafted 5, you sent 1. Waiting for you: Ravi (refund please), Dev (hello), Priya (Can you do 40 boxes…) and 1 more. 2 new leads. One thing: answer Ravi, waiting 5 h.");
        assert_eq!((d.waiting, d.sent, d.received, d.leads), (4, 1, 5, 2));
    }

    #[test]
    fn every_app_counts_and_questions_wait_too() {
        let conn = db(r#"["whatsapp:p1","instagram:i1","messenger:f1"]"#);
        message(&conn, 1, "whatsapp", "p1", "911", "Priya", "40 boxes", 600);
        message(&conn, 2, "whatsapp", "p1", "912", "Ravi", "hi", 600);
        message(&conn, 3, "instagram_comment", "i1", "meena", "meena", "price?", 600);
        message(&conn, 4, "instagram", "i1", "77", "", "is it in stock", 600);
        message(&conn, 5, "messenger", "f1", "88", "", "open today?", 90 * 60);
        draft(&conn, 4);
        conn.execute("INSERT INTO triggers (id,user_id,thread_id,source,ref,event_id,created) VALUES (1,'u',1,'inbox','fb:x',5,?1)", [NOW]).unwrap();
        conn.execute("INSERT INTO tickets (id,user_id,thread_id,trigger_id,job,created) VALUES (1,'u',1,1,'replies',?1)", [NOW]).unwrap();
        for kind in ["question", "waiting"] {
            conn.execute("INSERT INTO reports (ticket_id,kind,text,created) VALUES (1,?1,'Are you open today?',?2)", params![kind, NOW - 60]).unwrap();
        }
        let d = build(&conn, "u", DAY, NOW).unwrap();
        assert_eq!(d.text, "Today: 5 messages in (2 Instagram, 2 WhatsApp, 1 Messenger). I drafted 1. Waiting for you: someone on Messenger (open today?), someone on Instagram (is it in stock). One thing: answer someone on Messenger, waiting 1 h.");
        assert_eq!((d.waiting, d.sent, d.received, d.leads), (2, 0, 5, 0));
    }
}
