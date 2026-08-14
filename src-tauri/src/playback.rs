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
    metadata::{Metadata, Playlist, Track},
    playback::{
        audio_backend,
        config::{AudioFormat, Bitrate, PlayerConfig},
        mixer::{self, MixerConfig},
        player::{Player, PlayerEvent},
    },
};
use protobuf::Message;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};
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
    advance_sequence: u64,
}

#[derive(Clone, Serialize)]
pub struct SpotifySearchTrack {
    uri: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: u32,
}

#[derive(Clone, Serialize)]
pub struct SpotifyPlaylistSummary {
    uri: String,
    name: String,
    owner: String,
    track_count: u32,
    is_public: bool,
    is_collaborative: bool,
}

#[derive(Clone, Serialize)]
pub struct PlaylistLoadProgress {
    added: u32,
    total: u32,
    remaining: u32,
    skipped: u32,
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
            advance_sequence: 0,
        }
    }
}

pub struct PlayerState {
    status: Arc<RwLock<PlayerStatus>>,
    spirc: Arc<Mutex<Option<Spirc>>>,
    session: Arc<Mutex<Option<Session>>>,
    mixer: Arc<Mutex<Option<Arc<dyn mixer::Mixer>>>>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(PlayerStatus::default())),
            spirc: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(None)),
            mixer: Arc::new(Mutex::new(None)),
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
        state.mixer.clone(),
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
    mixer_slot: Arc<Mutex<Option<Arc<dyn mixer::Mixer>>>>,
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

    let initial_volume = ((u16::MAX as u32 * 72) / 100) as u16;
    let connect_config = ConnectConfig {
        name: DEVICE_NAME.into(),
        initial_volume,
        ..ConnectConfig::default()
    };
    mixer.set_volume(initial_volume);
    let (spirc, spirc_task) = Spirc::new(
        connect_config,
        session.clone(),
        credentials,
        player,
        mixer.clone(),
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
    *mixer_slot
        .lock()
        .map_err(|_| "Audio mixer lock failed".to_string())? = Some(mixer);

    tauri::async_runtime::spawn(spirc_task);
    tauri::async_runtime::spawn(watch_player_events(player_events, status));
    Ok(())
}

async fn watch_player_events(
    mut events: librespot::playback::player::PlayerEventChannel,
    status: Arc<RwLock<PlayerStatus>>,
) {
    let mut last_advance_request_id = None;
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
            PlayerEvent::EndOfTrack {
                play_request_id, ..
            } => {
                current.state = "ended".into();
                current.message = "Parça tamamlandı".into();
                record_advance(&mut current, &mut last_advance_request_id, play_request_id);
            }
            PlayerEvent::Unavailable {
                play_request_id, ..
            } => {
                // An unavailable or region-blocked item is a track-level
                // failure, not a broken Spotify session. Signal the frontend
                // to skip it while keeping real connection errors separate.
                current.state = "ended".into();
                current.message = "Bu parça oynatılamıyor — atlanıyor".into();
                record_advance(&mut current, &mut last_advance_request_id, play_request_id);
            }
            PlayerEvent::SessionDisconnected { .. } => {
                current.state = "error".into();
                current.message = "Spotify oturumu kesildi".into();
            }
            _ => {}
        }
    }
}

