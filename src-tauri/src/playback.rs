use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use librespot::{
    connect::{ConnectConfig, LoadRequest, LoadRequestOptions, Spirc},
    core::{
        SpotifyUri, authentication::Credentials, cache::Cache, config::SessionConfig,
        session::Session,
    },
    metadata::audio::UniqueFields,
    metadata::{Metadata, Track},
    playback::{
        audio_backend,
        config::{AudioFormat, Bitrate, PlayerConfig},
        mixer::{self, MixerConfig},
        player::{Player, PlayerEvent},
    },
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

const DEVICE_NAME: &str = "Winampfy Desktop";
const OAUTH_REDIRECT: &str = "http://127.0.0.1:8898/login";
const AUDIO_CACHE_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct PlayerStatus {
    state: String,
    device_name: String,
    message: String,
    track_title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<u32>,
    position_ms: Option<u32>,
}

#[derive(Clone, Serialize)]
pub struct SpotifySearchTrack {
    uri: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: u32,
}

impl Default for PlayerStatus {
    fn default() -> Self {
        Self {
            state: "disconnected".into(),
            device_name: DEVICE_NAME.into(),
            message: "Spotify Premium hesabınızla bağlanın".into(),
            track_title: None,
            artist: None,
            duration_ms: None,
            position_ms: None,
        }
    }
}

pub struct PlayerState {
    status: Arc<RwLock<PlayerStatus>>,
    spirc: Arc<Mutex<Option<Spirc>>>,
    session: Arc<Mutex<Option<Session>>>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(PlayerStatus::default())),
            spirc: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
pub async fn player_status(state: State<'_, PlayerState>) -> Result<PlayerStatus, String> {
    Ok(state.status.read().await.clone())
}

#[tauri::command]
pub async fn spotify_login(
    app: AppHandle,
    state: State<'_, PlayerState>,
) -> Result<PlayerStatus, String> {
    if state
        .spirc
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())?
        .is_some()
    {
        return Ok(state.status.read().await.clone());
    }

    set_connection_status(
        &state.status,
        "connecting",
        "Tarayıcıda Spotify girişini tamamlayın",
    )
    .await;

    let result = initialise_player(
        &app,
        state.status.clone(),
        state.spirc.clone(),
        state.session.clone(),
    )
    .await;
    if let Err(error) = result {
        set_connection_status(&state.status, "error", &error).await;
        return Err(error);
    }

    set_connection_status(
        &state.status,
        "ready",
        "Bağlandı — ADD URL ile şarkı arayın",
    )
    .await;
    Ok(state.status.read().await.clone())
}

async fn initialise_player(
    app: &AppHandle,
    status: Arc<RwLock<PlayerStatus>>,
    spirc_slot: Arc<Mutex<Option<Spirc>>>,
    session_slot: Arc<Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session_config = SessionConfig::default();
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Önbellek dizini bulunamadı: {error}"))?
        .join("librespot");
    let audio_cache = cache_root.join("audio");
    let cache = Cache::new(
        Some(cache_root.clone()),
        Some(cache_root),
        Some(audio_cache),
        Some(AUDIO_CACHE_LIMIT),
    )
    .map_err(|error| format!("Librespot önbelleği açılamadı: {error}"))?;

    let credentials = match cache.credentials() {
        Some(credentials) => credentials,
        None => {
            let client_id = session_config.client_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                librespot_oauth::OAuthClientBuilder::new(
                    &client_id,
                    OAUTH_REDIRECT,
                    vec!["streaming"],
                )
                .open_in_browser()
                .build()
                .and_then(|client| client.get_access_token())
                .map(|token| Credentials::with_access_token(token.access_token))
                .map_err(|error| format!("Spotify OAuth tamamlanamadı: {error}"))
            })
            .await
            .map_err(|error| format!("Spotify giriş görevi başarısız: {error}"))??
        }
    };
    cache.save_credentials(&credentials);

    let session = Session::new(session_config, Some(cache));
    let sink_builder = audio_backend::find(None)
        .ok_or_else(|| "Bu sistem için uygun ses çıkışı bulunamadı".to_string())?;
    let mixer_builder = mixer::find(None)
        .ok_or_else(|| "Bu sistem için uygun ses mikseri bulunamadı".to_string())?;
    let mixer = mixer_builder(MixerConfig::default())
        .map_err(|error| format!("Ses mikseri başlatılamadı: {error}"))?;

    let player_config = PlayerConfig {
        bitrate: Bitrate::Bitrate320,
        position_update_interval: Some(Duration::from_millis(250)),
        ..PlayerConfig::default()
    };
    let player = Player::new(
        player_config,
        session.clone(),
        mixer.get_soft_volume(),
        move || sink_builder(None, AudioFormat::default()),
    );
    let player_events = player.get_player_event_channel();

    let connect_config = ConnectConfig {
        name: DEVICE_NAME.into(),
        initial_volume: ((u16::MAX as u32 * 72) / 100) as u16,
        ..ConnectConfig::default()
    };
    let (spirc, spirc_task) = Spirc::new(
        connect_config,
        session.clone(),
        credentials,
        player,
        mixer,
    )
        .await
        .map_err(|error| format!("Spotify oturumu açılamadı: {error}"))?;

    spirc
        .activate()
        .map_err(|error| format!("Winampfy cihazı etkinleştirilemedi: {error}"))?;
    *spirc_slot
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())? = Some(spirc);
    *session_slot
        .lock()
        .map_err(|_| "Spotify session lock failed".to_string())? = Some(session);

    tauri::async_runtime::spawn(spirc_task);
    tauri::async_runtime::spawn(watch_player_events(player_events, status));
    Ok(())
}

