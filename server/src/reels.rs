//! Reel director: Muse Wonder watches the creator's best Reels and writes new scripts with shot lists.
//! With no videos yet it writes from captions on Muse Spark Open, and says so. Nothing is posted.
use crate::{agents, meta_ai, ApiResult, AppError, AppState};
use serde_json::{json, Value};

/// At most this many videos per run, best first.
const MAX_VIDEOS: usize = 3;

const SHAPE: &str = "{\"watched\":[{\"video\":number,\"works\":[{\"at\":string,\"what\":string}],\"drop_off_guesses\":[{\"at\":string,\"what\":string}]}],\
\"scripts\":[{\"title\":string,\"hook\":string,\"caption\":string,\"shots\":[{\"shot\":string,\"seconds\":number,\"on_screen\":string,\"sound\":string}]}]}";

/// The prompt for Muse Wonder, which sees the videos.
fn watching() -> String {
    format!("You are a short-video director for a creator. The attached videos are their best-performing Reels, in the order listed. \
For each video (numbered from 1), say what works, with timestamps: the hook in the first seconds, pacing, text on screen, sound. \
Then say where viewers may drop off; these are guesses, so put them only under drop_off_guesses. \
Then write three new Reel scripts in the creator's voice: three different ideas on the creator's own topic, not remakes of these videos, \
each reusing a technique that works (name it in the title). Each has a title, a hook line, a caption, \
and a shot list where every shot says what to film, how many seconds, the text on screen and the sound. \
Base every claim on what you saw and the numbers given; never invent numbers. Return JSON {SHAPE}. Reply with the JSON object only.")
}

/// The system prompt for Muse Spark Open when there is nothing to watch.
pub const FROM_CAPTIONS: &str = "You are a short-video director for a creator who has no Reels yet. From their recent post captions and how each performed, \
write three Reel scripts in their voice. Each has a title, a hook line, a caption, and a shot list where every shot says what to film, how many seconds, \
the text on screen and the sound. Never invent numbers. Return JSON {\"watched\":[],\"scripts\":[{\"title\":string,\"hook\":string,\"caption\":string,\
\"shots\":[{\"shot\":string,\"seconds\":number,\"on_screen\":string,\"sound\":string}]}]}.";

/// What the director gets from Instagram: the best videos with their links, and every post's caption and counts.
pub fn context(ig: &Value) -> Value {
    let media: Vec<&Value> = ig["accounts"].as_array().into_iter().flatten().flat_map(|a| a["media"].as_array().into_iter().flatten()).collect();
    let score = |m: &Value| m["like_count"].as_i64().unwrap_or(0) + m["comments_count"].as_i64().unwrap_or(0);
    let mut videos: Vec<&Value> = media.iter().copied()
        .filter(|m| (m["media_type"] == "VIDEO" || m["media_product_type"] == "REELS") && m["media_url"].is_string()).collect();
    videos.sort_by_key(|m| -score(m));
    let post = |m: &Value| json!({ "caption": m["caption"], "type": m["media_product_type"], "likes": m["like_count"], "comments": m["comments_count"], "when": m["timestamp"] });
    json!({
        "videos": videos.iter().take(MAX_VIDEOS).map(|m| json!({ "media_url": m["media_url"], "permalink": m["permalink"], "post": post(m) })).collect::<Vec<_>>(),
        "posts": media.iter().map(|m| post(m)).collect::<Vec<_>>(),
    })
}

/// Run the director. Returns the result and its cost: Wonder spend goes to the Model API ledger, Spark Open to Baseten's.
pub async fn direct(s: &AppState, user_id: &str, context: &Value, ai: &agents::Ai) -> ApiResult<(Value, f64)> {
    let videos = context["videos"].as_array().cloned().unwrap_or_default();
    if videos.is_empty() {
        let (mut result, cost) = agents::muse(s, "reels", FROM_CAPTIONS, &json!({ "posts": context["posts"] }), ai).await?;
        result["watched"] = json!([]);
        result["from_captions_only"] = json!(true);
        return Ok((result, cost));
    }
    let listed: Vec<Value> = videos.iter().enumerate().map(|(i, v)| json!({ "video": i + 1, "post": v["post"] })).collect();
    let mut content = vec![json!({ "type": "input_text", "text": format!("{}\n\nVideos: {}\n\nAll recent posts: {}", watching(), json!(listed), context["posts"]) })];
    content.extend(videos.iter().map(|v| json!({ "type": "input_video", "video_url": v["media_url"] })));
    let (text, cost) = meta_ai::wonder(s, user_id, content).await?;
    let mut result = agents::extract_json(&text).ok_or_else(|| AppError::new(502, "Muse Wonder answered without the expected format."))?;
    // Point each note back at its post, so the person can open it.
    for w in result["watched"].as_array_mut().into_iter().flatten() {
        if let Some(v) = w["video"].as_u64().and_then(|n| videos.get((n as usize).wrapping_sub(1))) {
            w["permalink"] = v["permalink"].clone();
            w["caption"] = v["post"]["caption"].clone();
        }
    }
    result["from_captions_only"] = json!(false);
    Ok((result, cost))
}

