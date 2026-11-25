// Chibi Walker для рабочего стола.
// Окно — прозрачное, без рамки, поверх всех, размером с рабочую область основного монитора
// (низ окна = верх панели задач). Клики проходят сквозь окно, кроме мест, где нарисован чиби
// (и его меню): фоновый поток следит за курсором и включает «ловлю» мыши, только когда курсор над ними.
// Ещё Rust рассказывает маскоту об окружении: где окна приложений, какое окно активно, где каретка
// ввода и куда ты кликал, что в буфере обмена и какой файл открыт в редакторе кода.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Где окно ловит мышь: прямоугольники в CSS-пикселях окна + «тащат ли чиби сейчас».
#[derive(Default, Clone)]
struct Hit {
    rects: Vec<[f64; 4]>,
    drag: bool,
}

/// Что пользователь делал мышью и клавиатурой (в экранных пикселях).
#[derive(Default, Clone, Copy)]
struct Activity {
    click: Option<(f64, f64, Instant)>,
    key: Option<Instant>,
}

#[derive(Default)]
struct Shared {
    hit: Mutex<Hit>,
    act: Mutex<Activity>,
}

#[tauri::command]
fn set_hit(state: tauri::State<Shared>, rects: Vec<[f64; 4]>, drag: bool) {
    *state.hit.lock().unwrap() = Hit { rects, drag };
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Активное окно.
#[derive(Serialize, Clone)]
struct Fg {
    title: String,
    exe: String,
    rect: [f64; 4],
    /// во весь экран (видео, игра, презентация) — маскот прячется
    full: bool,
    /// это наше окно
    own: bool,
}

/// Снимок окружения для маскота. Координаты — в CSS-пикселях нашего окна.
#[derive(Serialize)]
struct Env {
    cursor: Option<(f64, f64)>,
    /// мс без ввода во всей системе
    idle: u64,
    /// мс с последнего нажатия клавиши (u64::MAX — не было)
    key_age: u64,
    /// последний клик мимо чиби: x, y, сколько мс назад
    click: Option<(f64, f64, u64)>,
    /// каретка ввода активного приложения (если оно её показывает системе)
    caret: Option<[f64; 4]>,
    ctrl: bool,
    fg: Option<Fg>,
    clip: u32,
}

/// Перевод экранных пикселей в CSS-пиксели нашего окна.
struct Conv {
    ox: f64,
    oy: f64,
    sf: f64,
}
impl Conv {
    fn of(w: &WebviewWindow) -> Option<Conv> {
        let p = w.outer_position().ok()?;
        Some(Conv { ox: p.x as f64, oy: p.y as f64, sf: w.scale_factor().ok()? })
    }
    fn pt(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.ox) / self.sf, (y - self.oy) / self.sf)
    }
    fn rect(&self, r: [f64; 4]) -> [f64; 4] {
        let (x, y) = self.pt(r[0], r[1]);
        [x, y, r[2] / self.sf, r[3] / self.sf]
    }
}

fn own_hwnd(w: &WebviewWindow) -> isize {
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        return h.0 as isize;
    }
    let _ = w;
    0
}

#[tauri::command]
fn env_info(window: WebviewWindow, state: tauri::State<Shared>) -> Option<Env> {
    let c = Conv::of(&window)?;
    let act = *state.act.lock().unwrap();
    let fg = win::foreground(own_hwnd(&window)).map(|f| Fg { rect: c.rect(f.rect), ..f });
    Some(Env {
        cursor: win::cursor().map(|(x, y)| c.pt(x, y)),
        idle: win::idle_ms(),
        key_age: act.key.map(|t| t.elapsed().as_millis() as u64).unwrap_or(u64::MAX),
        click: act.click.map(|(x, y, t)| {
            let (lx, ly) = c.pt(x, y);
            (lx, ly, t.elapsed().as_millis() as u64)
        }),
        caret: win::caret().map(|r| c.rect(r)),
        ctrl: win::ctrl_down(),
        fg,
        clip: win::clip_seq(),
    })
}

