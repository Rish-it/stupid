//! The one next thing a person must do before the agent can work, read only from what is stored.
use crate::{lock, meta::Issue, user, ApiResult, AppState, User};
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
        _ if issue.text.contains("locked") => "whatsapp_locked",
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

fn facts(title: &str) -> Step {
    Step { id: "agent_facts", app: "agent", title: title.into(), why: "So drafts and leads use your real facts instead of asking you each time.".into(), action: "tell_agent", button: "Tell the agent".into(), link: None, fix: None, optional: true }
}

/// Each step this persona needs, in order: whether it's done, and what to show while it isn't.
/// A step with nothing to show waits behind an earlier one (an issue check before its account is connected).
fn steps(u: &User, persona: &str, facts_given: bool) -> Vec<(bool, Option<Step>)> {
    let has = |kind: &str| !u.selected_assets(kind).is_empty();
    let blocking = |kind: &'static str| u.selected_assets(kind).into_iter().flat_map(|a| &a.issues).find(|i| i.blocking).map(|i| fix_in_meta(kind, i));
    if persona == "creator" {
        let ig = has("instagram");
        let issue = blocking("instagram");
        return vec![
            (ig, Some(connect("instagram_connect", "instagram", "Connect your Instagram", "So the agent can read your comments and DMs and see what you post.", "Connect Instagram"))),
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

fn plan(u: &User, facts_given: bool) -> Value {
    let Some(persona) = u.persona.as_deref() else {
        return json!({ "persona": null, "done": false, "progress": { "done": 0, "total": 0 } });
    };
    let steps = steps(u, persona, facts_given);
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
    let rules: String = lock(&s.db).query_row("SELECT agent_rules FROM users WHERE id=?1", [&u.id], |r| r.get(0))?;
    Ok(Json(plan(&u, !rules.trim().is_empty())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::Asset;

    fn person(persona: Option<&str>, assets: &[(&str, Vec<Issue>)]) -> User {
        let assets: Vec<Asset> = assets.iter().map(|(kind, issues)| Asset { key: format!("{kind}:1"), kind: kind.to_string(), id: "1".into(), name: "x".into(), issues: issues.clone() }).collect();
        User { id: "u".into(), name: "n".into(), token_blob: String::new(), selected: assets.iter().map(|a| a.key.clone()).collect(), assets, permissions: vec![], problems: vec![], persona: persona.map(Into::into) }
    }
    fn issue(text: &str, link: &str) -> Issue {
        Issue { blocking: true, text: text.into(), fix: "Do this.".into(), link: link.into() }
    }

    #[test]
    fn no_persona_has_no_step() {
        assert_eq!(plan(&person(None, &[]), false), json!({ "persona": null, "done": false, "progress": { "done": 0, "total": 0 } }));
    }

    #[test]
    fn creator_steps() {
        let new = plan(&person(Some("creator"), &[]), false);
        assert_eq!((new["done"].clone(), new["progress"].clone(), new["step"]["id"].clone()), (json!(false), json!({ "done": 0, "total": 3 }), json!("instagram_connect")));
        assert_eq!(new["step"]["action"], "connect");
        let broken = plan(&person(Some("creator"), &[("instagram", vec![issue("Instagram is restricted.", "https://business.facebook.com/business-support-home/")])]), false);
        assert_eq!((broken["step"]["id"].clone(), broken["step"]["action"].clone(), broken["done"].clone()), (json!("instagram_issue"), json!("fix_in_meta"), json!(false)));
        assert_eq!(broken["step"]["link"], "https://business.facebook.com/business-support-home/");
        let ready = plan(&person(Some("creator"), &[("instagram", vec![])]), false);
        assert_eq!((ready["done"].clone(), ready["progress"].clone(), ready["step"]["id"].clone(), ready["step"]["optional"].clone()), (json!(true), json!({ "done": 2, "total": 3 }), json!("agent_facts"), json!(true)));
        assert!(ready["step"]["title"].as_str().unwrap().contains("brand deals"));
        let all = plan(&person(Some("creator"), &[("instagram", vec![])]), true);
        assert_eq!((all["done"].clone(), all["progress"].clone(), all.get("step")), (json!(true), json!({ "done": 3, "total": 3 }), None));
    }

    #[test]
    fn business_steps() {
        let new = plan(&person(Some("business"), &[]), false);
        assert_eq!((new["step"]["id"].clone(), new["progress"].clone()), (json!("whatsapp_connect"), json!({ "done": 0, "total": 4 })));
        assert!(new["step"]["title"].as_str().unwrap().contains("Facebook Page"));
        let half = plan(&person(Some("business"), &[("whatsapp", vec![])]), false);
        assert_eq!((half["step"]["id"].clone(), half["step"]["app"].clone(), half["progress"]["done"].clone()), (json!("page_connect"), json!("messenger"), json!(1)));
        let pay = "https://business.facebook.com/billing_hub/accounts/details/?business_id=7&asset_id=8";
        let unpaid = plan(&person(Some("business"), &[("whatsapp", vec![issue("WhatsApp needs a payment method before it can send.", pay)]), ("messenger", vec![])]), false);
        assert_eq!((unpaid["step"]["id"].clone(), unpaid["step"]["link"].clone(), unpaid["done"].clone()), (json!("whatsapp_payment"), json!(pay), json!(false)));
        let locked = plan(&person(Some("business"), &[("whatsapp", vec![issue("Meta has locked this WhatsApp account.", "https://business.facebook.com/business-support-home/")]), ("messenger", vec![])]), false);
        assert_eq!(locked["step"]["id"], "whatsapp_locked");
        let ready = plan(&person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![])]), false);
        assert_eq!((ready["done"].clone(), ready["step"]["id"].clone(), ready["progress"].clone()), (json!(true), json!("agent_facts"), json!({ "done": 3, "total": 4 })));
        assert!(ready["step"]["title"].as_str().unwrap().contains("prices"));
        let all = plan(&person(Some("business"), &[("whatsapp", vec![]), ("messenger", vec![])]), true);
        assert_eq!((all["done"].clone(), all["progress"].clone(), all.get("step")), (json!(true), json!({ "done": 4, "total": 4 }), None));
    }

    #[test]
    fn non_blocking_issues_and_switched_off_accounts() {
        let mut u = person(Some("business"), &[("whatsapp", vec![Issue { blocking: false, ..issue("Limited chats.", "https://x") }]), ("messenger", vec![])]);
        assert_eq!(plan(&u, true)["done"], true);
        u.selected.clear();
        assert_eq!(plan(&u, true)["step"]["id"], "whatsapp_connect");
    }
}
