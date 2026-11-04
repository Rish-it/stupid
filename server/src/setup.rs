//! The one next thing a person must do before the agent can work, read only from what is stored.
use crate::{lock, meta::{Issue, NOT_PROFESSIONAL}, user, ApiResult, AppState, User};
use axum::{extract::State, http::HeaderMap, Json};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize, Clone, Debug, PartialEq)]
struct Step {
    id: &'static str,
    app: &'static str,
    title: String,
    why: String,
    action: &'static str,
    button: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<String>,
    /// What to do on the Meta screen, for `fix_in_meta`.
    #[serde(skip_serializing_if = "Option::is_none")]
    fix: Option<String>,
    optional: bool,
}

fn connect(id: &'static str, app: &'static str, title: &str, why: &str, button: &str) -> Step {
    Step { id, app, title: title.into(), why: why.into(), action: "connect", button: button.into(), link: None, fix: None, optional: false }
}

/// A blocking issue meta.rs found, as a step with its exact Meta link. Ids follow the screen it opens.
fn fix_in_meta(app: &'static str, issue: &Issue) -> Step {
    let id = match app {
        "instagram" => "instagram_issue",
        "messenger" => "page_access",
        _ if issue.link.contains("billing_hub") => "whatsapp_payment",
        _ if issue.text.contains("locked") || issue.link.contains("security_center") => "whatsapp_locked",
        _ if issue.text.contains("time zone") => "whatsapp_time_zone",
        _ if issue.link.contains("registration") => "whatsapp_number",
        _ if issue.link.contains("business_info") => "whatsapp_business_info",
        _ => "whatsapp_issue",
    };
    let why = match app {
        "instagram" => "Until this is fixed, the agent can't work on your Instagram.",
        "messenger" => "Until this is fixed, the agent can't read or answer your Page's messages.",
        _ => "Until this is fixed, replies you approve can't go out on WhatsApp.",
    };
    Step { id, app, title: issue.text.clone(), why: why.into(), action: "fix_in_meta", button: "Fix in Meta".into(), link: Some(issue.link.clone()), fix: Some(issue.fix.clone()), optional: false }
}

/// Instagram shares DMs with apps only once its owner allows it, and says nothing while it's off: Graph returns no
/// conversations and no webhooks come. Shown, skippable, until a first Instagram DM has arrived.
fn instagram_messages() -> Step {
    Step {
        id: "instagram_messages", app: "instagram", title: "Let Instagram share your DMs with Stupid".into(),
        why: "No Instagram DM has reached Stupid yet. Instagram only shares DMs once you allow it; comments come in either way.".into(),
        action: "fix_in_meta", button: "Meta's guide".into(),
        link: Some("https://developers.facebook.com/docs/messenger-platform/instagram/get-started".into()),
        fix: Some("In the Instagram app, open your profile, then the menu, Settings and activity, Messages and story replies, Message controls, \
Connected tools, and turn on Allow access to messages. DMs from people you don't follow wait in Requests until you accept them.".into()),
        optional: true,
    }
}

fn facts(title: &str) -> Step {
    Step { id: "agent_facts", app: "agent", title: title.into(), why: "So drafts and leads use your real facts instead of asking you each time.".into(), action: "tell_agent", button: "Tell the agent".into(), link: None, fix: None, optional: true }
}

/// Each step this persona needs, in order: whether it's done, and what to show while it isn't.
/// A step with nothing to show waits behind an earlier one (an issue check before its account is connected).
fn steps(u: &User, persona: &str, facts_given: bool, ig_dms: bool) -> Vec<(bool, Option<Step>)> {
    let mut out = path(u, persona, facts_given);
    if !ig_dms && !u.selected_assets("instagram").is_empty() {
        out.insert(out.len() - 1, (false, Some(instagram_messages())));
    }
    out
}

