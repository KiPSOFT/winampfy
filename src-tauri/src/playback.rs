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
        audio_backend::{self, Sink, SinkResult},
        config::{AudioFormat, Bitrate, PlayerConfig},
        convert::Converter,
        decoder::AudioPacket,
        mixer::{self, MixerConfig},
        player::{Player, PlayerEvent},
    },
};
use protobuf::Message;
use protobuf_json_mapping as json_mapping;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::sync::RwLock;

use librespot::protocol::context_page::ContextPage;

const DEVICE_NAME: &str = "Winampfy Desktop";
const OAUTH_REDIRECT: &str = "http://127.0.0.1:8898/login";
const AUDIO_CACHE_LIMIT: u64 = 256 * 1024 * 1024;
const VISUALIZER_SAMPLE_LIMIT: usize = 2048;

#[derive(Clone, Default, Serialize)]
pub struct VisualizerFrame {
    sequence: u64,
    samples: Vec<f32>,
}

/// Mirrors a small, mono slice of each decoded PCM packet while forwarding the
/// original packet to librespot's real audio sink. The browser never plays this
/// copy; it only gives Webamp's Milkdrop analyser the signal it normally gets
/// from an HTML audio element.
struct VisualizerSink {
    inner: Box<dyn Sink>,
    frame: Arc<Mutex<VisualizerFrame>>,
}

impl Sink for VisualizerSink {
    fn start(&mut self) -> SinkResult<()> {
        self.inner.start()
    }

    fn stop(&mut self) -> SinkResult<()> {
        self.inner.stop()
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        if let AudioPacket::Samples(samples) = &packet {
            let frame_count = samples.len() / 2;
            let stride = frame_count.div_ceil(VISUALIZER_SAMPLE_LIMIT).max(1);
            let mono = samples
                .chunks_exact(2)
                .step_by(stride)
                .take(VISUALIZER_SAMPLE_LIMIT)
                .map(|channels| ((channels[0] + channels[1]) * 0.5) as f32)
                .collect::<Vec<_>>();
            if let Ok(mut frame) = self.frame.lock() {
                frame.sequence = frame.sequence.wrapping_add(1);
                frame.samples = mono;
            }
        }
        self.inner.write(packet, converter)
    }
}

#[derive(Clone, Serialize)]
pub struct PlayerStatus {
    state: String,
    device_name: String,
    message: String,
    track_title: Option<String>,
    artist: Option<String>,
    track_uri: Option<String>,
    duration_ms: Option<u32>,
    position_ms: Option<u32>,
    track_sequence: u64,
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
            track_uri: None,
            duration_ms: None,
            position_ms: None,
            track_sequence: 0,
            advance_sequence: 0,
        }
    }
}

