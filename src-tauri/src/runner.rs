//! Lancement des processus FFmpeg : sortie brute intacte, flux continus,
//! annulation.
//!
//! Ce que fait le plugin shell (tauri-plugin-shell 2.4.0, process/mod.rs,
//! lu dans son code source) :
//! - `spawn()` crée trois tubes et un fil de lecture par tube ;
//! - en mode brut, chaque lecture de 8 Kio (tampon de `BufReader`) devient un
//!   événement `Stdout(Vec<u8>)` ou `Stderr(Vec<u8>)`, sans rien ajouter ;
//! - les événements passent par un canal de capacité 1 : si on ne lit pas,
//!   le fil de lecture attend, le tube se remplit et FFmpeg se met en pause.
//!   C'est une contre-pression naturelle : la mémoire ne peut pas exploser ;
//! - `Terminated` arrive après la fin des deux flux (verrou RwLock interne) ;
//! - `CommandChild::kill()` tue le processus ; abandonner le `CommandChild`
//!   ne le tue PAS (il faut le garder pour pouvoir annuler) ;
//! - `output()` ajoute un 0x0A après chaque morceau : ne jamais l'utiliser.

use shared_child::SharedChild;
use std::collections::HashMap;
use std::io::Read;
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::{channel, Receiver};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};

/// Message d'erreur d'une opération annulée par l'utilisateur.
pub const CANCELLED: &str = "Cancelled.";

/// Accumule la sortie d'un processus, octet pour octet.
///
/// Pourquoi ne pas utiliser `Command::output()` du plugin shell ?
/// Parce que, même en mode brut, `output()` ajoute un saut de ligne (0x0A)
/// après CHAQUE morceau lu (tauri-plugin-shell 2.4.0, process/mod.rs).
/// Les morceaux font 8 Kio (taille du tampon) : une image 4K de 24 883 200
/// octets arrive en 3 038 morceaux, donc 3 038 octets parasites.
/// On consomme donc les événements nous-mêmes, sans rien ajouter.
#[derive(Default)]
pub struct RawOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<i32>,
    pub error: Option<String>,
}

impl RawOutput {
    pub fn push(&mut self, event: CommandEvent) {
        match event {
            CommandEvent::Stdout(chunk) => self.stdout.extend_from_slice(&chunk),
            CommandEvent::Stderr(chunk) => self.stderr.extend_from_slice(&chunk),
            CommandEvent::Terminated(p) => self.code = p.code,
            CommandEvent::Error(e) => self.error = Some(e),
            _ => {}
        }
    }
}

/// Message d'échec lisible à partir de stderr, du code de sortie et d'une
/// éventuelle erreur de lecture.
pub fn failure_message(
    name: &str,
    stderr: &str,
    code: Option<i32>,
    error: Option<String>,
) -> String {
    let err = stderr.trim();
    if !err.is_empty() {
        // Les dernières lignes suffisent : FFmpeg finit par la cause.
        let tail: Vec<&str> = err.lines().rev().take(6).collect();
        format!(
            "{name}: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        )
    } else if let Some(e) = error {
        format!("{name}: {e}")
    } else {
        format!("{name} stopped without a message (code {code:?}).")
    }
}

/// Exécute une commande et collecte ses sorties sans les altérer.
/// `set_raw_out(true)` reste indispensable : sinon le plugin découpe la
/// sortie aux sauts de ligne et retire les 0x0A/0x0D de l'image.
pub async fn run_raw(cmd: Command, name: &str) -> Result<Vec<u8>, String> {
    let (mut rx, _child) = cmd
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("Cannot start {name}: {e}"))?;

    let mut out = RawOutput::default();
    while let Some(event) = rx.recv().await {
        out.push(event);
    }
    if out.code != Some(0) {
        return Err(failure_message(
            name,
            &String::from_utf8_lossy(&out.stderr),
            out.code,
            out.error,
        ));
    }
    Ok(out.stdout)
}

/// Groupe de processus annulable d'un coup (analyse ou export en lot).
#[derive(Clone, Default)]
pub struct ProcessGroup(Arc<GroupInner>);

#[derive(Default)]
struct GroupInner {
    cancelled: AtomicBool,
    children: Mutex<HashMap<u32, Child>>,
}

/// Processus lancé par le plugin, ou directement (lecture image par image).
enum Child {
    Plugin(CommandChild),
    Direct(Arc<SharedChild>),
}

impl Child {
    fn kill(self) {
        match self {
            Child::Plugin(c) => {
                let _ = c.kill();
            }
            Child::Direct(c) => {
                let _ = c.kill();
            }
        }
    }
}

