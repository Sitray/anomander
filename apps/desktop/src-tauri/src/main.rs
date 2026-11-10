// No console window on a release build; the app lives in the menu bar (DK-6).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    anomander_desktop_lib::run();
}
