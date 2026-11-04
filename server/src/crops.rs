//! Smart crops for ads: SAM 3.1 finds the product or subject in the creator's own post images and Reel covers,
//! and the browser crops each to 1:1, 4:5 and 9:16 around it. Only the boxes are stored, never pixels, and
//! nothing is uploaded to Ads.
use crate::{agents, meta, meta_ai, user, ApiResult, AppError, AppState};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::time::Duration;

/// Images per pack, best first.
const MAX_IMAGES: usize = 3;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

const NAMING: &str = "You help crop a creator's post images for ads. For each caption, in order, give the main product or subject \
as a short noun phrase of one to three words that a segmentation model can find, like \"ceramic mug\" or \"woman\". \
Use \"product\" when the caption doesn't say. Return JSON {\"subjects\":[string]}.";

/// The picture a post shows: its image, or a video's cover frame.
pub fn picture(m: &Value) -> Option<&str> {
    if m["media_type"] == "VIDEO" { m["thumbnail_url"].as_str() } else { m["media_url"].as_str() }
}

/// The creator's `n` best pictures by likes plus comments.
pub fn best(ig: &Value, n: usize) -> Vec<Value> {
    let mut media: Vec<Value> = ig["accounts"].as_array().into_iter().flatten()
        .flat_map(|a| a["media"].as_array().cloned().unwrap_or_default()).filter(|m| picture(m).is_some()).collect();
    media.sort_by_key(|m| -(m["like_count"].as_i64().unwrap_or(0) + m["comments_count"].as_i64().unwrap_or(0)));
    media.truncate(n);
    media
}

/// The largest box in SAM's answer, e.g. `<0f>0<|box;x1=422;y1=118;x2=1360;y2=792;w=1600;h=1200|><|mask;…|>`.
pub fn largest_box(tokens: &str) -> Option<Value> {
    let boxes = tokens.split("<|box;").skip(1).filter_map(|rest| {
        let fields = rest.split("|>").next()?;
        let get = |k: &str| fields.split(';').find_map(|kv| kv.strip_prefix(k)?.strip_prefix('=')?.parse::<f64>().ok());
        let (x1, y1, x2, y2, w, h) = (get("x1")?, get("y1")?, get("x2")?, get("y2")?, get("w")?, get("h")?);
        (x2 > x1 && y2 > y1 && w > 0.0 && h > 0.0).then(|| json!({ "x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": w, "h": h }))
    });
    boxes.max_by(|a, b| {
        let area = |v: &Value| (v["x2"].as_f64().unwrap_or(0.0) - v["x1"].as_f64().unwrap_or(0.0)) * (v["y2"].as_f64().unwrap_or(0.0) - v["y1"].as_f64().unwrap_or(0.0));
        area(a).total_cmp(&area(b))
    })
}

/// One SAM call for one of the creator's pictures.
pub async fn find(s: &AppState, user_id: &str, image_url: &str, subject: &str) -> ApiResult<Option<Value>> {
    let (tokens, _) = meta_ai::segment(s, user_id, image_url, subject).await?;
    Ok(largest_box(&tokens))
}

/// The ad creative pack: for each of the best pictures, the subject and where it is. Returns it and the Baseten cost.
pub async fn pack(s: &AppState, user_id: &str, ig: &Value, ai: &agents::Ai) -> (Vec<Value>, f64) {
    let media = best(ig, MAX_IMAGES);
    if media.is_empty() {
        return (Vec::new(), 0.0);
    }
    let captions: Vec<Value> = media.iter().map(|m| m["caption"].clone()).collect();
    let (subjects, cost) = match agents::muse(s, "crops", NAMING, &json!({ "captions": captions }), ai).await {
        Ok((v, cost)) => (v["subjects"].as_array().cloned().unwrap_or_default(), cost),
        Err(_) => (Vec::new(), 0.0),
    };
    let mut out = Vec::new();
    for (i, m) in media.iter().enumerate() {
        let subject = subjects.get(i).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty() && t.len() <= 60).unwrap_or("product");
        let url = picture(m).unwrap_or_default();
        let (found, note) = match find(s, user_id, url, subject).await {
            Ok(Some(b)) => (Some(b), Value::Null),
            Ok(None) => (None, json!(format!("SAM 3.1 didn't find \"{subject}\" in this picture, so the crops are centred."))),
            Err(e) => (None, json!(e.1)),
        };
        out.push(json!({ "id": m["id"], "permalink": m["permalink"], "caption": m["caption"], "subject": subject, "box": found, "note": note }));
    }
    (out, cost)
}