pub struct PlayerState {
    status: Arc<RwLock<PlayerStatus>>,
    spirc: Arc<Mutex<Option<Spirc>>>,
    session: Arc<Mutex<Option<Session>>>,
    mixer: Arc<Mutex<Option<Arc<dyn mixer::Mixer>>>>,
    queue: Arc<Mutex<Vec<String>>>,
    current_index: Arc<Mutex<Option<usize>>>,
    last_uri: Arc<Mutex<Option<String>>>,
    last_load_at: Arc<Mutex<std::time::Instant>>,
    visualizer_frame: Arc<Mutex<VisualizerFrame>>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(PlayerStatus::default())),
            spirc: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(None)),
            mixer: Arc::new(Mutex::new(None)),
            queue: Arc::new(Mutex::new(Vec::new())),
            current_index: Arc::new(Mutex::new(None)),
            last_uri: Arc::new(Mutex::new(None)),
            last_load_at: Arc::new(Mutex::new(std::time::Instant::now())),
            visualizer_frame: Arc::new(Mutex::new(VisualizerFrame::default())),
        }
    }

    /// Detects whether the librespot session behind the player has died.
    ///
    /// librespot marks the session invalid on connection loss, so a survivor
    /// handle in the slot no longer delivers any audio. Keeping that stale
    /// handle around makes every subsequent play/next/load a silent no-op and
    /// wedges the frontend at an old track and position forever.
    fn has_dead_session(&self) -> bool {
        self.session
            .lock()
            .map(|guard| guard.as_ref().is_some_and(|session| session.is_invalid()))
            .unwrap_or(false)
    }

    /// Drops the stale player pipeline so the next connection starts from scratch.
    fn clear_player(&self) {
        if let Ok(mut slot) = self.spirc.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.session.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.mixer.lock() {
            *slot = None;
        }
    }

    /// Spawns a background task that keeps playback alive without any JS timer.
    ///
    /// WKWebView throttles the window's JavaScript timers while it is occluded
    /// in the background. That used to freeze every recovery path (stall
    /// restart, session reconnect and next-track advance). This Rust task runs
    /// on its own and takes over those duties whenever playback appears stuck:
    /// it reconnects a dead session with the cached credentials, resumes a
    /// stalled track from its frozen position and advances to the next queued
    /// track once the frontend has not done so within a short grace period.
    pub fn spawn_guardian(&self, app: AppHandle) {
        let status = self.status.clone();
        let spirc_slot = self.spirc.clone();
        let session_slot = self.session.clone();
        let mixer_slot = self.mixer.clone();
        let queue = self.queue.clone();
        let current_index = self.current_index.clone();
        let last_uri = self.last_uri.clone();
        let last_load_at = self.last_load_at.clone();
        let visualizer_frame = self.visualizer_frame.clone();
        tauri::async_runtime::spawn(async move {
            let mut position_tracker = PositionTracker::new();
            let mut last_reconnect_at = std::time::Instant::now() - Duration::from_secs(30);
            let mut last_advance_sequence = 0u64;
            let mut pending_advance: Option<std::time::Instant> = None;
            let mut stall_restarts: Vec<std::time::Instant> = Vec::new();
            let mut last_position_ms: Option<u32> = None;
            let mut last_track_sequence = 0u64;
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let snapshot = status.read().await.clone();

                // A different track means the previous stall (if any) was
                // recovered successfully; restart the escalation counter.
                if snapshot.track_sequence != last_track_sequence {
                    last_track_sequence = snapshot.track_sequence;
                    stall_restarts.clear();
                }
                let position_progressing = snapshot.position_ms != last_position_ms;
                if position_progressing {
                    last_position_ms = snapshot.position_ms;
                    stall_restarts.clear();
                }

                // 1) A dead session should be rebuilt automatically when we
                // were mid-playback. Use cached credentials; no browser needed.
                let session_invalid = session_slot
                    .lock()
                    .map(|guard| guard.as_ref().is_some_and(|session| session.is_invalid()))
                    .unwrap_or(false);
                let reconnect_due = last_reconnect_at.elapsed() > Duration::from_secs(10);
                if session_invalid
                    && reconnect_due
                    && matches!(
                        snapshot.state.as_str(),
                        "playing" | "paused" | "loading" | "ended" | "error"
                    )
                {
                    last_reconnect_at = std::time::Instant::now();
                    // Only seek back into the position we remembered when it
                    // belongs to the very track we are resuming.
                    let restarting_uri = last_uri
                        .lock()
                        .ok()
                        .and_then(|slot| slot.clone())
                        .filter(|uri| uri != "spotify:current");
                    let resume_from = match (&restarting_uri, snapshot.track_uri.as_deref()) {
                        (Some(restarting), Some(current)) if restarting == current => {
                            snapshot.position_ms
                        }
                        _ => None,
                    };
                    tauri::async_runtime::spawn(recover_session(
                        app.clone(),
                        status.clone(),
                        spirc_slot.clone(),
                        session_slot.clone(),
                        mixer_slot.clone(),
                        visualizer_frame.clone(),
                        last_uri.clone(),
                        resume_from,
                    ));
                    continue;
                }

                // 2. Auto-advance: when the backend records an EndOfTrack /
                // Unavailable (advance_sequence bumped), the frontend normally
                // loads the next queued track. If the JavaScript timers are
                // frozen in the background that never happens, so advance once
                // after a grace period unless a fresh load arrived meanwhile.
                if snapshot.advance_sequence != last_advance_sequence {
                    last_advance_sequence = snapshot.advance_sequence;
                    pending_advance = Some(std::time::Instant::now());
                }
                let advanced_recently = last_load_at
                    .lock()
                    .map(|last| last.elapsed() < Duration::from_secs(3))
                    .unwrap_or(true);
                if let Some(advance_at) = pending_advance {
                    if advance_at.elapsed() > Duration::from_secs(3) && !advanced_recently {
                        pending_advance = None;
                        advance_queued_track(
                            spirc_slot.clone(),
                            queue.clone(),
                            current_index.clone(),
                            last_uri.clone(),
                        );
                        continue;
                    }
                    if advanced_recently {
                        pending_advance = None;
                    }
                }

                // 3. Stall recovery: the stream froze at a fixed position
                // while reported as playing. Resume the current track from
                // the frozen position instead of restarting it from zero.
                position_tracker = position_tracker.observe(&snapshot);
                if position_tracker.stalled {
                    position_tracker = PositionTracker::new();
                    let stalled_uri = last_uri.lock().ok().and_then(|slot| slot.clone());
                    let Some(uri) = stalled_uri else {
                        continue;
                    };
                    if uri == "spotify:current" {
                        continue;
                    }
                    stall_restarts.retain(|at| at.elapsed() < Duration::from_secs(90));
                    if stall_restarts.len() >= 2 && reconnect_due {
                        // Repeated stalls without any real progress mean the
                        // session itself is wedged (every command silently
                        // no-ops). Rebuild it instead of restarting again.
                        last_reconnect_at = std::time::Instant::now();
                        stall_restarts.clear();
                        tauri::async_runtime::spawn(recover_session(
                            app.clone(),
                            status.clone(),
                            spirc_slot.clone(),
                            session_slot.clone(),
                            mixer_slot.clone(),
                            visualizer_frame.clone(),
                            last_uri.clone(),
                            snapshot.position_ms,
                        ));
                        continue;
                    }
                    stall_restarts.push(std::time::Instant::now());
                    let _ =
                        restart_track(spirc_slot.clone(), uri, snapshot.position_ms.unwrap_or(0));
                }
            }
        });
    }
}