async fn watch_player_events(
    mut events: librespot::playback::player::PlayerEventChannel,
    status: Arc<RwLock<PlayerStatus>>,
) {
    while let Some(event) = events.recv().await {
        let mut current = status.write().await;
        match event {
            PlayerEvent::TrackChanged { audio_item } => {
                current.track_title = Some(audio_item.name.clone());
                current.artist = artist_name(&audio_item.unique_fields);
                current.duration_ms = Some(audio_item.duration_ms);
                current.position_ms = Some(0);
                current.message = "Parça yüklendi".into();
            }
            PlayerEvent::Playing { position_ms, .. }
            | PlayerEvent::PositionChanged { position_ms, .. }
            | PlayerEvent::PositionCorrection { position_ms, .. }
            | PlayerEvent::Seeked { position_ms, .. } => {
                current.state = "playing".into();
                current.position_ms = Some(position_ms);
                current.message = "Çalıyor".into();
            }
            PlayerEvent::Paused { position_ms, .. } => {
                current.state = "paused".into();
                current.position_ms = Some(position_ms);
                current.message = "Duraklatıldı".into();
            }
            PlayerEvent::Stopped { .. } => {
                current.state = "ready".into();
                current.message = "Oynatma durdu".into();
            }
            PlayerEvent::EndOfTrack { .. } => {
                current.state = "ended".into();
                current.message = "Parça tamamlandı".into();
            }
            PlayerEvent::Unavailable { .. } => {
                current.state = "error".into();
                current.message = "Bu parça oynatılamıyor".into();
            }
            PlayerEvent::SessionDisconnected { .. } => {
                current.state = "error".into();
                current.message = "Spotify oturumu kesildi".into();
            }
            _ => {}
        }
    }
}

fn artist_name(fields: &UniqueFields) -> Option<String> {
    match fields {
        UniqueFields::Track { artists, .. } => Some(
            artists
                .0
                .iter()
                .map(|artist| artist.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        UniqueFields::Local { artists, .. } => artists.clone(),
        UniqueFields::Episode { show_name, .. } => Some(show_name.clone()),
    }
}

async fn set_connection_status(
    status: &Arc<RwLock<PlayerStatus>>,
    connection_state: &str,
    message: &str,
) {
    let mut current = status.write().await;
    current.state = connection_state.into();
    current.message = message.into();
}

fn with_spirc(
    state: &State<'_, PlayerState>,
    action: impl FnOnce(&Spirc) -> Result<(), librespot::core::Error>,
) -> Result<(), String> {
    let guard = state
        .spirc
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())?;
    let spirc = guard
        .as_ref()
        .ok_or_else(|| "Önce Spotify hesabınızı bağlayın".to_string())?;
    action(spirc).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn player_play(state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, Spirc::play)
}

#[tauri::command]
pub fn player_pause(state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, Spirc::pause)
}

#[tauri::command]
pub fn player_stop(state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, Spirc::pause)
}

#[tauri::command]
pub fn player_previous(state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, Spirc::prev)
}

