// Pas de console noire derrière la fenêtre en version publiée sous Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    photogramme_lib::run()
}