/// Окна приложений, которые видно на экране (сверху вниз по Z-порядку).
#[tauri::command]
fn windows_list(window: WebviewWindow) -> Vec<[f64; 4]> {
    let Some(c) = Conv::of(&window) else { return vec![] };
    win::app_windows(own_hwnd(&window)).into_iter().map(|r| c.rect(r)).collect()
}

/// Текст из буфера обмена (пароли из менеджеров паролей не читаем — они помечают их особым форматом).
#[tauri::command]
fn clipboard_text() -> Option<String> {
    win::clipboard_text()
}

#[derive(Serialize)]
struct CodeFile {
    path: String,
    name: String,
    text: String,
}

/// Файл, открытый в активном редакторе кода: путь восстанавливаем по заголовку окна.
#[tauri::command]
async fn read_code(title: String, exe: String) -> Option<CodeFile> {
    tauri::async_runtime::spawn_blocking(move || code::read(&title, &exe)).await.ok().flatten()
}

mod code {
    use super::CodeFile;
    use std::collections::VecDeque;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", ".next",
        ".nuxt", ".idea", "bin", "obj", ".cache", "coverage", ".gradle",
    ];

    pub fn read(title: &str, exe: &str) -> Option<CodeFile> {
        let path = resolve(title, exe)?;
        let meta = fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > 512 * 1024 {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return None; // бинарный файл
        }
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if text.len() > 60_000 {
            let mut cut = 60_000;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        Some(CodeFile {
            name: path.file_name()?.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            text,
        })
    }

    fn resolve(title: &str, exe: &str) -> Option<PathBuf> {
        if let Some(p) = abs_path_in(title) {
            return Some(p);
        }
        let exe = exe.to_ascii_lowercase();
        let vscode = match exe.as_str() {
            "code.exe" => Some("Code"),
            "code - insiders.exe" => Some("Code - Insiders"),
            "cursor.exe" => Some("Cursor"),
            "windsurf.exe" => Some("Windsurf"),
            "vscodium.exe" => Some("VSCodium"),
            _ => None,
        };
        if let Some(dir) = vscode {
            // «● main.rs - chibi-desktop - Visual Studio Code»
            let t = title.trim_start_matches(['●', '•', ' ']);
            let parts: Vec<&str> = t.split(" - ").collect();
            if parts.len() < 3 {
                return None;
            }
            let file = parts[0].trim();
            let folder = parts[1].trim().trim_end_matches(" (Workspace)").trim_end_matches(" (Рабочая область)");
            let storage = Path::new(&std::env::var("APPDATA").ok()?).join(dir).join("User/globalStorage/storage.json");
            let roots = folders_from_json(&fs::read_to_string(storage).ok()?, folder);
            return roots.iter().find_map(|r| find_file(r, file));
        }
        if is_jetbrains(&exe) {
            // «project – main.rs» или «project – src/main.rs»
            let parts: Vec<&str> = title.split(" \u{2013} ").collect();
            if parts.len() < 2 {
                return None;
            }
            let project = parts[0].trim();
            let file = parts[parts.len() - 1].trim();
            let file = file.rsplit(['/', '\\']).next().unwrap_or(file);
            let roots = jetbrains_projects(project);
            return roots.iter().find_map(|r| find_file(r, file));
        }
        None
    }

    fn is_jetbrains(exe: &str) -> bool {
        ["idea", "pycharm", "webstorm", "phpstorm", "rider", "goland", "clion", "rustrover", "rubymine", "datagrip"]
            .iter()
            .any(|n| exe.starts_with(n))
    }

    /// «*D:\www\file.txt - Notepad++» — путь прямо в заголовке.
    fn abs_path_in(title: &str) -> Option<PathBuf> {
        let b = title.as_bytes();
        for i in 0..b.len().saturating_sub(3) {
            if b[i].is_ascii_alphabetic() && b[i + 1] == b':' && b[i + 2] == b'\\' && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
                let rest = &title[i..];
                let end = rest.find(" - ").or_else(|| rest.find(" \u{2013} ")).unwrap_or(rest.len());
                let p = PathBuf::from(rest[..end].trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }

    /// Все папки вида "file:///d%3A/www/proj" из storage.json VS Code, у которых имя совпадает с заголовком.
    fn folders_from_json(json: &str, name: &str) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = vec![];
        let mut rest = json;
        while let Some(i) = rest.find("\"file:///") {
            rest = &rest[i + 9..];
            let Some(end) = rest.find('"') else { break };
            let p = PathBuf::from(percent_decode(&rest[..end]).replace('/', "\\"));
            rest = &rest[end..];
            let ok = p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(name)).unwrap_or(false);
            if ok && p.is_dir() && !out.contains(&p) {
                out.push(p);
            }
        }
        out
    }

    fn jetbrains_projects(name: &str) -> Vec<PathBuf> {
        let mut out = vec![];
        let Ok(appdata) = std::env::var("APPDATA") else { return out };
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let Ok(dirs) = fs::read_dir(Path::new(&appdata).join("JetBrains")) else { return out };
        for d in dirs.flatten() {
            let Ok(xml) = fs::read_to_string(d.path().join("options/recentProjects.xml")) else { continue };
            let mut rest = xml.as_str();
            while let Some(i) = rest.find("key=\"") {
                rest = &rest[i + 5..];
                let Some(end) = rest.find('"') else { break };
                let p = PathBuf::from(rest[..end].replace("$USER_HOME$", &home).replace('/', "\\"));
                rest = &rest[end..];
                let ok = p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(name)).unwrap_or(false);
                if ok && p.is_dir() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    fn percent_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Ищем файл по имени внутри проекта; если таких несколько — тот, что меняли последним.
    fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
        let mut best: Option<(SystemTime, PathBuf)> = None;
        let mut queue = VecDeque::from([(root.to_path_buf(), 0u32)]);
        let mut seen = 0u32;
        while let Some((dir, depth)) = queue.pop_front() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                seen += 1;
                if seen > 40_000 {
                    return best.map(|b| b.1);
                }
                let Ok(ft) = e.file_type() else { continue };
                let fname = e.file_name();
                let fname = fname.to_string_lossy();
                if ft.is_dir() {
                    if depth < 10 && !SKIP_DIRS.iter().any(|s| fname.eq_ignore_ascii_case(s)) {
                        queue.push_back((e.path(), depth + 1));
                    }
                } else if ft.is_file() && fname.eq_ignore_ascii_case(name) {
                    let m = e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                    if best.as_ref().map(|b| m > b.0).unwrap_or(true) {
                        best = Some((m, e.path()));
                    }
                }
            }
        }
        best.map(|b| b.1)
    }
}

