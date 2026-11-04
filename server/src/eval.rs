//! Offline eval of the choices around the model: which posts a customer's photo is compared with and how
//! Muse's answer is checked, which learned facts reach a prompt, and which sent words the style note reads.
//! Fixed inputs, no network, no AI spend. `cargo test eval -- --nocapture` prints the score per area.

use crate::{attention, lock, style, tests_support::state_with_user, voice};
use serde_json::{json, Value};

/// One area's named cases; prints `area: passed/total` and fails the test naming every miss.
fn score(area: &str, cases: Vec<(&str, bool)>) {
    let missed: Vec<&str> = cases.iter().filter(|c| !c.1).map(|c| c.0).collect();
    println!("{area}: {}/{} cases", cases.len() - missed.len(), cases.len());
    assert!(missed.is_empty(), "{area} missed: {missed:?}");
}

fn post(n: usize, kind: &str) -> Value {
    let picture = if kind == "VIDEO" { "thumbnail_url" } else { "media_url" };
    json!({ "id": format!("m{n}"), "media_type": kind, picture: format!("https://cdn.example/m{n}.jpg"),
        "caption": format!("Post {n}"), "permalink": format!("https://instagram.com/p/{n}"), "timestamp": format!("2026-10-{n:02}T09:00:00+0000") })
}

