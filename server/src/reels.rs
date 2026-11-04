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
    let is_video = |m: &&Value| m["media_type"] == "VIDEO" || m["media_product_type"] == "REELS";
    let mut videos: Vec<&Value> = media.iter().copied().filter(is_video).filter(|m| m["media_url"].is_string()).collect();
    // Instagram withholds the file of a Reel with licensed music; the person is told which, not left guessing.
    let withheld: Vec<Value> = media.iter().copied().filter(is_video).filter(|m| !m["media_url"].is_string())
        .map(|m| json!({ "caption": m["caption"], "permalink": m["permalink"], "why": "Instagram doesn't share this Reel's video, often because of licensed music." })).collect();
    videos.sort_by_key(|m| -score(m));
    let post = |m: &Value| json!({ "caption": m["caption"], "type": m["media_product_type"], "likes": m["like_count"], "comments": m["comments_count"], "when": m["timestamp"] });
    json!({
        "videos": videos.iter().take(MAX_VIDEOS).map(|m| json!({ "id": m["id"], "permalink": m["permalink"], "post": post(m) })).collect::<Vec<_>>(),
        "posts": media.iter().map(|m| post(m)).collect::<Vec<_>>(),
        "skipped": withheld,
    })
}

/// Run the director. Returns the result and its cost: Wonder spend goes to the Model API ledger, Spark Open to Baseten's.
pub async fn direct(s: &AppState, user_id: &str, context: &Value, ai: &agents::Ai) -> ApiResult<(Value, f64)> {
    // Each video is read here first; one that can't be (Instagram withheld the file, too large) is left out, not guessed at.
    let (mut videos, mut inline) = (Vec::new(), Vec::new());
    let mut skipped: Vec<Value> = context["skipped"].as_array().cloned().unwrap_or_default();
    for v in context["videos"].as_array().into_iter().flatten() {
        match crate::igmedia::data_url(s, user_id, v["id"].as_str().unwrap_or_default(), crate::igmedia::Part::Video).await {
            Ok(url) => { videos.push(v.clone()); inline.push(url) }
            Err(e) => {
                tracing::warn!("reel director skipped a video: {e}");
                skipped.push(json!({ "caption": v["post"]["caption"], "permalink": v["permalink"], "why": format!("Stupid couldn't read the video: {e}.") }));
            }
        }
    }
    if videos.is_empty() {
        let (mut result, cost) = agents::muse(s, "reels", FROM_CAPTIONS, &json!({ "posts": context["posts"] }), ai).await?;
        result["watched"] = json!([]);
        result["from_captions_only"] = json!(true);
        result["skipped"] = json!(skipped);
        return Ok((result, cost));
    }
    let listed: Vec<Value> = videos.iter().enumerate().map(|(i, v)| json!({ "video": i + 1, "post": v["post"] })).collect();
    let mut content = vec![json!({ "type": "input_text", "text": format!("{}\n\nVideos: {}\n\nAll recent posts: {}", watching(), json!(listed), context["posts"]) })];
    content.extend(inline.into_iter().map(|url| json!({ "type": "input_video", "video_url": url })));
    let (text, cost) = meta_ai::wonder(s, user_id, content).await?;
    let mut result = agents::extract_json(&text).ok_or_else(|| AppError::new(502, "Muse Wonder answered without the expected format."))?;
    // Point each note back at its post, so the person can open it.
    for w in result["watched"].as_array_mut().into_iter().flatten() {
        if let Some(v) = w["video"].as_u64().and_then(|n| videos.get((n as usize).wrapping_sub(1))) {
            w["id"] = v["id"].clone();
            w["permalink"] = v["permalink"].clone();
            w["caption"] = v["post"]["caption"].clone();
        }
    }
    result["from_captions_only"] = json!(false);
    result["skipped"] = json!(skipped);
    Ok((result, cost))
}

/// The executor's `watch_video` tool: Wonder watches one of the creator's own videos and answers a question about it.
pub async fn watch(s: &AppState, user_id: &str, media_id: &str, question: &str) -> ApiResult<String> {
    let video = crate::igmedia::data_url(s, user_id, media_id, crate::igmedia::Part::Video).await.map_err(|e| AppError::new(502, format!("Couldn't read that video: {e}.")))?;
    let content = vec![
        json!({ "type": "input_text", "text": format!("Watch this video from the creator's own Instagram and answer in plain words, with timestamps where they help. Label guesses as guesses. Question: {question}") }),
        json!({ "type": "input_video", "video_url": video }),
    ];
    meta_ai::wonder(s, user_id, content).await.map(|(text, _)| text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_best_videos_go_to_wonder_and_every_caption_goes_along() {
        let ig = json!({ "accounts": [{ "media": [
            { "id": "p", "media_type": "IMAGE", "media_url": "https://cdn/p.jpg", "caption": "photo", "like_count": 900, "comments_count": 0 },
            { "media_type": "VIDEO", "media_product_type": "REELS", "id": "a", "media_url": "https://cdn/a.mp4", "permalink": "https://ig/a", "caption": "a", "like_count": 5, "comments_count": 1 },
            { "media_type": "VIDEO", "id": "b", "media_url": "https://cdn/b.mp4", "permalink": "https://ig/b", "caption": "b", "like_count": 50, "comments_count": 9 },
            { "media_type": "VIDEO", "caption": "no url", "like_count": 99 },
            { "media_type": "VIDEO", "id": "c", "media_url": "https://cdn/c.mp4", "caption": "c", "like_count": 1 },
            { "media_type": "VIDEO", "id": "d", "media_url": "https://cdn/d.mp4", "caption": "d", "like_count": 0 },
        ] }] });
        let c = context(&ig);
        let ids: Vec<&str> = c["videos"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["b", "a", "c"], "best first, at most three, only playable videos");
        assert!(!c.to_string().contains("cdn/"), "Instagram's links stay on the server");
        assert_eq!(c["posts"].as_array().unwrap().len(), 6);
        assert!(!c["posts"].to_string().contains("cdn/"), "captions and counts only");
        assert_eq!(context(&json!({ "accounts": [] }))["videos"], json!([]));
        assert_eq!(c["skipped"].as_array().map(|v| v.iter().map(|x| x["caption"].as_str().unwrap()).collect::<Vec<_>>()), Some(vec!["no url"]), "a withheld Reel is named");
    }
}