struct PositionTracker {
    last_position_ms: Option<u32>,
    last_position_at: Option<std::time::Instant>,
    stalled: bool,
}

impl PositionTracker {
    fn new() -> Self {
        Self {
            last_position_ms: None,
            last_position_at: None,
            stalled: false,
        }
    }

    fn observe(mut self, status: &PlayerStatus) -> Self {
        if status.state != "playing" {
            return Self::new();
        }
        let position = status.position_ms;
        if position == self.last_position_ms {
            if let Some(at) = self.last_position_at {
                if at.elapsed() > Duration::from_secs(12) {
                    self.stalled = true;
                }
            } else {
                self.last_position_at = Some(std::time::Instant::now());
            }
        } else {
            self.last_position_ms = position;
            self.last_position_at = Some(std::time::Instant::now());
        }
        self
    }
}

/// Resumes the track `uri` at `position_ms`. Used when the stream froze
/// mid-track while nominally "playing"; restarting from zero would replay
/// already-heard audio on every recovery.
fn restart_track(
    spirc_slot: Arc<Mutex<Option<Spirc>>>,
    uri: String,
    position_ms: u32,
) -> Result<(), String> {
    let options = LoadRequestOptions {
        start_playing: true,
        seek_to: position_ms,
        ..LoadRequestOptions::default()
    };
    with_loaded_spirc(spirc_slot, |spirc| {
        spirc.load(LoadRequest::from_tracks(vec![uri], options))
    })
}