impl ProcessGroup {
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Annule : plus aucun lancement possible, processus en cours tués.
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        let children: Vec<Child> = match self.0.children.lock() {
            Ok(mut m) => m.drain().map(|(_, c)| c).collect(),
            Err(_) => Vec::new(),
        };
        for c in children {
            c.kill();
        }
    }

    /// Lance une commande en mode brut et la rattache au groupe.
    pub fn spawn(&self, cmd: Command, name: &str) -> Result<(Receiver<CommandEvent>, u32), String> {
        if self.is_cancelled() {
            return Err(CANCELLED.into());
        }
        let (rx, child) = cmd
            .set_raw_out(true)
            .spawn()
            .map_err(|e| format!("Cannot start {name}: {e}"))?;
        let pid = child.pid();
        if let Ok(mut m) = self.0.children.lock() {
            m.insert(pid, Child::Plugin(child));
        }
        // Annulation arrivée pendant le lancement : on tue tout de suite.
        if self.is_cancelled() {
            self.kill(pid);
        }
        Ok((rx, pid))
    }

    /// Tue un seul processus du groupe (son consommateur a abandonné).
    pub fn kill(&self, pid: u32) {
        let child = self.0.children.lock().ok().and_then(|mut m| m.remove(&pid));
        if let Some(c) = child {
            c.kill();
        }
    }

    /// Processus terminé normalement : on oublie son identifiant.
    pub fn forget(&self, pid: u32) {
        if let Ok(mut m) = self.0.children.lock() {
            m.remove(&pid);
        }
    }

    /// Même groupe (même annulation) ?
    pub fn same(&self, other: &ProcessGroup) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    #[cfg(test)]
    pub fn running(&self) -> usize {
        self.0.children.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Message du lecteur d'images.
pub enum FrameMsg {
    Frame(Vec<u8>),
    /// Fin du processus : code de sortie, stderr, octets d'une image incomplète.
    Done {
        code: Option<i32>,
        stderr: String,
        leftover: usize,
    },
}

/// Lance une commande et lit sa sortie IMAGE PAR IMAGE, directement dans
/// le tube, sans passer par les morceaux de 8 Kio du plugin.
///
/// Pourquoi : mesuré en release, le plugin plafonne vers 500 Mo/s (≈ 80
/// images 1080p/s, ≈ 20 en UHD) alors que FFmpeg en produit 1,9 Go/s.
/// Pour l'export en lot, ce serait le goulot d'étranglement.
///
/// La commande vient toujours du plugin (`sidecar()` : même exécutable, mêmes
/// tubes, CREATE_NO_WINDOW sous Windows) ; seule la lecture change, via la
/// conversion publique `From<Command> for std::process::Command`.
/// Canal de capacité 2 : contre-pression comme avec le plugin.
pub fn spawn_frames(
    group: &ProcessGroup,
    cmd: Command,
    name: &str,
    frame_len: usize,
) -> Result<(Receiver<FrameMsg>, u32), String> {
    if group.is_cancelled() {
        return Err(CANCELLED.into());
    }
    let mut std_cmd: StdCommand = cmd.into();
    // Pas d'entrée standard : FFmpeg est lancé avec -nostdin.
    std_cmd.stdin(std::process::Stdio::null());
    let child = Arc::new(
        SharedChild::spawn(&mut std_cmd).map_err(|e| format!("Cannot start {name}: {e}"))?,
    );
    let pid = child.id();
    let mut stdout = child.take_stdout().ok_or("stdout unavailable")?;
    let mut stderr = child.take_stderr().ok_or("stderr unavailable")?;
    if let Ok(mut m) = group.0.children.lock() {
        m.insert(pid, Child::Direct(child.clone()));
    }
    if group.is_cancelled() {
        group.kill(pid);
    }

    // stderr dans un fil à part : un tube plein bloquerait FFmpeg.
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() < 16_384 {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    });

    let (tx, rx) = channel::<FrameMsg>(2);
    let g = group.clone();
    std::thread::spawn(move || {
        let mut leftover = 0;
        loop {
            let mut frame = vec![0u8; frame_len];
            let mut filled = 0;
            while filled < frame_len {
                match stdout.read(&mut frame[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if filled < frame_len {
                leftover = filled;
                break;
            }
            if tx.blocking_send(FrameMsg::Frame(frame)).is_err() {
                // Plus personne n'écoute : on arrête FFmpeg.
                g.kill(pid);
                break;
            }
        }
        drop(stdout);
        let code = child.wait().ok().and_then(|s| s.code());
        let stderr = err_thread.join().unwrap_or_default();
        let _ = tx.blocking_send(FrameMsg::Done {
            code,
            stderr,
            leftover,
        });
    });
    Ok((rx, pid))
}
