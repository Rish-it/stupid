//! What customers send besides text. Voice notes: the server downloads the audio from Meta, decodes it to
//! 16 kHz mono WAV with ffmpeg, and Muse Voice Transcribe turns it into words. Photos: the model that runs the
//! person's agents looks at the picture. Videos: Muse Wonder watches them. Only the words are kept, in the
//! message's text; the media itself is never stored. Then the message becomes a trigger like any other.
use crate::{agents, lock, meta, meta_ai, random_token, tickets, tokens, user_by_id, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::{process::Command, time::Duration};

/// WhatsApp caps audio and video at 16 MB; Meta's other apps send less.
const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;

const SEE_PHOTO: &str = "A customer sent this photo to a small business. In one or two plain sentences, say what it shows that matters for a reply: the product, its colour or size, any visible text or price, damage, or what the customer seems to want. Say only what you can see.";
const WATCH_VIDEO: &str = "A customer sent this video to a small business. In two or three plain sentences, say what it shows that matters for a reply: the product, any problem shown, anything said aloud, and what the customer seems to want. Say only what you can see or hear.";

/// What a stored `media` reference holds: `photo:` and `video:` prefixes, else a voice note.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Media {
    Voice,
    Photo,
    Video,
}

pub fn media_kind(media: &str) -> (Media, &str) {
    if let Some(src) = media.strip_prefix("photo:") {
        (Media::Photo, src)
    } else if let Some(src) = media.strip_prefix("video:") {
        (Media::Video, src)
    } else {
        (Media::Voice, media)
    }
}

/// New inbox events: text goes straight to the agent; voice notes, photos and videos once they are put into words.
pub fn arrived(s: &AppState, ids: &[i64]) {
    let pending: Vec<(i64, Media)> = {
        let db = lock(&s.db);
        ids.iter().filter_map(|id| {
            let media: Option<String> = db.query_row("SELECT media FROM events WHERE id=?1", [id], |r| r.get(0)).ok()?;
            media.map(|m| (*id, media_kind(&m).0))
        }).collect()
    };
    let text: Vec<i64> = ids.iter().copied().filter(|id| !pending.iter().any(|(p, _)| p == id)).collect();
    tickets::inbound(s, &text);
    for (id, kind) in pending {
        let s = s.clone();
        tokio::spawn(async move {
            let heard = hear(&s, id).await;
            if let Err(e) = &heard {
                tracing::warn!(event = id, ?kind, "customer media: {e}");
            }
            if let Err(e) = store(&lock(&s.db), id, kind, heard) {
                tracing::error!("customer media {id}: {e}");
            }
            tickets::inbound(&s, &[id]);
        });
    }
}

/// Keep the words in place of the media reference, after any caption. A failure is said plainly in the message itself.
pub fn store(db: &rusqlite::Connection, id: i64, kind: Media, heard: Result<String, String>) -> rusqlite::Result<()> {
    let words = heard.map(|w| w.trim().chars().take(4000).collect::<String>());
    let said = match (kind, words) {
        (Media::Voice, Ok(w)) if !w.is_empty() => w,
        (Media::Voice, Ok(_)) => "(A voice note with no words in it.)".into(),
        (Media::Voice, Err(e)) => format!("(A voice note Stupid couldn't transcribe: {e})"),
        (Media::Photo, Ok(w)) => format!("(Photo: {w})"),
        (Media::Photo, Err(e)) => format!("(A photo Stupid couldn't look at: {e})"),
        (Media::Video, Ok(w)) => format!("(Video: {w})"),
        (Media::Video, Err(e)) => format!("(A video Stupid couldn't watch: {e})"),
    };
    let caption: String = db.query_row("SELECT text FROM events WHERE id=?1", [id], |r| r.get(0))?;
    let text = if kind == Media::Voice || caption.trim().is_empty() { said } else { format!("{}\n{said}", caption.trim()) };
    db.execute("UPDATE events SET text=?2, voice=?3, media=NULL WHERE id=?1", params![id, text, kind == Media::Voice]).map(drop)
}