/// Advances to the next kind in the stored queue. Runs only when the frontend
/// was too slow to load the next track itself (its JS timers are throttled in
/// the background).
fn advance_queued_track(
    spirc_slot: Arc<Mutex<Option<Spirc>>>,
    queue: Arc<Mutex<Vec<String>>>,
    current_index: Arc<Mutex<Option<usize>>>,
    last_uri: Arc<Mutex<Option<String>>>,
) {
    let index = current_index
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .unwrap_or(0);
    let next = queue
        .lock()
        .ok()
        .and_then(|queue| queue.get(index + 1).cloned());
    let Some(uri) = next else {
        return;
    };
    if let Ok(mut index_guard) = current_index.lock() {
        *index_guard = Some(index + 1);
    }
    if let Ok(mut last) = last_uri.lock() {
        *last = Some(uri.clone());
    }
    let options = LoadRequestOptions {
        start_playing: true,
        ..LoadRequestOptions::default()
    };
    let _ = with_loaded_spirc(spirc_slot, |spirc| {
        spirc.load(LoadRequest::from_tracks(vec![uri], options))
    });
}

fn with_loaded_spirc(
    spirc_slot: Arc<Mutex<Option<Spirc>>>,
    action: impl FnOnce(&Spirc) -> Result<(), librespot::core::Error>,
) -> Result<(), String> {
    let guard = spirc_slot
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())?;
    let spirc = guard
        .as_ref()
        .ok_or_else(|| "Önce Spotify hesabınızı bağlayın".to_string())?;
    action(spirc).map_err(|error| error.to_string())
}

/// Rebuilds the player pipeline after a session loss. Uses the cached Spotify
/// credentials so no browser interaction is required; the frontend keeps
/// working while this runs in the background.
async fn recover_session(
    app: AppHandle,
    status: Arc<RwLock<PlayerStatus>>,
    spirc_slot: Arc<Mutex<Option<Spirc>>>,
    session_slot: Arc<Mutex<Option<Session>>>,
    mixer_slot: Arc<Mutex<Option<Arc<dyn mixer::Mixer>>>>,
    visualizer_frame: Arc<Mutex<VisualizerFrame>>,
    last_uri: Arc<Mutex<Option<String>>>,
    resume_from: Option<u32>,
) {
    set_connection_status(&status, "connecting", "Spotify oturumu yeniden kuruluyor").await;
    let result = initialise_player(
        &app,
        status.clone(),
        spirc_slot.clone(),
        session_slot.clone(),
        mixer_slot.clone(),
        visualizer_frame,
    )
    .await;
    if let Err(error) = result {
        set_connection_status(&status, "error", &error).await;
        return;
    }
    set_connection_status(&status, "ready", "Yeniden bağlandı").await;

    // Resume whatever was playing before the drop, seeking back into the
    // position where it died instead of replaying the track from the start.
    if let Some(uri) = last_uri
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .filter(|uri| uri != "spotify:current")
    {
        let _ = restart_track(spirc_slot, uri, resume_from.unwrap_or(0));
    }
}

#[tauri::command]
pub async fn player_status(state: State<'_, PlayerState>) -> Result<PlayerStatus, String> {
    // Deliberately read-only: the Rust guardian owns session recovery. Wiping
    // the stale pipeline here would race the guardian's in-flight rebuild and
    // leave an empty session slot that nothing reconnects.
    Ok(state.status.read().await.clone())
}

#[tauri::command]
pub fn player_visualizer_frame(state: State<'_, PlayerState>) -> Result<VisualizerFrame, String> {
    state
        .visualizer_frame
        .lock()
        .map(|frame| frame.clone())
        .map_err(|_| "Visualizer state lock failed".to_string())
}