#[cfg(windows)]
mod win {
    use super::Fg;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetWindowLongPtrW,
        GUITHREADINFO, GWL_EXSTYLE, MONITORINFOF_PRIMARY, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    pub fn cursor() -> Option<(f64, f64)> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then(|| (p.x as f64, p.y as f64))
    }

    /// Время последнего ввода (GetTickCount), чтобы отличать клавиатуру от мыши.
    pub fn last_input_tick() -> u32 {
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe { GetLastInputInfo(&mut li) };
        li.dwTime
    }

    pub fn idle_ms() -> u64 {
        unsafe { GetTickCount() }.wrapping_sub(last_input_tick()) as u64
    }

    fn down(vk: u16) -> bool {
        (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0
    }
    pub fn left_down() -> bool {
        down(VK_LBUTTON)
    }
    pub fn any_button_down() -> bool {
        down(VK_LBUTTON) || down(VK_RBUTTON) || down(VK_MBUTTON)
    }
    pub fn ctrl_down() -> bool {
        down(VK_CONTROL)
    }

    /// Клик по чиби не должен забирать фокус у программы, в которой работает пользователь,
    /// и окно не должно появляться в Alt+Tab.
    pub fn no_activate(hwnd: HWND) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize);
        }
    }

    fn wstr(buf: &[u16], n: i32) -> String {
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
    fn class_of(h: HWND) -> String {
        let mut b = [0u16; 128];
        let n = unsafe { GetClassNameW(h, b.as_mut_ptr(), b.len() as i32) };
        wstr(&b, n)
    }
    fn title_of(h: HWND) -> String {
        let mut b = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, b.as_mut_ptr(), b.len() as i32) };
        wstr(&b, n)
    }
    /// Рамка окна без невидимых «теней» Windows 10/11.
    fn rect_of(h: HWND) -> Option<[f64; 4]> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let ok = unsafe {
            DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut _ as _, std::mem::size_of::<RECT>() as u32)
        } == 0
            || unsafe { GetWindowRect(h, &mut r) } != 0;
        ok.then(|| [r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64])
    }
    fn cloaked(h: HWND) -> bool {
        let mut v: u32 = 0;
        let r = unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED as u32, &mut v as *mut _ as _, 4) };
        r == 0 && v != 0
    }
    const SHELL: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    static EXE_CACHE: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);
    fn exe_of(h: HWND) -> String {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        let mut cache = EXE_CACHE.lock().unwrap();
        let map = cache.get_or_insert_with(HashMap::new);
        if let Some(e) = map.get(&pid) {
            return e.clone();
        }
        let mut name = String::new();
        unsafe {
            let ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !ph.is_null() {
                let mut b = [0u16; 520];
                let mut n = b.len() as u32;
                if QueryFullProcessImageNameW(ph, 0, b.as_mut_ptr(), &mut n) != 0 {
                    let full = String::from_utf16_lossy(&b[..n as usize]);
                    name = full.rsplit('\\').next().unwrap_or("").to_string();
                }
                CloseHandle(ph);
            }
        }
        if map.len() > 500 {
            map.clear();
        }
        map.insert(pid, name.clone());
        name
    }

    pub fn foreground(own: isize) -> Option<Fg> {
        let h = unsafe { GetForegroundWindow() };
        if h.is_null() {
            return None;
        }
        let class = class_of(h);
        let rect = rect_of(h)?;
        // во весь экран основного монитора (и это не рабочий стол)
        let full = !SHELL.contains(&class.as_str()) && unsafe {
            let m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(m, &mut mi) != 0
                && mi.dwFlags & MONITORINFOF_PRIMARY != 0
                && rect[0] <= mi.rcMonitor.left as f64
                && rect[1] <= mi.rcMonitor.top as f64
                && rect[0] + rect[2] >= mi.rcMonitor.right as f64
                && rect[1] + rect[3] >= mi.rcMonitor.bottom as f64
        };
        Some(Fg { title: title_of(h), exe: exe_of(h), rect, full, own: h as isize == own })
    }

    pub fn caret() -> Option<[f64; 4]> {
        unsafe {
            let mut gi: GUITHREADINFO = std::mem::zeroed();
            gi.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            if GetGUIThreadInfo(0, &mut gi) == 0 || gi.hwndCaret.is_null() {
                return None;
            }
            let r = gi.rcCaret;
            if r.bottom <= r.top {
                return None;
            }
            let mut p = POINT { x: r.left, y: r.top };
            ClientToScreen(gi.hwndCaret, &mut p);
            Some([p.x as f64, p.y as f64, (r.right - r.left).max(2) as f64, (r.bottom - r.top) as f64])
        }
    }

    struct Collect {
        own: isize,
        out: Vec<[f64; 4]>,
    }
    unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> BOOL {
        let c = &mut *(lp as *mut Collect);
        if c.out.len() >= 64 {
            return 0;
        }
        if h as isize == c.own || IsWindowVisible(h) == 0 || IsIconic(h) != 0 || cloaked(h) {
            return 1;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0 {
            return 1;
        }
        if SHELL.contains(&class_of(h).as_str()) || title_of(h).is_empty() {
            return 1;
        }
        if let Some(r) = rect_of(h) {
            if r[2] > 60.0 && r[3] > 40.0 {
                c.out.push(r);
            }
        }
        1
    }
    pub fn app_windows(own: isize) -> Vec<[f64; 4]> {
        let mut c = Collect { own, out: vec![] };
        unsafe { EnumWindows(Some(enum_cb), &mut c as *mut _ as LPARAM) };
        c.out
    }

    pub fn clip_seq() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    pub fn clipboard_text() -> Option<String> {
        const CF_UNICODETEXT: u32 = 13;
        unsafe {
            let secret: Vec<u16> = "ExcludeClipboardContentFromMonitorProcessing\0".encode_utf16().collect();
            let fmt = RegisterClipboardFormatW(secret.as_ptr());
            if (fmt != 0 && IsClipboardFormatAvailable(fmt) != 0) || IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
                return None;
            }
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return None;
            }
            let mut out = None;
            let h = GetClipboardData(CF_UNICODETEXT);
            if !h.is_null() {
                let p = GlobalLock(h) as *const u16;
                if !p.is_null() {
                    let mut n = 0usize;
                    while n < 100_000 && *p.add(n) != 0 {
                        n += 1;
                    }
                    out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, n)));
                    GlobalUnlock(h);
                }
            }
            CloseClipboard();
            out
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::Fg;
    pub fn cursor() -> Option<(f64, f64)> {
        None
    }
    pub fn last_input_tick() -> u32 {
        0
    }
    pub fn idle_ms() -> u64 {
        0
    }
    pub fn left_down() -> bool {
        false
    }
    pub fn any_button_down() -> bool {
        false
    }
    pub fn ctrl_down() -> bool {
        false
    }
    pub fn foreground(_own: isize) -> Option<Fg> {
        None
    }
    pub fn caret() -> Option<[f64; 4]> {
        None
    }
    pub fn app_windows(_own: isize) -> Vec<[f64; 4]> {
        vec![]
    }
    pub fn clip_seq() -> u32 {
        0
    }
    pub fn clipboard_text() -> Option<String> {
        None
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

/// Фоновый поток: курсор над чиби (или его меню) — окно ловит мышь, иначе клики проходят насквозь.
/// Заодно запоминает, куда пользователь кликал мимо чиби и когда печатал.
fn spawn_watcher(app: AppHandle, w: WebviewWindow) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        let mut was_down = false;
        let mut last_tick = win::last_input_tick();
        let mut last_cur = win::cursor();
        loop {
            std::thread::sleep(Duration::from_millis(25));
            let state = app.state::<Shared>();
            let hit = state.hit.lock().unwrap().clone();
            let cur = win::cursor();
            let local = cur.and_then(|(cx, cy)| Conv::of(&w).map(|c| c.pt(cx, cy)));
            let over = local
                .map(|(lx, ly)| hit.rects.iter().any(|r| lx >= r[0] && lx <= r[0] + r[2] && ly >= r[1] && ly <= r[1] + r[3]))
                .unwrap_or(false);
            let inside = hit.drag || over;
            if last != Some(inside) {
                let _ = w.set_ignore_cursor_events(!inside);
                last = Some(inside);
            }

            // клик мимо чиби — это то место, с которым пользователь сейчас работает
            let down = win::left_down();
            if down && !was_down && !over {
                if let Some((cx, cy)) = cur {
                    state.act.lock().unwrap().click = Some((cx, cy, Instant::now()));
                }
                let _ = w.emit("outside-click", ());
            }
            was_down = down;

            // был ввод, но мышь не двигалась и кнопки не нажаты — значит, печатали
            let tick = win::last_input_tick();
            if tick != last_tick {
                if cur == last_cur && !win::any_button_down() {
                    state.act.lock().unwrap().key = Some(Instant::now());
                }
                last_tick = tick;
            }
            last_cur = cur;
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
            &item("snooze", "Не мешать 30 минут")?,
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
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![set_hit, env_info, windows_list, clipboard_text, read_code, quit])
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
            spawn_watcher(app.handle().clone(), w);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить Chibi Walker");
}
