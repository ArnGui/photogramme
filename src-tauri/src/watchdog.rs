//! Guetteur de l'interface.
//!
//! Si le moteur de la fenêtre (WebView2, WebKit) s'arrête, par manque de mémoire
//! par exemple, la fenêtre devient noire et l'interface ne peut plus rien dire.
//! Elle envoie donc un signe de vie toutes les deux secondes ; s'il manque trop
//! longtemps alors qu'elle est visible, le Rust affiche un message natif et
//! propose de la recharger (le travail sur le film est enregistré au fil de l'eau).

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Silence toléré : une page de planche contact très lourde peut occuper l'interface quelques secondes.
const SILENCE: Duration = Duration::from_secs(20);
/// Délai laissé à une fenêtre qui revient au premier plan pour donner signe de vie.
const ON_FOCUS: Duration = Duration::from_secs(6);

#[derive(Default)]
struct Beat {
    /// Dernier signe de vie, `None` avant le premier (démarrage).
    last: Option<Instant>,
    /// Page visible : cachée, le navigateur ralentit ses minuteries, le silence n'y prouve rien.
    visible: bool,
    /// Message déjà affiché : un seul à la fois.
    alerted: bool,
}

#[derive(Default)]
pub struct Watchdog(Mutex<Beat>);

/// Signe de vie de l'interface.
#[tauri::command]
pub fn heartbeat(state: State<'_, Watchdog>, visible: bool) {
    if let Ok(mut b) = state.0.lock() {
        b.last = Some(Instant::now());
        b.visible = visible;
        b.alerted = false;
    }
}

/// Fenêtre revenue au premier plan : si l'interface était cachée, elle doit se manifester vite.
pub fn on_focus(app: &AppHandle) {
    if let Ok(mut b) = app.state::<Watchdog>().0.lock() {
        if let Some(last) = b.last {
            if !b.visible {
                b.visible = true;
                b.last = Some(
                    Instant::now()
                        .checked_sub(SILENCE - ON_FOCUS)
                        .unwrap_or(last),
                );
            }
        }
    }
}

/// Surveille les signes de vie, sur un fil à part.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let silent = match app.state::<Watchdog>().0.lock() {
            Ok(mut b) => {
                let silent =
                    !b.alerted && b.visible && b.last.is_some_and(|t| t.elapsed() > SILENCE);
                if silent {
                    b.alerted = true;
                }
                silent
            }
            Err(_) => false,
        };
        if silent {
            alert(&app);
        }
    });
}

fn alert(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "Photogramme's interface stopped responding, probably because it ran out of memory \
             (a very large contact sheet, for example).\n\n\
             Your work on the film is saved. Reload the interface, or wait if a long task is still running.",
        )
        .title("Photogramme stopped responding")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Reload".into(), "Wait".into()))
        .show(move |reload| {
            // Recharger ou attendre : on repart d'un silence nul, un nouveau message viendra s'il dure.
            if let Ok(mut b) = handle.state::<Watchdog>().0.lock() {
                b.last = Some(Instant::now());
                b.alerted = false;
            }
            if reload {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.reload();
                }
            }
        });
}