/// The executor's `watch_video` tool: Wonder watches one of the creator's own videos and answers a question about it.
pub async fn watch(s: &AppState, user_id: &str, media_url: &str, question: &str) -> ApiResult<String> {
    let content = vec![
        json!({ "type": "input_text", "text": format!("Watch this video from the creator's own Instagram and answer in plain words, with timestamps where they help. Label guesses as guesses. Question: {question}") }),
        json!({ "type": "input_video", "video_url": media_url }),
    ];
    meta_ai::wonder(s, user_id, content).await.map(|(text, _)| text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_best_videos_go_to_wonder_and_every_caption_goes_along() {
        let ig = json!({ "accounts": [{ "media": [
            { "media_type": "IMAGE", "media_url": "https://cdn/p.jpg", "caption": "photo", "like_count": 900, "comments_count": 0 },
            { "media_type": "VIDEO", "media_product_type": "REELS", "media_url": "https://cdn/a.mp4", "permalink": "https://ig/a", "caption": "a", "like_count": 5, "comments_count": 1 },
            { "media_type": "VIDEO", "media_url": "https://cdn/b.mp4", "permalink": "https://ig/b", "caption": "b", "like_count": 50, "comments_count": 9 },
            { "media_type": "VIDEO", "caption": "no url", "like_count": 99 },
            { "media_type": "VIDEO", "media_url": "https://cdn/c.mp4", "caption": "c", "like_count": 1 },
            { "media_type": "VIDEO", "media_url": "https://cdn/d.mp4", "caption": "d", "like_count": 0 },
        ] }] });
        let c = context(&ig);
        let urls: Vec<&str> = c["videos"].as_array().unwrap().iter().map(|v| v["media_url"].as_str().unwrap()).collect();
        assert_eq!(urls, ["https://cdn/b.mp4", "https://cdn/a.mp4", "https://cdn/c.mp4"], "best first, at most three, only playable videos");
        assert_eq!(c["posts"].as_array().unwrap().len(), 6);
        assert!(!c["posts"].to_string().contains("cdn/"), "captions and counts only");
        assert_eq!(context(&json!({ "accounts": [] }))["videos"], json!([]));
    }

    /// One live Wonder run on a public clip. `STUPID_META_API_KEY` set; `cargo test live_reel_director -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_reel_director() {
        let (s, _) = crate::tests_support::state_with_user();
        let mut cfg = crate::Config::load();
        cfg.muse_key = String::new();
        let s = AppState { cfg: std::sync::Arc::new(cfg), ..s };
        let ig = json!({ "accounts": [{ "media": [{ "media_type": "VIDEO", "media_product_type": "REELS", "media_url": "https://www.w3schools.com/html/mov_bbb.mp4",
            "permalink": "https://www.instagram.com/", "caption": "A bunny wakes up in the meadow", "like_count": 40, "comments_count": 3 }] }] });
        let (result, cost) = direct(&s, "u", &context(&ig), &crate::agents::Ai::Workspace).await.unwrap();
        println!("REELS ${cost:.4}\nWATCHED {}", serde_json::to_string_pretty(&result["watched"]).unwrap());
        for script in result["scripts"].as_array().into_iter().flatten() {
            println!("SCRIPT {} | hook: {} | {} shots", script["title"], script["hook"], script["shots"].as_array().map_or(0, Vec::len));
        }
        assert_eq!(result["scripts"].as_array().map(Vec::len), Some(3));
    }
}