#[test]
fn eval_photo_match() {
    let ig = |media: Vec<Value>| json!({ "accounts": [{ "media": media }] });
    let ids = |posts: &[Value]| posts.iter().map(|m| m["id"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>();
    let three = vec![post(1, "IMAGE"), post(2, "VIDEO"), post(3, "CAROUSEL_ALBUM")];
    let picked = |answer: Value| voice::pick(&answer, &three)["post_id"].as_str().map(str::to_owned);
    let no_picture = json!({ "id": "bare", "media_type": "VIDEO", "caption": "no cover" });
    let two_accounts = json!({ "accounts": [{ "media": [post(1, "IMAGE")] }, { "media": [post(2, "IMAGE")] }] });
    score("photo match", vec![
        ("the newest 6 posts with a picture, in Meta's order", ids(&voice::candidates(&ig((1..=8).map(|n| post(n, "IMAGE")).collect()))) == ["m1", "m2", "m3", "m4", "m5", "m6"]),
        ("a video is compared by its cover", voice::candidates(&ig(vec![post(2, "VIDEO")])).len() == 1),
        ("a post without a picture is skipped", ids(&voice::candidates(&ig(vec![no_picture, post(1, "IMAGE")]))) == ["m1"]),
        ("posts from every connected account", ids(&voice::candidates(&two_accounts)) == ["m1", "m2"]),
        ("no Instagram, nothing to compare", voice::candidates(&json!({})).is_empty()),
        ("Muse names post 2", picked(json!({ "match": 2 })).as_deref() == Some("m2")),
        ("Muse names post \"3\" as text", picked(json!({ "match": "3" })).as_deref() == Some("m3")),
        ("no match", voice::pick(&json!({ "match": null }), &three) == json!({ "matched": false })),
        ("post 0 is no match", picked(json!({ "match": 0 })).is_none()),
        ("a post number past the list is no match", picked(json!({ "match": 4 })).is_none()),
        ("a negative post number is no match", picked(json!({ "match": -1 })).is_none()),
        ("a word instead of a number is no match", picked(json!({ "match": "two" })).is_none()),
        ("no match field is no match", picked(json!({ "sees": "a mug" })).is_none()),
        ("the match links the owner's post through Stupid", voice::pick(&json!({ "match": 1 }), &three)["thumbnail"] == "/api/instagram/media/m1/image"),
        ("the draft reads the post's date and caption", voice::photo_line(&voice::pick(&json!({ "match": 2 }), &three)).as_deref() == Some("The customer's photo matches your post of 2026-10-02: Post 2")),
        ("the draft is told plainly when nothing matched", voice::photo_line(&json!({ "matched": false })).as_deref() == Some("The customer's photo is not one of your posts.")),
        ("a photo never compared adds nothing", voice::photo_line(&Value::Null).is_none()),
    ]);
}

#[test]
fn eval_learned_facts() {
    let (s, _) = state_with_user();
    let db = lock(&s.db);
    let questions = |user: &str| attention::facts(&db, user).unwrap().iter().map(|f| f["question"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    attention::learn(&db, "u", "Do you deliver to Pune?", "Yes, in 2 days").unwrap();
    let saved = attention::facts(&db, "u").unwrap();
    attention::learn(&db, "u", "Is the blue tote in stock?", "No").unwrap();
    attention::learn(&db, "u", "Is the blue tote in stock?", "Yes, from Friday").unwrap();
    let after = attention::facts(&db, "u").unwrap();
    attention::learn(&db, "someone", "Secret supplier?", "theirs").unwrap();
    let model = attention::facts_for_model(&db, "u").unwrap();
    let told_on = model[0]["told_on"].as_str().unwrap_or_default().to_string();
    let first: Vec<String> = questions("u");
    for i in 0..attention::MAX_FACTS + 3 {
        attention::learn(&db, "u", &format!("q{i}"), "a").unwrap();
    }
    let capped = questions("u");
    score("learned facts", vec![
        ("an answer is saved", saved.len() == 1 && saved[0]["answer"] == "Yes, in 2 days"),
        ("the same question again replaces the answer", after.iter().filter(|f| f["question"] == "Is the blue tote in stock?").count() == 1 && after[0]["answer"] == "Yes, from Friday"),
        ("newest first", first == ["Is the blue tote in stock?", "Do you deliver to Pune?"]),
        ("another person's facts never reach this prompt", !first.contains(&"Secret supplier?".to_string()) && questions("someone") == ["Secret supplier?"]),
        ("the model reads the id a draft cites", model[0]["fact_id"] == after[0]["id"]),
        ("the model reads the day it was told", told_on.len() == 10 && told_on.as_bytes()[4] == b'-'),
        ("at most 50 kept", capped.len() as i64 == attention::MAX_FACTS),
        ("the oldest goes first", capped[0] == format!("q{}", attention::MAX_FACTS + 2) && !capped.contains(&"Do you deliver to Pune?".to_string())),
    ]);
}

#[test]
fn eval_style_samples() {
    let (s, u) = state_with_user();
    {
        let db = lock(&s.db);
        let reply = |id: i64, user: &str, text: &str, created: i64| db.execute("INSERT INTO replies (event_id,user_id,text,created) VALUES (?1,?2,?3,?4)", rusqlite::params![id, user, text, created]).unwrap();
        let event = |asset: &str, sender: &str, text: &str, created: i64| db.execute("INSERT INTO events (kind,asset_id,sender,text,created) VALUES ('whatsapp',?1,?2,?3,?4)", rusqlite::params![asset, sender, text, created]).unwrap();
        reply(1, "u", "Hii! Yes we have it 😊", 10);
        reply(2, "u", "failed send", 11);
        db.execute("UPDATE replies SET error='x' WHERE event_id=2", []).unwrap();
        reply(3, "someone", "another shop's reply", 12);
        reply(4, "u", "   ", 13);
        reply(5, "u", &format!("  {}  ", "long ".repeat(100)), 14);
        event("p1", "p1", "Thank you ji, see you!", 15);
        event("p1", "9198", "a customer asking", 16);
        event("p9", "p9", "an account not switched on", 17);
    }
    let picked = style::samples(&lock(&s.db), &u).unwrap();
    {
        let db = lock(&s.db);
        for i in 0..40 {
            db.execute("INSERT INTO replies (event_id,user_id,text,created) VALUES (?1,'u',?2,?3)", rusqlite::params![100 + i, format!("r{i}"), 100 + i]).unwrap();
        }
    }
    let many = style::samples(&lock(&s.db), &u).unwrap();
    let has = |t: &str| picked.iter().any(|p| p == t);
    score("style samples", vec![
        ("the owner's sent replies", has("Hii! Yes we have it 😊")),
        ("a failed send is not their words", !has("failed send")),
        ("another person's replies never", !has("another shop's reply")),
        ("the owner's own messages on a switched-on account", has("Thank you ji, see you!")),
        ("a customer's message never", !has("a customer asking")),
        ("an account not switched on never", !has("an account not switched on")),
        ("a blank reply is dropped", picked.len() == 3),
        ("a long reply is trimmed to 300 characters", picked.get(1).is_some_and(|t| t.chars().count() == 300 && t.starts_with("long"))),
        ("newest first", picked.first().map(String::as_str) == Some("Thank you ji, see you!") && picked.last().map(String::as_str) == Some("Hii! Yes we have it 😊")),
        ("at most 30, the newest", many.len() == 30 && many[0] == "r39" && many[29] == "r10"),
    ]);
}
