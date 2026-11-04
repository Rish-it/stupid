//! Customer voice notes. The server downloads the audio from Meta, decodes it to 16 kHz mono WAV with ffmpeg,
//! and Muse Voice Transcribe turns it into words. Only the words are kept, as the message's text; the audio
//! is never stored. Then the message becomes a trigger like any other, so the agent can draft a reply.
use crate::{lock, meta, meta_ai, random_token, tickets, tokens, user_by_id, AppState};
use rusqlite::{params, OptionalExtension};
use std::{process::Command, time::Duration};

/// WhatsApp caps audio at 16 MB; Meta's other apps send less.
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;

/// New inbox events: text goes straight to the agent, voice notes after they are transcribed.
pub fn arrived(s: &AppState, ids: &[i64]) {
    let pending: Vec<i64> = {
        let db = lock(&s.db);
        ids.iter().copied().filter(|id| {
            db.query_row("SELECT media IS NOT NULL FROM events WHERE id=?1", [id], |r| r.get::<_, bool>(0)).unwrap_or(false)
        }).collect()
    };
    let text: Vec<i64> = ids.iter().copied().filter(|id| !pending.contains(id)).collect();
    tickets::inbound(s, &text);
    for id in pending {
        let s = s.clone();
        tokio::spawn(async move {
            let heard = hear(&s, id).await;
            if let Err(e) = &heard {
                tracing::warn!(event = id, "voice note: {e}");
            }
            if let Err(e) = store(&lock(&s.db), id, heard) {
                tracing::error!("voice note {id}: {e}");
            }
            tickets::inbound(&s, &[id]);
        });
    }
}

/// Keep the words in place of the audio reference. A failure is said plainly in the message itself.
pub fn store(db: &rusqlite::Connection, id: i64, heard: Result<String, String>) -> rusqlite::Result<()> {
    let text = match heard {
        Ok(words) if !words.trim().is_empty() => words.trim().chars().take(4000).collect(),
        Ok(_) => "(A voice note with no words in it.)".to_string(),
        Err(e) => format!("(A voice note Stupid couldn't transcribe: {e})"),
    };
    db.execute("UPDATE events SET text=?2, voice=1, media=NULL WHERE id=?1", params![id, text]).map(drop)
}

pub async fn hear(s: &AppState, id: i64) -> Result<String, String> {
    let found: Option<(String, Option<String>)> = lock(&s.db)
        .query_row("SELECT asset_id,media FROM events WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional().map_err(|e| e.to_string())?;
    let Some((asset, Some(media))) = found else { return Err("the message is gone".into()) };
    let audio = if let Some(media_id) = media.strip_prefix("wa:") {
        // WhatsApp gives a short-lived URL for the media id; both calls need the business's token.
        let token = token_for(s, &asset)?;
        let info = meta::get(s, media_id, &[], &token).await.map_err(|_| "WhatsApp no longer has the audio".to_string())?;
        let url = info["url"].as_str().ok_or("WhatsApp gave no download link")?;
        download(s, url, Some(&token)).await?
    } else if let Some(url) = media.strip_prefix("url:").filter(|u| u.starts_with("https://")) {
        download(s, url, None).await?
    } else {
        return Err("unknown audio source".into());
    };
    let wav = tokio::task::spawn_blocking(move || decode(&audio)).await.map_err(|e| e.to_string())??;
    meta_ai::transcribe(s, &wav).await.map(|(words, _)| words).map_err(|e| e.1)
}

/// The token of the person who has this account switched on.
fn token_for(s: &AppState, asset: &str) -> Result<String, String> {
    let owner = tickets::owners(&lock(&s.db), asset).map_err(|e| e.to_string())?.into_iter().next().ok_or("nobody has this account switched on")?;
    let u = user_by_id(s, &owner).map_err(|e| e.1)?;
    let key = u.assets.iter().find(|a| a.id == asset).map(|a| a.key.clone()).ok_or("account not found")?;
    let all = tokens(s, &u).map_err(|e| e.1)?;
    Ok(all.for_asset(&key).to_string())
}

async fn download(s: &AppState, url: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
    let mut request = s.http.get(url).header("user-agent", "Stupid/0.1 (+https://app.secndai.com)").timeout(Duration::from_secs(60));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|_| "couldn't download the audio".to_string())?;
    if !response.status().is_success() {
        return Err(format!("the audio download was refused ({})", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|_| "the audio download broke off".to_string())?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("the voice note is over 16 MB".into());
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
        store(&db, 1, Ok(" How much is the blue mug? ".into())).unwrap();
        store(&db, 2, Err("the voice note is over 16 MB".into())).unwrap();
        let row = |id: i64| db.query_row("SELECT text,voice,media FROM events WHERE id=?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?))).unwrap();
        assert_eq!(row(1), ("How much is the blue mug?".into(), true, None), "the words replace the audio reference");
        assert_eq!(row(2).0, "(A voice note Stupid couldn't transcribe: the voice note is over 16 MB)");
        store(&db, 3, Ok("old".into())).unwrap();
        drop(db);
        crate::sweep(&s, false);
        let left: i64 = lock(&s.db).query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 2, "a transcript is deleted after 30 days like any message");
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