pub async fn hear(s: &AppState, id: i64) -> Result<String, String> {
    let found: Option<(String, Option<String>)> = lock(&s.db)
        .query_row("SELECT asset_id,media FROM events WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional().map_err(|e| e.to_string())?;
    let Some((asset, Some(media))) = found else { return Err("the message is gone".into()) };
    let (kind, src) = media_kind(&media);
    let (bytes, mime) = fetch(s, &asset, src).await?;
    match kind {
        Media::Voice => {
            let wav = tokio::task::spawn_blocking(move || decode(&bytes)).await.map_err(|e| e.to_string())??;
            meta_ai::transcribe(s, &wav).await.map(|(words, _)| words).map_err(|e| e.1)
        }
        Media::Photo => {
            let owner = owner(s, &asset)?;
            let ai = agents::ai(s, &owner).map_err(|e| e.1)?;
            let url = format!("data:{};base64,{}", mime.unwrap_or_else(|| sniff(&bytes).into()), STANDARD.encode(&bytes));
            let messages = [json!({ "role": "system", "content": SEE_PHOTO }), json!({ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": url } }] })];
            let (data, _) = agents::chat(s, "photo", &messages, None, &ai).await.map_err(|e| e.1)?;
            let text = agents::answer(&data).map_err(|e| e.1)?;
            Ok(text.rsplit_once("</think>").map_or(text, |(_, t)| t).to_string())
        }
        Media::Video => {
            let owner = owner(s, &asset)?;
            let url = format!("data:{};base64,{}", mime.unwrap_or_else(|| "video/mp4".into()), STANDARD.encode(&bytes));
            let content = vec![json!({ "type": "input_text", "text": WATCH_VIDEO }), json!({ "type": "input_video", "video_url": url })];
            meta_ai::wonder(s, &owner, content).await.map(|(words, _)| words).map_err(|e| e.1)
        }
    }
}

/// The media's bytes and, when Meta says, its type. `wa:<media id>` needs the business's token; `url:` is a CDN link.
async fn fetch(s: &AppState, asset: &str, src: &str) -> Result<(Vec<u8>, Option<String>), String> {
    if let Some(media_id) = src.strip_prefix("wa:") {
        // WhatsApp gives a short-lived URL for the media id; both calls need the business's token.
        let token = token_for(s, asset)?;
        let info = meta::get(s, media_id, &[], &token).await.map_err(|_| "WhatsApp no longer has the file".to_string())?;
        let url = info["url"].as_str().ok_or("WhatsApp gave no download link")?;
        let mime = info["mime_type"].as_str().map(|m| m.split(';').next().unwrap_or(m).trim().to_string());
        Ok((download(s, url, Some(&token)).await?, mime))
    } else if let Some(url) = src.strip_prefix("url:").filter(|u| u.starts_with("https://")) {
        Ok((download(s, url, None).await?, None))
    } else {
        Err("unknown media source".into())
    }
}

/// An image's type from its first bytes, for links that don't say.
fn sniff(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "image/jpeg",
    }
}

/// The first person who has this account switched on.
fn owner(s: &AppState, asset: &str) -> Result<String, String> {
    tickets::owners(&lock(&s.db), asset).map_err(|e| e.to_string())?.into_iter().next().ok_or_else(|| "nobody has this account switched on".into())
}

/// The token of the person who has this account switched on.
fn token_for(s: &AppState, asset: &str) -> Result<String, String> {
    let u = user_by_id(s, &owner(s, asset)?).map_err(|e| e.1)?;
    let key = u.assets.iter().find(|a| a.id == asset).map(|a| a.key.clone()).ok_or("account not found")?;
    let all = tokens(s, &u).map_err(|e| e.1)?;
    Ok(all.for_asset(&key).to_string())
}

async fn download(s: &AppState, url: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
    let mut request = s.http.get(url).header("user-agent", "Stupid/0.1 (+https://app.secndai.com)").timeout(Duration::from_secs(60));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|_| "couldn't download the file".to_string())?;
    if !response.status().is_success() {
        return Err(format!("the download was refused ({})", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|_| "the download broke off".to_string())?;
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("the file is over 16 MB".into());
    }
    Ok(bytes.to_vec())
}

/// Any audio Meta sends (OGG/Opus, AAC, MP4) to the WAV Voice Transcribe takes, through temporary files
/// that are removed whatever happens.
pub fn decode(audio: &[u8]) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir();
    let name = random_token();
    let (input, output) = (dir.join(format!("stupid-voice-{name}.in")), dir.join(format!("stupid-voice-{name}.wav")));
    let result = (|| {
        std::fs::write(&input, audio).map_err(|e| e.to_string())?;
        let run = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"]).arg(&input)
            .args(["-t", "600", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav"]).arg(&output)
            .output().map_err(|_| "this server has no ffmpeg to read voice notes".to_string())?;
        if !run.status.success() {
            return Err(format!("the audio couldn't be read: {}", String::from_utf8_lossy(&run.stderr).lines().next().unwrap_or("unknown format")));
        }
        std::fs::read(&output).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&input);
    let _ = std::fs::remove_file(&output);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{now, tests_support::state_with_user};

    #[test]
    fn a_voice_note_becomes_its_words_and_expires_with_the_inbox() {
        let (s, _) = state_with_user();
        let db = lock(&s.db);
        for (id, created) in [(1, now()), (2, now()), (3, now() - 31 * 86_400)] {
            db.execute("INSERT INTO events (id,kind,asset_id,sender,text,created,media) VALUES (?1,'whatsapp','p1','91','',?2,'wa:777')", params![id, created]).unwrap();
        }
        store(&db, 1, Media::Voice, Ok(" How much is the blue mug? ".into())).unwrap();
        store(&db, 2, Media::Voice, Err("the file is over 16 MB".into())).unwrap();
        let row = |id: i64| db.query_row("SELECT text,voice,media FROM events WHERE id=?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?))).unwrap();
        assert_eq!(row(1), ("How much is the blue mug?".into(), true, None), "the words replace the audio reference");
        assert_eq!(row(2).0, "(A voice note Stupid couldn't transcribe: the file is over 16 MB)");
        store(&db, 3, Media::Voice, Ok("old".into())).unwrap();
        drop(db);
        crate::sweep(&s, false);
        let left: i64 = lock(&s.db).query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 2, "a transcript is deleted after 30 days like any message");
    }

    #[test]
    fn a_photo_or_video_becomes_what_it_shows_after_the_caption() {
        let (s, _) = state_with_user();
        let db = lock(&s.db);
        for (id, text, media) in [(1, "Do you have this in blue?", "photo:wa:1"), (2, "", "video:url:https://x"), (3, "", "photo:wa:3")] {
            db.execute("INSERT INTO events (id,kind,asset_id,sender,text,created,media) VALUES (?1,'whatsapp','p1','91',?2,0,?3)", params![id, text, media]).unwrap();
        }
        store(&db, 1, Media::Photo, Ok("A red ceramic mug with a chipped handle.".into())).unwrap();
        store(&db, 2, Media::Video, Ok("The lid of a jar doesn't close.".into())).unwrap();
        store(&db, 3, Media::Photo, Err("the download was refused (404)".into())).unwrap();
        let row = |id: i64| db.query_row("SELECT text,voice,media FROM events WHERE id=?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?))).unwrap();
        assert_eq!(row(1), ("Do you have this in blue?\n(Photo: A red ceramic mug with a chipped handle.)".into(), false, None));
        assert_eq!(row(2).0, "(Video: The lid of a jar doesn't close.)");
        assert_eq!(row(3).0, "(A photo Stupid couldn't look at: the download was refused (404))");
        assert_eq!(media_kind("photo:url:https://a"), (Media::Photo, "url:https://a"));
        assert_eq!(media_kind("wa:9"), (Media::Voice, "wa:9"));
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G']), "image/png");
    }

    /// A customer's photo, end to end through the person's model. `cargo test live_photo -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_photo() {
        let _ = dotenvy::dotenv();
        let (s, _) = state_with_user();
        let mut cfg = crate::Config::load();
        (cfg.muse_key, cfg.meta_api_budget_usd) = (String::new(), 1.0);
        let s = AppState { cfg: std::sync::Arc::new(cfg), ..s };
        lock(&s.db).execute("INSERT INTO events (id,kind,asset_id,sender,text,created,media) VALUES (1,'whatsapp','p1','91','How much?',0,'photo:url:https://raw.githubusercontent.com/github/explore/main/topics/rust/rust.png')", []).unwrap();
        let seen = hear(&s, 1).await;
        store(&lock(&s.db), 1, Media::Photo, seen).unwrap();
        println!("PHOTO {}", lock(&s.db).query_row("SELECT text FROM events WHERE id=1", [], |r| r.get::<_, String>(0)).unwrap());
    }

    #[test]
    fn ffmpeg_turns_audio_into_transcribable_wav() {
        // Skips quietly where ffmpeg isn't installed (CI); the server reports it plainly instead.
        let Ok(made) = Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", "-f", "ogg", "-"]).output() else { return };
        if !made.status.success() {
            return;
        }
        let wav = decode(&made.stdout).unwrap();
        assert_eq!(meta_ai::wav_secs(&wav), Some(2));
        assert!(decode(b"not audio").is_err());
    }
}
