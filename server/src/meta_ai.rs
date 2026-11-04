//! Meta Model API (api.meta.ai) for the media jobs: Muse Wonder watches videos, Muse Voice Transcribe
//! hears voice notes and SAM 3.1 finds the subject in a picture. Server-side only, under its own budget.
//! Muse Image is never called: Meta's geographic policy bars it from India, where Stupid runs.
use crate::{digest, lock, now, ApiResult, AppError, AppState};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const WONDER: &str = "muse-wonder-1.0";
pub const VOICE: &str = "muse-voice-transcribe-1.0";
pub const SAM: &str = "sam-3.1";

/// What a call is billed on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Units {
    WonderTokens(u64, u64),
    AudioSecs(u64),
    Images(u64),
}

/// Model API list prices (dev.meta.ai/docs/pricing-rate-limits, read 2026-11-04).
pub fn cost(units: Units) -> f64 {
    match units {
        Units::WonderTokens(input, output) => (input as f64 * 4.0 + output as f64 * 20.0) / 1e6,
        Units::AudioSecs(secs) => secs as f64 * 0.18 / 3600.0,
        Units::Images(n) => n as f64 * 2.5 / 1000.0,
    }
}

/// Contributor models may train on inputs and must not get personal data (ToS 6.2); Muse Image is barred in India.
pub fn allowed(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    !m.contains("contributor") && !m.starts_with("muse-image")
}

/// What a refused call means, in plain words.
fn refusal(status: u16, retry_after: Option<&str>) -> String {
    match status {
        401 => "Stupid's Meta Model API key was refused.".into(),
        402 => "The Meta Model API account is out of credit, so this feature is unavailable.".into(),
        403 => "This Meta model isn't available to Stupid's key.".into(),
        429 => match retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
            Some(secs) => format!("The Meta model is busy. Try again in {secs} seconds."),
            None => "The Meta model is busy. Try again in a minute.".into(),
        },
        503 => "The Meta model is busy right now. Try again in a minute.".into(),
        504 => "The Meta model took too long to answer. Try again.".into(),
        _ => "The Meta model refused the request.".into(),
    }
}

enum Body {
    Json(Value),
    Multipart(String, Vec<u8>),
}

/// One call under STUPID_META_API_BUDGET_USD. `estimate` is the worst case, checked before sending.
async fn post(s: &AppState, model: &str, estimate: f64, path: &str, body: Body) -> ApiResult<Value> {
    if !allowed(model) {
        return Err(AppError::new(400, format!("{model} is not allowed in Stupid.")));
    }
    if s.cfg.meta_api_key.is_empty() {
        return Err(AppError::new(503, "Meta Model API features are not set up on this server."));
    }
    let spent: f64 = lock(&s.db).query_row("SELECT COALESCE(SUM(usd),0) FROM meta_api_spend", [], |r| r.get(0))?;
    // ponytail: check-then-record, so parallel calls can pass the cap by one call (cents).
    if spent + estimate > s.cfg.meta_api_budget_usd {
        return Err(AppError::new(402, "The Meta Model API budget for this workspace is used up."));
    }
    let request = s.http.post(format!("{}{path}", s.cfg.meta_api_base.trim_end_matches('/'))).bearer_auth(&s.cfg.meta_api_key)
        .header("accept", "application/json").timeout(Duration::from_secs(120));
    let request = match body {
        Body::Json(v) => request.json(&v),
        Body::Multipart(boundary, bytes) => request.header("content-type", format!("multipart/form-data; boundary={boundary}")).body(bytes),
    };
    let response = request.send().await
        .map_err(|e| if e.is_timeout() { AppError::new(504, refusal(504, None)) } else { AppError::new(502, "The Meta Model API could not be reached.") })?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let detail: String = response.text().await.unwrap_or_default().chars().take(300).collect();
        tracing::warn!(model, %status, detail, "meta api refused");
        return Err(AppError::new(502, refusal(status.as_u16(), retry_after.as_deref())));
    }
    response.json().await.map_err(|_| AppError::new(502, "The Meta model sent an unreadable answer."))
}

/// Meta keeps media it fetched for a call as an account file with no expiry. Delete the ones made since `since`,
/// so a customer's video or picture is not left behind.
// ponytail: deletes by time window, so a call running alongside can lose its file; fine at this volume.
async fn drop_files(s: &AppState, since: i64) {
    let base = s.cfg.meta_api_base.trim_end_matches('/');
    let Ok(list) = s.http.get(format!("{base}/files")).bearer_auth(&s.cfg.meta_api_key).send().await else { return };
    let files: Value = list.json().await.unwrap_or_default();
    for f in files["data"].as_array().into_iter().flatten().filter(|f| f["created_at"].as_i64().is_some_and(|t| t >= since - 5)) {
        let Some(id) = f["id"].as_str() else { continue };
        if s.http.delete(format!("{base}/files/{id}")).bearer_auth(&s.cfg.meta_api_key).send().await.map_or(true, |r| !r.status().is_success()) {
            tracing::warn!(file = id, "meta api file not deleted");
        }
    }
}

