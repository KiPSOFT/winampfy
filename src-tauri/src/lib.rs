mod playback;

use tauri::{
    AppHandle, Manager,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use playback::{
    PlayerState, player_load_uri, player_next, player_pause, player_play, player_previous,
    player_seek, player_set_repeat, player_set_shuffle, player_set_volume, player_status,
    player_stop, player_sync_volume, spotify_login, spotify_playlist_tracks, spotify_playlists,
    spotify_search,
};

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PlayerState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
                    "show" => show_main_window(app),
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
                        show_main_window(tray.app_handle());
                    }
                });

            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            player_status,
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
            spotify_search,
            spotify_playlists,
            spotify_playlist_tracks,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("Winampfy could not start");
}
