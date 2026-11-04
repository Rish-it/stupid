//! The creator's own Instagram pictures and videos, downloaded here and kept under the data dir for a week.
//! Models get them inline (Muse can't fetch Instagram's CDN links) and the browser only ever sees
//! `/api/instagram/media/{id}/image`. Graph's CDN links expire, so a miss asks Graph for a fresh one first.
use crate::{meta, tokens, user_by_id, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::Write, path::PathBuf, process::Command, time::Duration};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Part {
    /// The post's image, or a video's cover frame.
    Picture,
    Video,
}

const MAX_PICTURE: usize = 10 * 1024 * 1024;
/// What one video is read up to; anything bigger is refused before it is fully downloaded.
const MAX_DOWNLOAD: usize = 200 * 1024 * 1024;
/// What Muse Wonder takes inline; a bigger video is made smaller with ffmpeg first.
pub const MAX_VIDEO: usize = 16 * 1024 * 1024;
const KEEP: Duration = Duration::from_secs(7 * 86400);

fn dir(s: &AppState) -> PathBuf {
    s.cfg.data_dir.join("media")
}

fn path(s: &AppState, id: &str, part: Part) -> PathBuf {
    dir(s).join(format!("{id}.{}", if part == Part::Video { "mp4" } else { "img" }))
}

/// One of the owner's posts as bytes, from the cache or freshly from Instagram.
pub async fn read(s: &AppState, user_id: &str, id: &str, part: Part) -> Result<Vec<u8>, String> {
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("not an Instagram post".into());
    }
    let file = path(s, id, part);
    let fresh = std::fs::metadata(&file).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age < KEEP));
    if fresh {
        if let Ok(bytes) = std::fs::read(&file) {
            return Ok(bytes);
        }
    }
    let url = link(s, user_id, id, part).await?;
    std::fs::create_dir_all(dir(s)).map_err(|e| e.to_string())?;
    let part_file = file.with_extension("part");
    let got = download(s, &url, if part == Part::Video { MAX_DOWNLOAD } else { MAX_PICTURE }, &part_file).await;
    let got = match (got, part) {
        (Ok(size), Part::Video) if size > MAX_VIDEO => {
            let (from, to) = (part_file.clone(), file.clone());
            tokio::task::spawn_blocking(move || shrink(&from, &to)).await.map_err(|e| e.to_string())?
        }
        (Ok(_), _) => std::fs::rename(&part_file, &file).map_err(|e| e.to_string()),
        (Err(e), _) => Err(e),
    };
    let _ = std::fs::remove_file(&part_file);
    got?;
    std::fs::read(&file).map_err(|e| e.to_string())
}