#[tauri::command]
pub fn player_next(state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, Spirc::next)
}

#[tauri::command]
pub fn player_seek(position_ms: u32, state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, |spirc| spirc.set_position_ms(position_ms))
}

#[tauri::command]
pub fn player_set_volume(volume: u8, state: State<'_, PlayerState>) -> Result<(), String> {
    let volume = ((u16::MAX as u32 * volume.min(100) as u32) / 100) as u16;
    with_spirc(&state, |spirc| spirc.set_volume(volume))
}

#[tauri::command]
pub fn player_set_shuffle(enabled: bool, state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, |spirc| spirc.shuffle(enabled))
}

#[tauri::command]
pub fn player_set_repeat(enabled: bool, state: State<'_, PlayerState>) -> Result<(), String> {
    with_spirc(&state, |spirc| spirc.repeat(enabled))
}

#[tauri::command]
pub fn player_load_uri(
    uri: String,
    auto_play: Option<bool>,
    state: State<'_, PlayerState>,
) -> Result<(), String> {
    let uri = normalise_spotify_uri(&uri)?;
    let options = LoadRequestOptions {
        start_playing: auto_play.unwrap_or(true),
        ..LoadRequestOptions::default()
    };
    let request = if uri.starts_with("spotify:track:") || uri.starts_with("spotify:episode:") {
        LoadRequest::from_tracks(vec![uri], options)
    } else {
        LoadRequest::from_context_uri(uri, options)
    };
    with_spirc(&state, |spirc| spirc.load(request))
}

#[tauri::command]
pub async fn spotify_search(
    query: String,
    limit: Option<u8>,
    state: State<'_, PlayerState>,
) -> Result<Vec<SpotifySearchTrack>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Arama metni boş olamaz".into());
    }

    let session = state
        .session
        .lock()
        .map_err(|_| "Spotify session lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Önce Spotify hesabınızı bağlayın".to_string())?;

    let search_uri = format!("spotify:search:{}", query.split_whitespace().collect::<Vec<_>>().join("+"));
    let context = session
        .spclient()
        .get_context(&search_uri)
        .await
        .map_err(|error| format!("Spotify araması başarısız: {error}"))?;

    let uris = context
        .pages
        .into_iter()
        .flat_map(|page| page.tracks)
        .filter_map(|track| track.uri)
        .take(limit.unwrap_or(10).clamp(1, 10) as usize)
        .collect::<Vec<_>>();

    let mut results = Vec::with_capacity(uris.len());
    for uri in uris {
        let parsed_uri = SpotifyUri::from_uri(&uri)
            .map_err(|error| format!("Arama sonucu URI'si okunamadı: {error}"))?;
        let track = Track::get(&session, &parsed_uri)
            .await
            .map_err(|error| format!("Şarkı bilgisi alınamadı: {error}"))?;
        results.push(SpotifySearchTrack {
            uri: track
                .id
                .to_uri()
                .map_err(|error| format!("Şarkı URI'si oluşturulamadı: {error}"))?,
            title: track.name,
            artist: track
                .artists
                .iter()
                .map(|artist| artist.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            album: track.album.name,
            duration_ms: track.duration.max(0) as u32,
        });
    }

    Ok(results)
}

fn normalise_spotify_uri(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.starts_with("spotify:") {
        return Ok(input.to_string());
    }

    if let Some(path) = input
        .strip_prefix("https://open.spotify.com/")
        .or_else(|| input.strip_prefix("http://open.spotify.com/"))
    {
        let mut parts = path.split('/');
        let kind = parts.next().unwrap_or_default();
        let id = parts
            .next()
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default();
        if !kind.is_empty() && !id.is_empty() {
            return Ok(format!("spotify:{kind}:{id}"));
        }
    }

    Err("Spotify URI veya open.spotify.com bağlantısı girin".into())
}

#[cfg(test)]
mod tests {
    use super::normalise_spotify_uri;

    #[test]
    fn keeps_spotify_uri() {
        assert_eq!(
            normalise_spotify_uri("spotify:track:abc").unwrap(),
            "spotify:track:abc"
        );
    }

    #[test]
    fn converts_open_spotify_url() {
        assert_eq!(
            normalise_spotify_uri("https://open.spotify.com/album/xyz?si=123").unwrap(),
            "spotify:album:xyz"
        );
    }
}