#[tauri::command]
pub async fn spotify_login(
    app: AppHandle,
    state: State<'_, PlayerState>,
) -> Result<PlayerStatus, String> {
    if !state.has_dead_session()
        && state
            .spirc
            .lock()
            .map_err(|_| "Playback state lock failed".to_string())?
            .is_some()
    {
        return Ok(state.status.read().await.clone());
    }
    // The stored player belongs to a session that died, or there is no player
    // yet. Either way the old pipeline cannot be reused and must be rebuilt.
    state.clear_player();

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
        state.visualizer_frame.clone(),
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
    visualizer_frame: Arc<Mutex<VisualizerFrame>>,
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
        move || {
            Box::new(VisualizerSink {
                inner: sink_builder(None, AudioFormat::default()),
                frame: visualizer_frame,
            })
        },
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
            PlayerEvent::Loading {
                track_id,
                position_ms,
                ..
            } => {
                current.state = "loading".into();
                current.position_ms = Some(position_ms);
                current.message = "Parça yükleniyor".into();
                if let Ok(uri) = track_id.to_uri()
                    && current.track_uri.as_deref() != Some(uri.as_str())
                {
                    current.track_uri = Some(uri);
                    current.track_title = None;
                    current.artist = None;
                    current.duration_ms = None;
                }
            }
            PlayerEvent::TrackChanged { audio_item } => {
                current.track_title = Some(audio_item.name.clone());
                current.artist = artist_name(&audio_item.unique_fields);
                current.track_uri = Some(audio_item.uri.clone());
                current.duration_ms = Some(audio_item.duration_ms);
                current.position_ms = Some(0);
                current.track_sequence = current.track_sequence.wrapping_add(1);
                current.message = "Parça yüklendi".into();
            }
            PlayerEvent::Playing { position_ms, .. } => {
                current.state = "playing".into();
                current.position_ms = Some(position_ms);
                current.message = "Çalıyor".into();
            }
            PlayerEvent::PositionChanged { position_ms, .. }
            | PlayerEvent::PositionCorrection { position_ms, .. }
            | PlayerEvent::Seeked { position_ms, .. } => {
                // Position notifications describe the playhead, not whether
                // audio is playing. Treating a seek/correction after Pause as
                // Playing made the guardian restart deliberately stopped
                // tracks. The explicit Playing/Paused events own that state.
                current.position_ms = Some(position_ms);
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
    // The player event channel only closes when the SpircTask's Player was
    // destroyed, which happens once the Spotify session becomes invalid. Leave
    // a durable marker so player_status can treat the stale pipeline as dead
    // and let the next login rebuild it.
    let mut current = status.write().await;
    if current.state != "disconnected" {
        current.state = "error".into();
        current.message = "Spotify oturumu kapandı".into();
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
    with_spirc(&state, |spirc| {
        spirc.pause()?;
        spirc.set_position_ms(0)
    })
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
    *state
        .last_uri
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())? = Some(uri.clone());
    *state
        .last_load_at
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())? = std::time::Instant::now();
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
pub fn player_set_queue(uris: Vec<String>, state: State<'_, PlayerState>) -> Result<(), String> {
    let queue = uris
        .into_iter()
        .filter_map(|uri| normalise_spotify_uri(&uri).ok())
        .collect::<Vec<_>>();
    let mut slot = state
        .queue
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())?;
    *slot = queue;
    Ok(())
}

#[tauri::command]
pub fn player_set_current(uri: String, state: State<'_, PlayerState>) -> Result<(), String> {
    let uri = normalise_spotify_uri(&uri)?;
    let index = state
        .queue
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())?
        .iter()
        .position(|track| *track == uri);
    *state
        .current_index
        .lock()
        .map_err(|_| "Playback state lock failed".to_string())? = index;
    Ok(())
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

    // Offer the account's Liked Songs on top of every playlist search. The
    // collection is not part of the rootlist; it lives behind the special
    // `spotify:user:<name>:collection` context URI.
    let liked = liked_songs_summary(&session);
    if query.is_empty() || liked.name.to_lowercase().contains(&query) {
        playlists.insert(0, liked);
        if playlists.len() > limit {
            playlists.pop();
        }
    }
    Ok(playlists)
}

