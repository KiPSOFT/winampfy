mod playback;

use tauri::{
    AppHandle, Manager,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use playback::{
    PlayerState, player_load_uri, player_next, player_pause, player_play, player_previous,
    player_seek, player_set_current, player_set_queue, player_set_repeat, player_set_shuffle,
    player_set_volume, player_status, player_stop, player_sync_volume, player_visualizer_frame,
    spotify_login, spotify_playlist_tracks, spotify_playlists, spotify_search,
};

#[derive(Clone, Copy)]
struct PanelVisibility {
    equalizer: bool,
    playlist: bool,
    milkdrop: bool,
}

impl Default for PanelVisibility {
    fn default() -> Self {
        Self {
            equalizer: true,
            playlist: true,
            milkdrop: true,
        }
    }
}

#[derive(Default)]
struct PanelVisibilityState(std::sync::Mutex<PanelVisibility>);

#[tauri::command]
fn set_panel_visibility_state(
    equalizer: bool,
    playlist: bool,
    milkdrop: bool,
    state: tauri::State<'_, PanelVisibilityState>,
) {
    *state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = PanelVisibility {
        equalizer,
        playlist,
        milkdrop,
    };
}

fn show_window_group(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
    }
    let panels = *app
        .state::<PanelVisibilityState>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (label, open) in [
        ("milkdrop", panels.milkdrop),
        ("playlist", panels.playlist),
        ("equalizer", panels.equalizer),
    ] {
        if !open {
            continue;
        }
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

#[derive(Default)]
struct WindowGroupMotion {
    main_position: Option<(i32, i32)>,
    sibling_offsets: std::collections::HashMap<&'static str, (i32, i32)>,
    pending_sibling_positions: std::collections::HashMap<&'static str, Vec<(i32, i32)>>,
}

// macOS puts hidden/background apps to sleep ("App Nap"), which throttles the
// whole process. That stalls librespot's streaming and eventually drops the
// Spotify session, so after returning to the foreground the app has to
// reconnect before playback can resume. Holding an NSProcessInfo activity for
// the app's lifetime keeps the process awake while it is in the background.
#[cfg(target_os = "macos")]
fn prevent_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    // The activity token must stay alive for the process lifetime to keep the
    // app awake in the background; intentionally leaking it is the point.
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInteractive
            | NSActivityOptions::SuddenTerminationDisabled
            | NSActivityOptions::AutomaticTerminationDisabled,
        &NSString::from_str("Winampfy playback"),
    );
    std::mem::forget(activity);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The player window is only ever moved by the user dragging it, so every
    // native move event of "main" is a drag. Carrying the sibling panels from
    // this callback keeps the group perfectly rigid: the siblings move inside
    // the same native event instead of lagging behind asynchronous IPC calls.
    let window_group_motion: &'static std::sync::Mutex<WindowGroupMotion> = Box::leak(Box::new(
        std::sync::Mutex::new(WindowGroupMotion::default()),
    ));

    tauri::Builder::default()
        .manage(PlayerState::new())
        .manage(PanelVisibilityState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(move |window, event| {
            let tauri::WindowEvent::Moved(position) = event else {
                return;
            };
            let label = window.label();
            let mut motion = window_group_motion
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if label != "main" {
                let sibling_label = match label {
                    "equalizer" => "equalizer",
                    "playlist" => "playlist",
                    "milkdrop" => "milkdrop",
                    _ => return,
                };
                if let Some(pending) = motion.pending_sibling_positions.get_mut(sibling_label)
                    && let Some(index) = pending
                        .iter()
                        .position(|target| *target == (position.x, position.y))
                {
                    // This event confirms one of our own carry operations,
                    // possibly after a newer main-window move was processed.
                    // It must not redefine the user's stable panel offset.
                    pending.drain(..=index);
                    return;
                }
                if let Some((main_x, main_y)) = motion.main_position {
                    motion
                        .sibling_offsets
                        .insert(sibling_label, (position.x - main_x, position.y - main_y));
                }
                return;
            }

            let previous_main = motion.main_position.replace((position.x, position.y));
            let Some((previous_x, previous_y)) = previous_main else {
                return;
            };
            let app = window.app_handle();
            let mut targets = Vec::new();
            for label in ["equalizer", "playlist", "milkdrop"] {
                let Some(sibling) = app.get_webview_window(label) else {
                    continue;
                };
                if !sibling.is_visible().unwrap_or(false) {
                    continue;
                }
                let Ok(sibling_position) = sibling.outer_position() else {
                    continue;
                };
                let offset = *motion.sibling_offsets.entry(label).or_insert((
                    sibling_position.x - previous_x,
                    sibling_position.y - previous_y,
                ));
                let target = (position.x + offset.0, position.y + offset.1);
                let pending = motion.pending_sibling_positions.entry(label).or_default();
                pending.push(target);
                if pending.len() > 32 {
                    pending.remove(0);
                }
                targets.push((sibling, target.0, target.1));
            }
            drop(motion);

            // Use the main window's absolute native position plus stable
            // offsets. Reading each sibling's previous (possibly one-frame
            // stale) position caused the group to trail behind during drags.
            for (sibling, x, y) in targets {
                let _ = sibling.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition::new(x, y),
                ));
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            prevent_app_nap();
            app.state::<PlayerState>()
                .spawn_guardian(app.handle().clone());

            // Keep the tray icon independent from the OS/application icon cache.
            // Embedding the PNG also makes dev and packaged builds use exactly
            // the same artwork.
            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            let show = MenuItem::with_id(app, "show", "Winampfy'ı Göster", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Winampfy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window_group(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window_group(tray.app_handle());
                    }
                });

            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            player_status,
            player_visualizer_frame,
            spotify_login,
            player_play,
            player_pause,
            player_stop,
            player_previous,
            player_next,
            player_seek,
            player_set_volume,
            player_sync_volume,
            player_set_shuffle,
            player_set_repeat,
            player_load_uri,
            player_set_queue,
            player_set_current,
            spotify_search,
            spotify_playlists,
            spotify_playlist_tracks,
            set_panel_visibility_state,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("Winampfy could not start");
}