/// One of the person's own post pictures, from our origin, so the browser may crop and save it. Nothing is kept.
pub async fn image(State(s): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Response> {
    let u = user(&s, &headers)?;
    let ig = meta::instagram_data(&s, &u).await?;
    let url = ig["accounts"].as_array().into_iter().flatten().flat_map(|a| a["media"].as_array().into_iter().flatten())
        .find(|m| m["id"] == id.as_str()).and_then(picture).map(str::to_owned)
        .ok_or_else(|| AppError::new(404, "That picture isn't on your Instagram."))?;
    let response = s.http.get(&url).timeout(Duration::from_secs(30)).send().await.map_err(|_| AppError::new(502, "Instagram didn't send the picture."))?;
    let kind = response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    if !response.status().is_success() || !kind.starts_with("image/") {
        return Err(AppError::new(502, "Instagram didn't send the picture."));
    }
    let bytes = response.bytes().await.map_err(|_| AppError::new(502, "Instagram didn't send the picture."))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::new(502, "That picture is too large."));
    }
    let mut res = bytes.into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&kind).unwrap_or(HeaderValue::from_static("image/jpeg")));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_largest_box_wins() {
        let tokens = "<0f>0<|box;x1=10;y1=10;x2=20;y2=20;w=100;h=50|><|mask;x=0;y=0;data=~!|>,1<|box;x1=30;y1=5;x2=90;y2=45;w=100;h=50|><|mask;x=0;y=0;data=~|>";
        assert_eq!(largest_box(tokens), Some(json!({ "x1": 30.0, "y1": 5.0, "x2": 90.0, "y2": 45.0, "w": 100.0, "h": 50.0 })));
        assert_eq!(largest_box(""), None, "no match is a normal answer");
        assert_eq!(largest_box("<0f>0<|box;x1=9;y1=9;x2=1;y2=1;w=10;h=10|>"), None);
    }

    #[test]
    fn pictures_and_reel_covers_ranked() {
        let ig = json!({ "accounts": [{ "media": [
            { "id": "a", "media_type": "IMAGE", "media_url": "https://cdn/a.jpg", "like_count": 1 },
            { "id": "b", "media_type": "VIDEO", "media_url": "https://cdn/b.mp4", "thumbnail_url": "https://cdn/b.jpg", "like_count": 50 },
            { "id": "c", "media_type": "VIDEO", "media_url": "https://cdn/c.mp4", "like_count": 99 },
            { "id": "d", "media_type": "CAROUSEL_ALBUM", "media_url": "https://cdn/d.jpg", "like_count": 7 },
            { "id": "e", "media_type": "IMAGE", "media_url": "https://cdn/e.jpg", "like_count": 0 },
        ] }] });
        let ranked = best(&ig, 3);
        let ids: Vec<&str> = ranked.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["b", "d", "a"], "a video counts by its cover; one without a cover is skipped");
        assert_eq!(picture(&ranked[0]), Some("https://cdn/b.jpg"));
    }

    /// One live SAM 3.1 run on a public photo. `cargo test live_smart_crop -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_smart_crop() {
        let (s, _) = crate::tests_support::state_with_user();
        let found = find(&s, "u", "https://upload.wikimedia.org/wikipedia/commons/4/45/A_small_cup_of_coffee.JPG", "coffee cup").await.unwrap();
        println!("BOX {found:?}");
        assert!(found.is_some());
    }
}