fn record(s: &AppState, model: &str, units: Units, started: Instant) -> ApiResult<f64> {
    let usd = cost(units);
    lock(&s.db).execute("INSERT INTO meta_api_spend (model,usd,created) VALUES (?1,?2,?3)", params![model, usd, now()])?;
    tracing::info!(model, units = ?units, cost_usd = format!("{usd:.4}"), ms = started.elapsed().as_millis() as u64, "meta api call");
    Ok(usd)
}

/// The text parts of a Responses API answer.
fn output_text(data: &Value) -> String {
    data["output"].as_array().into_iter().flatten()
        .flat_map(|o| o["content"].as_array().into_iter().flatten())
        .filter(|c| c["type"] == "output_text")
        .filter_map(|c| c["text"].as_str())
        .collect()
}

/// A Responses API call with one user message. The person's id goes to Meta only as a hash.
fn responses_body(model: &str, user_id: &str, content: Vec<Value>) -> Value {
    json!({ "model": model, "safety_identifier": digest(user_id), "input": [{ "type": "message", "role": "user", "content": content }] })
}

/// Muse Wonder watches videos or reads images and answers in text. `content` holds `input_text` and
/// `input_video` / `input_image` parts. Returns the answer and its cost.
pub async fn wonder(s: &AppState, user_id: &str, content: Vec<Value>) -> ApiResult<(String, f64)> {
    const MAX_OUTPUT: u64 = 6000;
    let mut body = responses_body(WONDER, user_id, content);
    body["max_output_tokens"] = json!(MAX_OUTPUT);
    body["reasoning"] = json!({ "effort": "low" });
    // Rough worst case: a few short videos plus every output token.
    let (started, since) = (Instant::now(), now());
    let data = post(s, WONDER, cost(Units::WonderTokens(200_000, MAX_OUTPUT)), "/responses", Body::Json(body)).await;
    drop_files(s, since).await;
    let data = data?;
    let usage = &data["usage"];
    let units = Units::WonderTokens(usage["input_tokens"].as_u64().unwrap_or(200_000), usage["output_tokens"].as_u64().unwrap_or(MAX_OUTPUT));
    let usd = record(s, WONDER, units, started)?;
    if data["status"] == "incomplete" {
        return Err(AppError::new(502, "Muse Wonder ran out of room before it finished. Run it again."));
    }
    Ok((output_text(&data), usd))
}

/// SAM 3.1 finds every `noun` in the image and returns its raw box and mask tokens (empty when nothing matches).
pub async fn segment(s: &AppState, user_id: &str, image_url: &str, noun: &str) -> ApiResult<(String, f64)> {
    let body = responses_body(SAM, user_id, vec![json!({ "type": "input_text", "text": noun }), json!({ "type": "input_image", "image_url": image_url })]);
    let (started, since) = (Instant::now(), now());
    let data = post(s, SAM, cost(Units::Images(1)), "/responses", Body::Json(body)).await;
    drop_files(s, since).await;
    let data = data?;
    let usd = record(s, SAM, Units::Images(1), started)?;
    Ok((output_text(&data), usd))
}

/// Length in whole seconds of a mono 16-bit PCM WAV at 16 or 24 kHz, the only audio Voice Transcribe takes.
/// Walks the RIFF chunks, since encoders may put others (JUNK, LIST) before `fmt ` and `data`.
pub fn wav_secs(wav: &[u8]) -> Option<u64> {
    let u16_at = |i: usize| wav.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |i: usize| wav.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if wav.get(0..4)? != b"RIFF" || wav.get(8..12)? != b"WAVE" {
        return None;
    }
    let (mut at, mut rate, mut data) = (12, None, None);
    while let (Some(id), Some(size)) = (wav.get(at..at + 4), u32_at(at + 4)) {
        let body = at + 8;
        match id {
            b"fmt " if u16_at(body)? == 1 && u16_at(body + 2)? == 1 && u16_at(body + 14)? == 16 => rate = u32_at(body + 4),
            b"fmt " => return None,
            // A streamed WAV may leave the data size unset; count what is there.
            b"data" => data = Some((size as usize).min(wav.len() - body)),
            _ => {}
        }
        at = body + size as usize + (size as usize & 1);
    }
    let rate = rate.filter(|r| *r == 16_000 || *r == 24_000)? as u64;
    Some((data? as u64).div_ceil(rate * 2))
}