fn is_collection_uri(uri: &str) -> bool {
    uri.starts_with("spotify:user:") && uri.ends_with(":collection")
}

fn liked_songs_summary(session: &Session) -> SpotifyPlaylistSummary {
    let username = session.username();
    SpotifyPlaylistSummary {
        uri: format!("spotify:user:{username}:collection"),
        name: "Liked Songs".into(),
        owner: username,
        track_count: 0,
        is_public: false,
        is_collaborative: false,
    }
}

/// Enumerates every track in the Liked Songs collection. The context only
/// ships the first pages; the rest arrive by following `next_page_url`.
async fn collection_track_uris(session: &Session, uri: &str) -> Result<Vec<SpotifyUri>, String> {
    let spclient = session.spclient();
    let context = spclient
        .get_context(uri)
        .await
        .map_err(|error| format!("Liked Songs alınamadı: {error}"))?;

    let mut uris = Vec::new();
    let mut next_page_url = None;
    for page in &context.pages {
        push_page_tracks(page, &mut uris);
        if let Some(next) = page.next_page_url.as_deref().filter(|url| !url.is_empty()) {
            next_page_url = Some(next.to_string());
        }
    }

    // Defensive cap: a realistic collection paginates far below this.
    for _ in 0..500 {
        let Some(url) = next_page_url.take() else {
            break;
        };
        let page_bytes = spclient
            .get_next_page(&url)
            .await
            .map_err(|error| format!("Liked Songs sayfası alınamadı: {error}"))?;
        let page_json = String::from_utf8(page_bytes.to_vec())
            .map_err(|error| format!("Liked Songs sayfası okunamadı: {error}"))?;
        let page: ContextPage = json_mapping::parse_from_str(&page_json)
            .map_err(|error| format!("Liked Songs sayfası çözümlenemedi: {error}"))?;
        if let Some(next) = page.next_page_url.as_deref().filter(|url| !url.is_empty()) {
            next_page_url = Some(next.to_string());
        }
        push_page_tracks(&page, &mut uris);
    }

    Ok(uris)
}

fn push_page_tracks(page: &ContextPage, uris: &mut Vec<SpotifyUri>) {
    for track in &page.tracks {
        if let Some(uri) = track
            .uri
            .as_deref()
            .filter(|uri| uri.starts_with("spotify:track:"))
            && let Ok(parsed) = SpotifyUri::from_uri(uri)
        {
            uris.push(parsed);
        }
    }
}

#[tauri::command]
pub async fn spotify_playlist_tracks(
    uri: String,
    on_progress: Channel<PlaylistLoadProgress>,
    state: State<'_, PlayerState>,
) -> Result<Vec<SpotifySearchTrack>, String> {
    let session = connected_session(&state)?;
    let uri = normalise_spotify_uri(&uri)?;
    let track_uris = if is_collection_uri(&uri) {
        collection_track_uris(&session, &uri).await?
    } else {
        let playlist_uri = SpotifyUri::from_uri(&uri)
            .map_err(|error| format!("Playlist URI'si okunamadı: {error}"))?;
        if !matches!(playlist_uri, SpotifyUri::Playlist { .. }) {
            return Err("Bir Spotify playlist bağlantısı seçin".into());
        }
        let playlist = Playlist::get(&session, &playlist_uri)
            .await
            .map_err(|error| format!("Playlist alınamadı: {error}"))?;
        playlist
            .tracks()
            .filter(|track_uri| matches!(track_uri, SpotifyUri::Track { .. }))
            .cloned()
            .collect::<Vec<_>>()
    };
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

    #[test]
    fn detects_collection_uri() {
        assert!(super::is_collection_uri("spotify:user:someone:collection"));
        assert!(!super::is_collection_uri("spotify:playlist:abc"));
        assert!(!super::is_collection_uri(
            "spotify:user:someone:collection:artist:xyz"
        ));
    }
}