/// The post as a `data:` URL for a model.
pub async fn data_url(s: &AppState, user_id: &str, id: &str, part: Part) -> Result<String, String> {
    let bytes = read(s, user_id, id, part).await?;
    let mime = if part == Part::Video { "video/mp4" } else { crate::voice::sniff(&bytes) };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// These posts with their pictures swapped for inline copies, for a model that can't fetch Instagram's links.
/// A post that can't be read keeps its link and the model call falls back to text if it fails.
pub async fn inline_pictures(s: &AppState, user_id: &str, mut posts: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    for m in &mut posts {
        let field = if m["media_type"] == "VIDEO" { "thumbnail_url" } else { "media_url" };
        match data_url(s, user_id, m["id"].as_str().unwrap_or_default(), Part::Picture).await {
            Ok(url) => m[field] = url.into(),
            Err(e) => tracing::warn!("post picture {}: {e}", m["id"]),
        }
    }
    posts
}

/// A fresh CDN link for the post, asked of Graph with the token of the Instagram account it belongs to.
async fn link(s: &AppState, user_id: &str, id: &str, part: Part) -> Result<String, String> {
    let u = user_by_id(s, user_id).map_err(|e| e.1)?;
    let t = tokens(s, &u).map_err(|e| e.1)?;
    let mut last = "no Instagram account is switched on".to_string();
    for a in u.selected_assets("instagram") {
        match meta::get(s, id, &[("fields", "media_type,media_url,thumbnail_url".into())], t.for_asset(&a.key)).await {
            Ok(m) => {
                let url = match part {
                    Part::Video if m["media_type"] == "VIDEO" => m["media_url"].as_str(),
                    Part::Video => return Err("that post isn't a video".into()),
                    Part::Picture => crate::crops::picture(&m),
                };
                // Instagram leaves media_url out for posts with copyrighted music.
                return url.filter(|u| u.starts_with("https://")).map(str::to_owned).ok_or_else(|| "Instagram didn't share this post's file".into());
            }
            Err(e) => last = e.1,
        }
    }
    Err(last)
}

/// Stream the file to disk, stopping as soon as it passes `max` bytes. Returns its size.
async fn download(s: &AppState, url: &str, max: usize, to: &PathBuf) -> Result<usize, String> {
    let mut response = s.http.get(url).timeout(Duration::from_secs(120)).send().await.map_err(|_| "couldn't download the file".to_string())?;
    if !response.status().is_success() {
        return Err(format!("the download was refused ({})", response.status().as_u16()));
    }
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| "the download broke off".to_string())? {
        size += chunk.len();
        if size > max {
            return Err(format!("the file is over {} MB", max / 1024 / 1024));
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    Ok(size)
}

/// A long or sharp video made small enough for Muse Wonder: 480p, its first 90 seconds, lighter sound.
fn shrink(from: &PathBuf, to: &PathBuf) -> Result<(), String> {
    let run = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"]).arg(from)
        .args(["-t", "90", "-vf", "scale=-2:'min(480,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4"]).arg(to)
        .output().map_err(|_| "this server has no ffmpeg to shrink the video".to_string())?;
    let size = std::fs::metadata(to).map(|m| m.len() as usize).unwrap_or(usize::MAX);
    if !run.status.success() || size > MAX_VIDEO {
        let _ = std::fs::remove_file(to);
        return Err("the video is too large to watch even after shrinking".into());
    }
    Ok(())
}

/// Files older than a week leave the cache; the next read fetches them again.
pub fn sweep(s: &AppState) {
    for entry in std::fs::read_dir(dir(s)).into_iter().flatten().flatten() {
        if entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= KEEP)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_big_video_shrinks_under_the_inline_limit() {
        let dir = std::env::temp_dir().join(format!("stupid-igmedia-{}", crate::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let (from, to) = (dir.join("in.mp4"), dir.join("out.mp4"));
        let made = Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264"]).arg(&from).status();
        if !made.is_ok_and(|s| s.success()) {
            return; // no ffmpeg here; the server checks for it at run time
        }
        shrink(&from, &to).unwrap();
        let out = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0"]).arg(&to).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "480");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real account, read only: every post's picture and video through the cache, then the Reel director and post
    /// ideas on them. Needs a copy of the live database and its settings file; prints no tokens.
    /// `STUPID_LIVE_DB=<copy> STUPID_LIVE_ENV=<.env> cargo test live_instagram -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_instagram() {
        let env = std::env::var("STUPID_LIVE_ENV").unwrap();
        dotenvy::from_path(&env).unwrap();
        let mut conn = rusqlite::Connection::open(std::env::var("STUPID_LIVE_DB").unwrap()).unwrap();
        crate::migrate(&mut conn).unwrap();
        let user_id: String = conn.query_row("SELECT id FROM users LIMIT 1", [], |r| r.get(0)).unwrap();
        let mut cfg = crate::Config::load();
        cfg.data_dir = std::env::temp_dir().join("stupid-live-media");
        let fernet = fernet::Fernet::new(&std::env::var("STUPID_META_TOKEN_KEY").unwrap()).map(std::sync::Arc::new);
        let s = AppState { cfg: std::sync::Arc::new(cfg), db: std::sync::Arc::new(std::sync::Mutex::new(conn)), http: reqwest::Client::new(), fernet, cache: Default::default(), queue: Default::default() };
        let u = user_by_id(&s, &user_id).unwrap();
        let ig = meta::instagram_data(&s, &u).await.unwrap();
        for m in ig["accounts"][0]["media"].as_array().unwrap() {
            let id = m["id"].as_str().unwrap();
            let picture = read(&s, &user_id, id, Part::Picture).await.map(|b| b.len());
            let video = if m["media_type"] == "VIDEO" { Some(read(&s, &user_id, id, Part::Video).await.map(|b| b.len())) } else { None };
            println!("POST {id} {} {} likes={} comments={} caption={:?} picture={picture:?} video={video:?}", m["media_product_type"], m["permalink"], m["like_count"], m["comments_count"], m["caption"]);
        }
        let ai = crate::agents::ai(&s, &user_id).unwrap();
        if std::env::var("STUPID_LIVE_AI").is_ok() {
            let (reels, cost) = crate::reels::direct(&s, &user_id, &crate::reels::context(&ig), &ai).await.unwrap();
            println!("REELS ${cost:.4} from_captions_only={} watched={}", reels["from_captions_only"], serde_json::to_string_pretty(&reels["watched"]).unwrap());
            for sc in reels["scripts"].as_array().into_iter().flatten() {
                println!("SCRIPT {} | hook: {} | {} shots", sc["title"], sc["hook"], sc["shots"].as_array().map_or(0, Vec::len));
            }
            let system = crate::agents::system_for("ideas", crate::agents::AGENTS.iter().find(|(n, _)| *n == "ideas").unwrap().1, u.persona.as_deref());
            let (ideas, cost) = crate::agents::ideas(&s, &user_id, &system, &crate::agents::instagram_context(&ig), crate::crops::best(&ig, 6), &ai).await.unwrap();
            println!("IDEAS ${cost:.4} looked_at={} posts={}", ideas["looked_at"], ideas["looked_at_posts"]);
            for i in ideas["ideas"].as_array().into_iter().flatten() {
                println!("IDEA {} | why: {}", i["hook"], i["why"]);
            }
        }
    }
}