/// Muse Voice Transcribe turns a voice note (WAV, see `wav_secs`) into text. Returns the transcript and its cost.
pub async fn transcribe(s: &AppState, wav: &[u8]) -> ApiResult<(String, f64)> {
    let secs = wav_secs(wav).ok_or_else(|| AppError::new(400, "Voice notes must be mono 16-bit WAV at 16 or 24 kHz."))?;
    if secs > 600 {
        return Err(AppError::new(400, "Voice notes over 10 minutes can't be transcribed."));
    }
    let boundary = format!("stupid{}", &digest(&now().to_string())[..16]);
    let settings = json!({ "model": VOICE, "audioEncoding": "WAV", "mode": "PUSH_TO_TALK" });
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n{settings}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"note.wav\"\r\nContent-Type: audio/wav\r\n\r\n").into_bytes();
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let started = Instant::now();
    let data = post(s, VOICE, cost(Units::AudioSecs(secs)), "/asr/transcribe", Body::Multipart(boundary, body)).await?;
    let usd = record(s, VOICE, Units::AudioSecs(secs), started)?;
    Ok((data["transcript"].as_str().unwrap_or_default().trim().to_string(), usd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_follow_the_list() {
        assert!((cost(Units::AudioSecs(3600)) - 0.18).abs() < 1e-9);
        assert!((cost(Units::Images(1000)) - 2.5).abs() < 1e-9);
        assert!((cost(Units::WonderTokens(1_000_000, 1_000_000)) - 24.0).abs() < 1e-9);
    }

    #[test]
    fn contributor_and_muse_image_are_refused() {
        assert!(allowed(WONDER) && allowed(VOICE) && allowed(SAM));
        assert!(!allowed("muse-spark-1.3-contributor"));
        assert!(!allowed("muse-image-1.0"));
    }

    #[test]
    fn refusals_in_plain_words() {
        assert!(refusal(402, None).contains("unavailable"));
        assert_eq!(refusal(429, Some("12")), "The Meta model is busy. Try again in 12 seconds.");
        assert!(refusal(403, None).contains("isn't available"));
        assert!(refusal(504, None).contains("too long"));
    }

    fn wav(rate: u32, bits: u16, secs: u32) -> Vec<u8> {
        let data = rate * 2 * secs;
        let mut w = b"RIFF".to_vec();
        w.extend((36 + data).to_le_bytes());
        w.extend(b"WAVEfmt ");
        w.extend(16u32.to_le_bytes());
        w.extend(1u16.to_le_bytes());
        w.extend(1u16.to_le_bytes());
        w.extend(rate.to_le_bytes());
        w.extend((rate * 2).to_le_bytes());
        w.extend(2u16.to_le_bytes());
        w.extend(bits.to_le_bytes());
        w.extend(b"data");
        w.extend(data.to_le_bytes());
        w.resize(44 + data as usize, 0);
        w
    }

    #[test]
    fn wav_length_and_format() {
        assert_eq!(wav_secs(&wav(16_000, 16, 3)), Some(3));
        assert_eq!(wav_secs(&wav(24_000, 16, 1)), Some(1));
        assert_eq!(wav_secs(&wav(44_100, 16, 1)), None);
        assert_eq!(wav_secs(&wav(16_000, 8, 1)), None);
        assert_eq!(wav_secs(b"OggS"), None);
        let mut junk = wav(16_000, 16, 2);
        junk.splice(12..12, b"JUNK\x04\0\0\0abcd".iter().copied());
        assert_eq!(wav_secs(&junk), Some(2));
    }

    #[test]
    fn responses_text_and_hashed_user() {
        let data = json!({ "output": [{ "type": "reasoning" }, { "type": "message", "content": [{ "type": "output_text", "text": "a" }, { "type": "output_text", "text": "b" }] }] });
        assert_eq!(output_text(&data), "ab");
        let body = responses_body(SAM, "user-1", vec![]);
        assert_eq!(body["safety_identifier"].as_str().unwrap().len(), 64);
        assert!(!body.to_string().contains("user-1"));
    }

    /// One tiny live call per model. Run by hand: STUPID_META_API_KEY set, STUPID_LIVE_WAV a 16 kHz WAV,
    /// `cargo test live_meta_api -- --ignored --nocapture`. Costs cents.
    #[tokio::test]
    #[ignore]
    async fn live_meta_api() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrate(&mut conn).unwrap();
        let s = AppState { cfg: std::sync::Arc::new(crate::Config::load()), db: std::sync::Arc::new(std::sync::Mutex::new(conn)), http: reqwest::Client::new(), fernet: None, cache: Default::default(), queue: Default::default() };
        let wav = std::fs::read(std::env::var("STUPID_LIVE_WAV").unwrap()).unwrap();
        match transcribe(&s, &wav).await { Ok((t, usd)) => println!("VOICE ok ${usd:.5}: {t}"), Err(e) => println!("VOICE refused: {}", e.1) }
        match segment(&s, "live-test", "https://upload.wikimedia.org/wikipedia/commons/4/45/A_small_cup_of_coffee.JPG", "cup").await {
            Ok((t, usd)) => println!("SAM ok ${usd:.5}: {}…", t.chars().take(120).collect::<String>()),
            Err(e) => println!("SAM refused: {}", e.1),
        }
        let content = vec![json!({ "type": "input_text", "text": "In one sentence, what happens in this video?" }), json!({ "type": "input_video", "video_url": "https://www.w3schools.com/html/mov_bbb.mp4" })];
        match wonder(&s, "live-test", content).await { Ok((t, usd)) => println!("WONDER ok ${usd:.5}: {t}"), Err(e) => println!("WONDER refused: {}", e.1) }
        let files: Value = s.http.get(format!("{}/files", s.cfg.meta_api_base)).bearer_auth(&s.cfg.meta_api_key).send().await.unwrap().json().await.unwrap();
        println!("FILES left: {}", files["data"].as_array().map_or(0, Vec::len));
    }
}