fn path(u: &User, persona: &str, facts_given: bool) -> Vec<(bool, Option<Step>)> {
    let has = |kind: &str| !u.selected_assets(kind).is_empty();
    // One healthy account of a kind is enough: a second, broken number switched on doesn't hold setup back.
    let blocking = |kind: &'static str| {
        let on = u.selected_assets(kind);
        if on.iter().any(|a| !a.issues.iter().any(|i| i.blocking)) {
            return None;
        }
        on.into_iter().flat_map(|a| &a.issues).find(|i| i.blocking).map(|i| fix_in_meta(kind, i))
    };
    if persona == "creator" {
        let ig = has("instagram");
        let issue = blocking("instagram");
        // Meta shared no Instagram with any Page and a switched-on Page says why: the account isn't professional or linked yet.
        let snag = (!u.assets.iter().any(|a| a.kind == "instagram"))
            .then(|| u.selected_assets("messenger").into_iter().flat_map(|a| &a.issues).find(|i| i.text == NOT_PROFESSIONAL))
            .flatten();
        let first = match snag {
            Some(i) => Step { id: "instagram_professional", title: "Make your Instagram a professional account and link it to your Page".into(), ..fix_in_meta("instagram", i) },
            None => connect("instagram_connect", "instagram", "Connect your Instagram", "So the agent can read your comments and DMs and see what you post.", "Connect Instagram"),
        };
        return vec![
            (ig, Some(first)),
            (ig && issue.is_none(), issue),
            (facts_given, Some(facts("What you post about and what brand deals you take"))),
        ];
    }
    let (wa, page) = (has("whatsapp"), has("messenger"));
    let link = match (wa, page) {
        (false, false) => Some(connect("whatsapp_connect", "whatsapp", "Connect WhatsApp and your Facebook Page", "So the agent can read customer messages on WhatsApp and Messenger and draft replies.", "Connect WhatsApp and Page")),
        (false, true) => Some(connect("whatsapp_connect", "whatsapp", "Connect WhatsApp", "So the agent can read customer messages on WhatsApp and draft replies.", "Connect WhatsApp")),
        (true, false) => Some(connect("page_connect", "messenger", "Connect your Facebook Page", "So the agent can read Messenger messages and draft replies.", "Connect Facebook Page")),
        (true, true) => None,
    };
    let issue = blocking("whatsapp").or_else(|| blocking("messenger"));
    vec![
        (wa, link.clone()),
        (page, link),
        (wa && page && issue.is_none(), issue),
        (facts_given, Some(facts("Your prices, hours and delivery areas"))),
    ]
}

fn plan(u: &User, facts_given: bool, ig_dms: bool) -> Value {
    let Some(persona) = u.persona.as_deref() else {
        return json!({ "persona": null, "done": false, "progress": { "done": 0, "total": 0 } });
    };
    let steps = steps(u, persona, facts_given, ig_dms);
    let done = steps.iter().all(|(ok, step)| *ok || step.as_ref().is_some_and(|s| s.optional));
    let next = steps.iter().find(|(ok, step)| !ok && step.is_some()).and_then(|(_, step)| step.clone());
    let mut out = json!({ "persona": persona, "done": done, "progress": { "done": steps.iter().filter(|(ok, _)| *ok).count(), "total": steps.len() } });
    if let Some(step) = next {
        out["step"] = json!(step);
    }
    out
}