fn record_advance(status: &mut PlayerStatus, last_request_id: &mut Option<u64>, request_id: u64) {
    if *last_request_id == Some(request_id) {
        return;
    }
    *last_request_id = Some(request_id);
    status.advance_sequence = status.advance_sequence.wrapping_add(1);
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
    let mixer = state
        .mixer
        .lock()
        .map_err(|_| "Audio mixer lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Spotify player is not connected".to_string())?;
    mixer.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn player_sync_volume(volume: u8, state: State<'_, PlayerState>) -> Result<(), String> {
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

    let search_uri = format!(
        "spotify:search:{}",
        query.split_whitespace().collect::<Vec<_>>().join("+")
    );
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

#[tauri::command]
pub async fn spotify_playlists(
    query: Option<String>,
    limit: Option<u16>,
    state: State<'_, PlayerState>,
) -> Result<Vec<SpotifyPlaylistSummary>, String> {
    let session = connected_session(&state)?;
    let response = session
        .spclient()
        .get_rootlist(0, Some(500))
        .await
        .map_err(|error| format!("Playlist listesi alınamadı: {error}"))?;
    let message = librespot::protocol::playlist4_external::SelectedListContent::parse_from_bytes(
        response.as_ref(),
    )
    .map_err(|error| format!("Playlist listesi okunamadı: {error}"))?;
    // Rootlists also contain folders and separators. Those entries can have
    // no playlist revision, which makes the general metadata converter reject
    // the whole response. Read the protobuf defensively and keep playlist rows.
    let contents = message.contents.get_or_default();

    let query = query.unwrap_or_default().trim().to_lowercase();
    let limit = limit.unwrap_or(50).clamp(1, 100) as usize;
    let mut playlists = contents
        .items
        .iter()
        .zip(contents.meta_items.iter())
        .filter_map(|(item, meta)| {
            let uri = item.uri();
            if !uri.starts_with("spotify:playlist:") {
                return None;
            }

            let name = meta.attributes.get_or_default().name().trim();
            let owner = meta.owner_username().trim();
            if name.is_empty()
                || (!query.is_empty()
                    && !name.to_lowercase().contains(&query)
                    && !owner.to_lowercase().contains(&query))
            {
                return None;
            }

            Some(SpotifyPlaylistSummary {
                uri: uri.to_string(),
                name: name.to_string(),
                owner: owner.to_string(),
                track_count: meta.length().max(0) as u32,
                is_public: item.attributes.get_or_default().public(),
                is_collaborative: meta.attributes.get_or_default().collaborative(),
            })
        })
        .collect::<Vec<_>>();

    playlists.sort_by_key(|playlist| playlist.name.to_lowercase());
    playlists.truncate(limit);
    Ok(playlists)
}

#[tauri::command]
pub async fn spotify_playlist_tracks(
    uri: String,
    on_progress: Channel<PlaylistLoadProgress>,
    state: State<'_, PlayerState>,
) -> Result<Vec<SpotifySearchTrack>, String> {
    let session = connected_session(&state)?;
    let uri = SpotifyUri::from_uri(&normalise_spotify_uri(&uri)?)
        .map_err(|error| format!("Playlist URI'si okunamadı: {error}"))?;
    if !matches!(uri, SpotifyUri::Playlist { .. }) {
        return Err("Bir Spotify playlist bağlantısı seçin".into());
    }

    let playlist = Playlist::get(&session, &uri)
        .await
        .map_err(|error| format!("Playlist alınamadı: {error}"))?;
    let track_uris = playlist
        .tracks()
        .filter(|uri| matches!(uri, SpotifyUri::Track { .. }))
        .cloned()
        .collect::<Vec<_>>();
    let total = track_uris.len() as u32;
    let mut tracks = Vec::with_capacity(track_uris.len());
    let mut skipped = 0u32;
    let _ = on_progress.send(PlaylistLoadProgress {
        added: 0,
        total,
        remaining: total,
        skipped,
    });

    for (index, track_uri) in track_uris.iter().enumerate() {
        let processed = index as u32 + 1;

        // Removed or region-blocked entries should not prevent the rest of a
        // playlist from loading.
        let Ok(track) = Track::get(&session, track_uri).await else {
            skipped += 1;
            let _ = on_progress.send(PlaylistLoadProgress {
                added: tracks.len() as u32,
                total,
                remaining: total.saturating_sub(processed),
                skipped,
            });
            continue;
        };
        match search_track_from_metadata(track) {
            Ok(track) => tracks.push(track),
            Err(_) => skipped += 1,
        }
        let _ = on_progress.send(PlaylistLoadProgress {
            added: tracks.len() as u32,
            total,
            remaining: total.saturating_sub(processed),
            skipped,
        });
    }

    if tracks.is_empty() {
        return Err("Bu playlistte oynatılabilir şarkı bulunamadı".into());
    }
    Ok(tracks)
}

fn connected_session(state: &State<'_, PlayerState>) -> Result<Session, String> {
    state
        .session
        .lock()
        .map_err(|_| "Spotify session lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Önce Spotify hesabınızı bağlayın".to_string())
}

fn search_track_from_metadata(track: Track) -> Result<SpotifySearchTrack, String> {
    Ok(SpotifySearchTrack {
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
    })
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
    use super::{PlayerStatus, normalise_spotify_uri, record_advance};

    #[test]
    fn advances_once_per_play_request() {
        let mut status = PlayerStatus::default();
        let mut last_request_id = None;

        record_advance(&mut status, &mut last_request_id, 42);
        record_advance(&mut status, &mut last_request_id, 42);
        assert_eq!(status.advance_sequence, 1);

        record_advance(&mut status, &mut last_request_id, 43);
        assert_eq!(status.advance_sequence, 2);
    }

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
