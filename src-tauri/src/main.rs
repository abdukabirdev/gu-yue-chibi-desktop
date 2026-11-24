// Chibi Walker для рабочего стола.
// Окно — прозрачное, без рамки, поверх всех, размером с рабочую область основного монитора
// (низ окна = верх панели задач). Клики проходят сквозь окно, кроме места, где нарисован чиби:
// фоновый поток следит за курсором и включает «ловлю» мыши, только когда курсор над спрайтом.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Прямоугольник спрайта в CSS-пикселях окна + «тащат ли его сейчас».
#[derive(Default, Clone, Copy)]
struct Hit {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    drag: bool,
}

#[derive(Default)]
struct HitState(Mutex<Hit>);

#[tauri::command]
fn set_hit(state: tauri::State<HitState>, x: f64, y: f64, w: f64, h: f64, drag: bool) {
    *state.0.lock().unwrap() = Hit { x, y, w, h, drag };
}

/// Сколько миллисекунд пользователь ничего не нажимал и не двигал мышью (во всей системе).
#[tauri::command]
fn idle_ms() -> u64 {
    win::idle_ms()
}

/// Курсор в CSS-пикселях окна (окно его не видит, когда клики проходят насквозь).
#[tauri::command]
fn cursor_pos(window: WebviewWindow) -> Option<(f64, f64)> {
    let (cx, cy) = win::cursor()?;
    let pos = window.outer_position().ok()?;
    let sf = window.scale_factor().ok()?;
    Some(((cx - pos.x as f64) / sf, (cy - pos.y as f64) / sf))
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    pub fn cursor() -> Option<(f64, f64)> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then(|| (p.x as f64, p.y as f64))
    }

    pub fn idle_ms() -> u64 {
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if unsafe { GetLastInputInfo(&mut li) } == 0 {
            return 0;
        }
        unsafe { GetTickCount() }.wrapping_sub(li.dwTime) as u64
    }

    /// Клик по чиби не должен забирать фокус у программы, в которой работает пользователь,
    /// и окно не должно появляться в Alt+Tab.
    pub fn no_activate(hwnd: HWND) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize);
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn cursor() -> Option<(f64, f64)> {
        None
    }
    pub fn idle_ms() -> u64 {
        0
    }
}

/// Растягиваем окно на рабочую область основного монитора.
fn fit_to_work_area(w: &WebviewWindow) -> tauri::Result<()> {
    if let Some(m) = w.primary_monitor()? {
        let wa = m.work_area();
        let mut size = wa.size;
        // окно ровно во весь экран Windows считает «полноэкранным приложением» — оставляем 1 px
        if size == *m.size() {
            size.height = size.height.saturating_sub(1);
        }
        w.set_position(wa.position)?;
        w.set_size(size)?;
    }
    Ok(())
}

/// Фоновый поток: курсор над чиби — окно ловит мышь, иначе клики проходят насквозь.
fn spawn_hit_watcher(app: AppHandle, w: WebviewWindow) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(25));
            let hit = *app.state::<HitState>().0.lock().unwrap();
            let inside = hit.drag
                || (|| {
                    let (cx, cy) = win::cursor()?;
                    let pos = w.outer_position().ok()?;
                    let sf = w.scale_factor().ok()?;
                    let lx = (cx - pos.x as f64) / sf;
                    let ly = (cy - pos.y as f64) / sf;
                    Some(lx >= hit.x && lx <= hit.x + hit.w && ly >= hit.y && ly <= hit.y + hit.h)
                })()
                .unwrap_or(false);
            if last != Some(inside) {
                let _ = w.set_ignore_cursor_events(!inside);
                last = Some(inside);
            }
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let skins = Submenu::with_items(
        app,
        "Образ",
        true,
        &[&item("skin:cloak", "Плащ")?, &item("skin:disciple", "Ученик")?, &item("skin:random", "Случайно")?],
    )?;
    let mood = Submenu::with_items(
        app,
        "Настроение",
        true,
        &[&item("mood:auto", "Само меняется")?, &item("mood:cute", "Милый")?, &item("mood:stern", "Суровый")?],
    )?;
    let size = Submenu::with_items(
        app,
        "Размер",
        true,
        &[
            &item("size:100", "Маленький")?,
            &item("size:140", "Средний")?,
            &item("size:200", "Большой")?,
            &item("size:260", "Огромный")?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &item("call", "Позвать")?,
            &item("fly", "Полетать")?,
            &item("sleep", "Уложить спать / разбудить")?,
            &PredefinedMenuItem::separator(app)?,
            &skins,
            &mood,
            &size,
            &PredefinedMenuItem::separator(app)?,
            &item("toggle", "Спрятать / показать")?,
            &item("quit", "Выход")?,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main").tooltip("Chibi Walker").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, ev| match ev.id().as_ref() {
        "quit" => app.exit(0),
        "toggle" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_visible().unwrap_or(true) {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }
        }
        id => {
            let _ = app.emit("tray", id.to_string());
        }
    })
    .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(HitState::default())
        .invoke_handler(tauri::generate_handler![set_hit, idle_ms, cursor_pos])
        .setup(|app| {
            let w = app.get_webview_window("main").expect("нет окна main");
            fit_to_work_area(&w)?;
            #[cfg(windows)]
            if let Ok(h) = w.hwnd() {
                win::no_activate(h.0 as _);
            }
            w.set_ignore_cursor_events(true)?;
            w.show()?;
            build_tray(app.handle())?;
            spawn_hit_watcher(app.handle().clone(), w);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить Chibi Walker");
}