/// GET /api/setup/next: no Graph calls, only the accounts, issues and rules already stored.
pub async fn next(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let u = user(&s, &headers)?;
    let db = lock(&s.db);
    let rules: String = db.query_row("SELECT agent_rules FROM users WHERE id=?1", [&u.id], |r| r.get(0))?;
    let ig: Vec<String> = u.selected_assets("instagram").into_iter().map(|a| a.id.clone()).collect();
    let ig_dms = ig.iter().map(|id| db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind='instagram' AND asset_id=?1)", [id], |r| r.get::<_, bool>(0)))
        .collect::<rusqlite::Result<Vec<bool>>>()?.into_iter().any(|seen| seen);
    Ok(Json(plan(&u, !rules.trim().is_empty(), ig_dms)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::Asset;

    fn person(persona: Option<&str>, assets: &[(&str, Vec<Issue>)]) -> User {
        let assets: Vec<Asset> = assets.iter().map(|(kind, issues)| Asset { key: format!("{kind}:1"), kind: kind.to_string(), id: "1".into(), name: "x".into(), issues: issues.clone(), business: None }).collect();
        User { id: "u".into(), name: "n".into(), token_blob: String::new(), selected: assets.iter().map(|a| a.key.clone()).collect(), assets, permissions: vec![], problems: vec![], persona: persona.map(Into::into) }
    }
    fn issue(text: &str, link: &str) -> Issue {
        Issue { blocking: true, text: text.into(), fix: "Do this.".into(), link: link.into() }
    }

    #[test]
    fn no_persona_has_no_step() {
        assert_eq!(plan(&person(None, &[]), false, true), json!({ "persona": null, "done": false, "progress": { "done": 0, "total": 0 } }));
    }

    #[test]
    fn one_working_number_is_enough() {
        let mut u = person(Some("business"), &[("whatsapp", vec![issue("This number isn't registered.", "https://business.facebook.com/wa/manage/home/")]), ("messenger", vec![])]);
        let mut ok = u.assets[0].clone();
        (ok.key, ok.id, ok.issues) = ("whatsapp:2".into(), "2".into(), vec![]);
        assert_eq!(plan(&u, false, true)["step"]["action"], "fix_in_meta", "only the broken number: fix it");
        u.selected.push(ok.key.clone());
        u.assets.push(ok);
        assert_eq!(plan(&u, false, true)["step"]["id"], "agent_facts", "a working number switched on too: nothing to fix");
    }

    #[test]
    fn creator_steps() {
        let new = plan(&person(Some("creator"), &[]), false, true);
        assert_eq!((new["done"].clone(), new["progress"].clone(), new["step"]["id"].clone()), (json!(false), json!({ "done": 0, "total": 3 }), json!("instagram_connect")));
        assert_eq!(new["step"]["action"], "connect");
        let broken = plan(&person(Some("creator"), &[("instagram", vec![issue("Instagram is restricted.", "https://business.facebook.com/business-support-home/")])]), false, true);
        assert_eq!((broken["step"]["id"].clone(), broken["step"]["action"].clone(), broken["done"].clone()), (json!("instagram_issue"), json!("fix_in_meta"), json!(false)));
        assert_eq!(broken["step"]["link"], "https://business.facebook.com/business-support-home/");
        let ready = plan(&person(Some("creator"), &[("instagram", vec![])]), false, true);
        assert_eq!((ready["done"].clone(), ready["progress"].clone(), ready["step"]["id"].clone(), ready["step"]["optional"].clone()), (json!(true), json!({ "done": 2, "total": 3 }), json!("agent_facts"), json!(true)));
        assert!(ready["step"]["title"].as_str().unwrap().contains("brand deals"));
        let all = plan(&person(Some("creator"), &[("instagram", vec![])]), true, true);
        assert_eq!((all["done"].clone(), all["progress"].clone(), all.get("step")), (json!(true), json!({ "done": 3, "total": 3 }), None));
    }

    #[test]
    fn business_steps() {
        let new = plan(&person(Some("business"), &[]), false, true);
        assert_eq!((new["step"]["id"].clone(), new["progress"].clone()), (json!("whatsapp_connect"), json!({ "done": 0, "total": 4 })));
        assert!(new["step"]["title"].as_str().unwrap().contains("Facebook Page"));
        let half = plan(&person(Some("business"), &[("whatsapp", vec![])]), false, true);
        assert_eq!((half["step"]["id"].clone(), half["step"]["app"].clone(), half["progress"]["done"].clone()), (json!("page_connect"), json!("messenger"), json!(1)));
        let pay = "https://business.facebook.com/billing_hub/accounts/details/?business_id=7&asset_id=8";
        let unpaid = plan(&person(Some("business"), &[("whatsapp", vec![issue("WhatsApp needs a payment method before it can send.", pay)]), ("messenger", vec![])]), false, true);
        assert_eq!((unpaid["step"]["id"].clone(), unpaid["step"]["link"].clone(), unpaid["done"].clone()), (json!("whatsapp_payment"), json!(pay), json!(false)));
        let locked = plan(&person(Some("business"), &[("whatsapp", vec![issue("Meta has locked this WhatsApp account.", "https://business.facebook.com/business-support-home/")]), ("messenger", vec![])]), false, true);
        assert_eq!(locked["step"]["id"], "whatsapp_locked");
        let center = "https://business.facebook.com/latest/settings/security_center?business_id=7";
        let restricted = plan(&person(Some("business"), &[("whatsapp", vec![issue("Meta has restricted this WhatsApp account.", center)]), ("messenger", vec![])]), false, true);
        assert_eq!((restricted["step"]["id"].clone(), restricted["step"]["link"].clone()), (json!("whatsapp_locked"), json!(center)));
        let ready = plan(&person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![])]), false, true);
        assert_eq!((ready["done"].clone(), ready["step"]["id"].clone(), ready["progress"].clone()), (json!(true), json!("agent_facts"), json!({ "done": 3, "total": 4 })));
        assert!(ready["step"]["title"].as_str().unwrap().contains("prices"));
        let all = plan(&person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![])]), true, true);
        assert_eq!((all["done"].clone(), all["progress"].clone(), all.get("step")), (json!(true), json!({ "done": 4, "total": 4 }), None));
    }

    #[test]
    fn creator_with_a_page_but_no_professional_instagram() {
        let snags = vec![
            Issue { blocking: false, ..issue(NOT_PROFESSIONAL, "https://help.instagram.com/502981923235522") },
            Issue { blocking: false, ..issue(crate::meta::NO_INSTAGRAM, "https://www.facebook.com/business/help/898752960195806") },
        ];
        let next = plan(&person(Some("creator"), &[("messenger", snags.clone())]), false, true);
        assert_eq!((next["step"]["id"].clone(), next["step"]["action"].clone(), next["step"]["app"].clone()), (json!("instagram_professional"), json!("fix_in_meta"), json!("instagram")));
        assert_eq!((next["step"]["link"].clone(), next["done"].clone(), next["progress"].clone()), (json!("https://help.instagram.com/502981923235522"), json!(false), json!({ "done": 0, "total": 3 })));
        // Instagram came with another Page: it only needs switching on.
        let mut u = person(Some("creator"), &[("messenger", snags), ("instagram", vec![])]);
        u.selected.retain(|k| k != "instagram:1");
        assert_eq!(plan(&u, false, true)["step"]["id"], "instagram_connect");
        // The same snag never shows on the business path.
        let business = person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![Issue { blocking: false, ..issue(NOT_PROFESSIONAL, "https://x") }])]);
        assert_eq!(plan(&business, false, true)["step"]["id"], "agent_facts");
    }

    #[test]
    fn instagram_says_how_to_share_dms_until_one_arrives() {
        let u = person(Some("creator"), &[("instagram", vec![])]);
        let waiting = plan(&u, true, false);
        assert_eq!((waiting["done"].clone(), waiting["step"]["id"].clone(), waiting["step"]["optional"].clone()), (json!(true), json!("instagram_messages"), json!(true)));
        assert!(waiting["step"]["fix"].as_str().unwrap().contains("Allow access to messages"));
        assert_eq!(plan(&u, true, true).get("step"), None, "gone once a DM arrived");
        let business = person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![])]);
        assert_eq!(plan(&business, true, false).get("step"), None, "no Instagram, no step");
    }

    #[test]
    fn non_blocking_issues_and_switched_off_accounts() {
        let mut u = person(Some("business"), &[("whatsapp", vec![Issue { blocking: false, ..issue("Limited chats.", "https://x") }]), ("messenger", vec![])]);
        assert_eq!(plan(&u, true, true)["done"], true);
        u.selected.clear();
        assert_eq!(plan(&u, true, true)["step"]["id"], "whatsapp_connect");
    }
}
