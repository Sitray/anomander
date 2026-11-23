// DK-10: performing ONE action on the principal's computer: a click, some text, a key or a
// scroll. The daemon only proposes an action; the window shows it and calls `perform_action`
// once the principal allowed that very action. This side trusts neither: every action is
// validated again here, and nothing else can be asked of it (no command, no file, no drag).
// macOS decides whether the app may send input at all (Privacy & Security > Accessibility).
// T1b: before the input, the shell reads the screen itself (`guard`): no action reaches an app of
// the blocklist, and a step the principal did not allow that the screen shows is of care is not
// performed, whatever the daemon or the window said about it.
use serde::Deserialize;

use crate::locale;

#[cfg(target_os = "macos")]
mod ax;
pub mod blocklist;
pub mod risk;

use blocklist::AppIdentity;
use risk::{AxElement, Focus, Seen};

/// The error the window knows as "macOS does not let the app use the computer" (`shell.ts`).
pub const NO_PERMISSION: &str = "computer_permission";
/// The step was not allowed and the screen shows it is of care: nothing was done, and it waits
/// for the principal. Followed by `:<role>:<name>` of what the screen showed, when it was read.
pub const CAREFUL: &str = "computer_careful";
/// The step targets an app of the blocklist: nothing was done, and the task ends. Followed by
/// `:` and the app's name.
pub const BLOCKED: &str = "computer_blocked";

/// The longest text one action types, as the daemon's planner.
const MAX_TEXT_CHARS: usize = 500;
/// A point of the capture goes from 0 to this, across its width and its height.
const SCALE: u16 = 1000;
/// How many lines one scroll moves.
const SCROLL_LINES: i32 = 5;

/// `ComputerAction` of `packages/protocol`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Click {
        x: u16,
        y: u16,
        double: bool,
        /// What the processor says is there; shown to the principal, never used here.
        #[serde(default)]
        target: String,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
        modifiers: Vec<Modifier>,
    },
    Scroll {
        x: u16,
        y: u16,
        direction: Direction,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Modifier {
    Cmd,
    Shift,
    Alt,
    Ctrl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
}

impl Modifier {
    /// Its `CGEventFlags` bit.
    fn flag(self) -> u64 {
        match self {
            Modifier::Shift => 0x0002_0000,
            Modifier::Ctrl => 0x0004_0000,
            Modifier::Alt => 0x0008_0000,
            Modifier::Cmd => 0x0010_0000,
        }
    }
}

/// The virtual key code of a key an action may press: the named keys, and letters and digits by
/// their place on the keyboard, which is what a shortcut such as Cmd-C means.
fn key_code(key: &str) -> Option<u16> {
    const LETTERS: [(char, u16); 36] = [
        ('a', 0),
        ('s', 1),
        ('d', 2),
        ('f', 3),
        ('h', 4),
        ('g', 5),
        ('z', 6),
        ('x', 7),
        ('c', 8),
        ('v', 9),
        ('b', 11),
        ('q', 12),
        ('w', 13),
        ('e', 14),
        ('r', 15),
        ('y', 16),
        ('t', 17),
        ('1', 18),
        ('2', 19),
        ('3', 20),
        ('4', 21),
        ('6', 22),
        ('5', 23),
        ('9', 25),
        ('7', 26),
        ('8', 28),
        ('0', 29),
        ('o', 31),
        ('u', 32),
        ('i', 34),
        ('p', 35),
        ('l', 37),
        ('j', 38),
        ('k', 40),
        ('n', 45),
        ('m', 46),
    ];
    match key {
        "enter" => Some(36),
        "tab" => Some(48),
        "space" => Some(49),
        "backspace" => Some(51),
        "escape" => Some(53),
        "left" => Some(123),
        "right" => Some(124),
        "down" => Some(125),
        "up" => Some(126),
        _ => {
            let mut chars = key.chars();
            let (first, rest) = (chars.next()?, chars.next());
            if rest.is_some() {
                return None;
            }
            LETTERS
                .iter()
                .find(|(letter, _)| *letter == first)
                .map(|(_, code)| *code)
        }
    }
}

/// The characters that write nothing and change how the rest reads: zero-width and direction
/// marks, line and paragraph separators, and the letters that show as nothing, as the daemon's
/// planner refuses them.
fn is_format(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{08E2}'
            | '\u{115F}'..='\u{1160}'
            | '\u{2028}'..='\u{2029}'
            | '\u{3164}'
            | '\u{FFA0}'
            | '\u{110BD}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E007F}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// Where input goes: the system, or a test's record of it. Points are in screen points.
pub trait Input {
    fn click(&mut self, x: f64, y: f64, double: bool);
    /// Types `text` exactly, where the cursor is.
    fn text(&mut self, text: &str);
    fn key(&mut self, code: u16, flags: u64);
    /// Positive `lines` scroll up.
    fn scroll(&mut self, x: f64, y: f64, lines: i32);
}

/// A point of the capture (0 to 1000 each way) as a point of a screen of `size`, inside it.
fn on_screen(x: u16, y: u16, size: (f64, f64)) -> Result<(f64, f64), String> {
    if x > SCALE || y > SCALE {
        return Err("the action points outside the screen".into());
    }
    let along = |value: u16, length: f64| {
        (f64::from(value) / f64::from(SCALE) * length).clamp(0.0, (length - 1.0).max(0.0))
    };
    Ok((along(x, size.0), along(y, size.1)))
}

/// An action checked and placed on the screen, ready to be sent.
enum Step<'a> {
    Click { x: f64, y: f64, double: bool },
    Text(&'a str),
    Key { key: &'a str, code: u16, flags: u64 },
    Scroll { x: f64, y: f64, lines: i32 },
}

/// `action` on a screen of `size` points, or why it is not valid.
fn prepare(action: &Action, size: (f64, f64)) -> Result<Step<'_>, String> {
    Ok(match action {
        Action::Click { x, y, double, .. } => {
            let (x, y) = on_screen(*x, *y, size)?;
            Step::Click {
                x,
                y,
                double: *double,
            }
        }
        Action::Type { text } => {
            let length = text.chars().count();
            if length == 0 || length > MAX_TEXT_CHARS {
                return Err("the text to type is empty or too long".into());
            }
            // What is typed is exactly what was shown: a control character is a key press (a
            // line break would be an Enter nobody read), and a format character reorders or
            // hides what is written.
            if text.chars().any(|c| c.is_control() || is_format(c)) {
                return Err("the text to type has control or format characters".into());
            }
            if text.trim().is_empty() {
                return Err("the text to type is blank".into());
            }
            Step::Text(text)
        }
        Action::Key { key, modifiers } => Step::Key {
            key,
            code: key_code(key).ok_or("the key is not one an action may press")?,
            flags: modifiers
                .iter()
                .fold(0, |flags, modifier| flags | modifier.flag()),
        },
        Action::Scroll { x, y, direction } => {
            let (x, y) = on_screen(*x, *y, size)?;
            let lines = match direction {
                Direction::Up => SCROLL_LINES,
                Direction::Down => -SCROLL_LINES,
            };
            Step::Scroll { x, y, lines }
        }
    })
}

fn send(step: &Step, input: &mut dyn Input) {
    match *step {
        Step::Click { x, y, double } => input.click(x, y, double),
        Step::Text(text) => input.text(text),
        Step::Key { code, flags, .. } => input.key(code, flags),
        Step::Scroll { x, y, lines } => input.scroll(x, y, lines),
    }
}

/// Performs `action` on a screen of `size` points, or nothing at all when it is not valid.
pub fn perform(action: &Action, size: (f64, f64), input: &mut dyn Input) -> Result<(), String> {
    send(&prepare(action, size)?, input);
    Ok(())
}

/// What the shell reads on the screen before an action (the Accessibility API), or a test's
/// version of it. Points are in screen points; `None` is what could not be read.
pub trait Screen {
    /// The element under the point, then its ancestors.
    fn elements_at(&self, x: f64, y: f64) -> Option<Vec<AxElement>>;
    /// The app that owns the element under the point.
    fn app_at(&self, x: f64, y: f64) -> Option<AppIdentity>;
    /// The element with the focus, where keys and text go.
    fn focus(&self) -> Option<Focus>;
    /// The app with the focus.
    fn focused_app(&self) -> Option<AppIdentity>;
}

/// Whether `step` may be sent: never to an app of the blocklist, and, unless the principal
/// `permitted` it, only when the screen shows it is routine.
fn guard(step: &Step, permitted: bool, screen: &dyn Screen, own_pid: i32) -> Result<(), String> {
    let app = match *step {
        Step::Click { x, y, .. } | Step::Scroll { x, y, .. } => screen.app_at(x, y),
        Step::Text(_) | Step::Key { .. } => screen.focused_app(),
    };
    if let Some(label) = app
        .as_ref()
        .and_then(|app| blocklist::blocked(app, own_pid))
    {
        return Err(format!("{BLOCKED}:{}", label.in_(locale::current())));
    }
    if permitted {
        return Ok(());
    }
    // What cannot be read is of care: the app, the element under the point, the focus. A step of
    // care says what the screen showed (`computer_careful:<role>:<name>`), when it showed one.
    let careful = |seen: Option<Seen>| {
        Err(match seen {
            Some(Seen { role, label }) => format!("{CAREFUL}:{role}:{label}"),
            None => CAREFUL.to_string(),
        })
    };
    if app.is_none() {
        return careful(None);
    }
    let on_focus = |judge: fn(&Focus) -> bool| match screen.focus() {
        None => careful(None),
        Some(focus) if judge(&focus) => careful(Some(Seen::of(&focus.element))),
        Some(_) => Ok(()),
    };
    match *step {
        Step::Click { x, y, .. } => match screen.elements_at(x, y) {
            Some(chain) if !risk::careful_click(&chain) => Ok(()),
            chain => careful(chain.as_deref().and_then(risk::seen_at_click)),
        },
        // Whatever is held with them: Shift+Enter still submits a form.
        Step::Key { key: "enter", .. } => on_focus(risk::careful_return),
        Step::Key { key: "space", .. } => on_focus(risk::careful_space),
        Step::Text(_) => on_focus(risk::careful_typing),
        Step::Key { .. } | Step::Scroll { .. } => Ok(()),
    }
}

/// Performs `action` as `perform` does, once `guard` let it through. `own_pid` is ANOMANDER's.
pub fn perform_guarded(
    action: &Action,
    size: (f64, f64),
    permitted: bool,
    screen: &dyn Screen,
    own_pid: i32,
    input: &mut dyn Input,
) -> Result<(), String> {
    let step = prepare(action, size)?;
    guard(&step, permitted, screen, own_pid)?;
    send(&step, input);
    Ok(())
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::c_void;
    use std::thread::sleep;
    use std::time::Duration;

    use super::Input;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    type CGEventRef = *mut c_void;

    const LEFT_MOUSE_DOWN: u32 = 1;
    const LEFT_MOUSE_UP: u32 = 2;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_BUTTON: u32 = 0;
    const HID_EVENT_TAP: u32 = 0;
    const CLICK_STATE_FIELD: u32 = 1;
    const SCROLL_UNIT_LINE: u32 = 1;
    /// The most UTF-16 units one keyboard event carries.
    const UNITS_PER_EVENT: usize = 20;
    /// Between two events, so the app under the pointer keeps up.
    const BETWEEN_EVENTS: Duration = Duration::from_millis(12);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            position: CGPoint,
            button: u32,
        ) -> CGEventRef;
        fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> CGEventRef;
        fn CGEventCreateScrollWheelEvent2(
            source: *const c_void,
            units: u32,
            wheels: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
        fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
        fn CGEventPost(tap: u32, event: CGEventRef);
    }

    #[repr(C)]
    struct Opaque {
        _private: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: Opaque;
        static kCFTypeDictionaryValueCallBacks: Opaque;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const Opaque,
            value_callbacks: *const Opaque,
        ) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: *const c_void;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    }

    /// Whether macOS lets the app send input. The first time it does not, macOS shows its own
    /// prompt, which leads to the setting.
    pub fn allowed() -> bool {
        // SAFETY: the dictionary holds one constant key and one constant value, both owned by
        // the system; it is released once the call that reads it returned.
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            let trusted = AXIsProcessTrustedWithOptions(options) != 0;
            if !options.is_null() {
                CFRelease(options);
            }
            trusted
        }
    }

    /// The main display's size, in points: the screen a capture shows.
    pub fn screen_size() -> (f64, f64) {
        // SAFETY: both calls only read the display's configuration.
        let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
        (bounds.size.width, bounds.size.height)
    }

    /// Posts `event`, when the system could create it, and releases it.
    fn post(event: CGEventRef) {
        if event.is_null() {
            return;
        }
        // SAFETY: `event` was just created by the caller, is posted once and released once.
        unsafe {
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        sleep(BETWEEN_EVENTS);
    }

    fn mouse(kind: u32, at: CGPoint, clicks: i64) {
        // SAFETY: a null source is the documented default; the event is handed to `post`.
        let event = unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, at, LEFT_BUTTON) };
        if !event.is_null() {
            // SAFETY: `event` is a live mouse event.
            unsafe {
                CGEventSetIntegerValueField(event, CLICK_STATE_FIELD, clicks);
                // No modifier the principal happens to hold becomes part of the click.
                CGEventSetFlags(event, 0);
            }
        }
        post(event);
    }

    fn keyboard(code: u16, down: bool, flags: u64, units: &[u16]) {
        // SAFETY: a null source is the documented default; the event is handed to `post`.
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
        if !event.is_null() {
            // SAFETY: `event` is a live keyboard event, and `units` outlives the call.
            unsafe {
                CGEventSetFlags(event, flags);
                if !units.is_empty() {
                    CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
                }
            }
        }
        post(event);
    }

    /// The system's input.
    pub struct SystemInput;

    impl Input for SystemInput {
        fn click(&mut self, x: f64, y: f64, double: bool) {
            let at = CGPoint { x, y };
            mouse(MOUSE_MOVED, at, 0);
            mouse(LEFT_MOUSE_DOWN, at, 1);
            mouse(LEFT_MOUSE_UP, at, 1);
            if double {
                mouse(LEFT_MOUSE_DOWN, at, 2);
                mouse(LEFT_MOUSE_UP, at, 2);
            }
        }

        fn text(&mut self, text: &str) {
            let mut units: Vec<u16> = Vec::with_capacity(UNITS_PER_EVENT);
            for character in text.chars() {
                let mut buffer = [0u16; 2];
                let encoded = character.encode_utf16(&mut buffer);
                // A character is never split between two events.
                if units.len() + encoded.len() > UNITS_PER_EVENT {
                    keyboard(0, true, 0, &units);
                    keyboard(0, false, 0, &units);
                    units.clear();
                }
                units.extend_from_slice(encoded);
            }
            if !units.is_empty() {
                keyboard(0, true, 0, &units);
                keyboard(0, false, 0, &units);
            }
        }

        fn key(&mut self, code: u16, flags: u64) {
            keyboard(code, true, flags, &[]);
            keyboard(code, false, flags, &[]);
        }

        fn scroll(&mut self, x: f64, y: f64, lines: i32) {
            mouse(MOUSE_MOVED, CGPoint { x, y }, 0);
            // SAFETY: a null source is the documented default; the event is handed to `post`.
            let event = unsafe {
                CGEventCreateScrollWheelEvent2(std::ptr::null(), SCROLL_UNIT_LINE, 1, lines, 0, 0)
            };
            post(event);
        }
    }
}

#[cfg(target_os = "macos")]
pub use ax::SystemScreen;
#[cfg(target_os = "macos")]
pub use system::{allowed, screen_size, SystemInput};

/// Not ported yet: `allowed` says no, so the window shows its permission message and nothing
/// reads the screen or sends input.
#[cfg(not(target_os = "macos"))]
mod unported {
    use super::blocklist::AppIdentity;
    use super::risk::{AxElement, Focus};
    use super::{Input, Screen};

    pub fn allowed() -> bool {
        false
    }

    pub fn screen_size() -> (f64, f64) {
        (0.0, 0.0)
    }

    pub struct SystemScreen;

    impl Screen for SystemScreen {
        fn elements_at(&self, _: f64, _: f64) -> Option<Vec<AxElement>> {
            None
        }
        fn app_at(&self, _: f64, _: f64) -> Option<AppIdentity> {
            None
        }
        fn focus(&self) -> Option<Focus> {
            None
        }
        fn focused_app(&self) -> Option<AppIdentity> {
            None
        }
    }

    pub struct SystemInput;

    impl Input for SystemInput {
        fn click(&mut self, _: f64, _: f64, _: bool) {}
        fn text(&mut self, _: &str) {}
        fn key(&mut self, _: u16, _: u64) {}
        fn scroll(&mut self, _: f64, _: f64, _: i32) {}
    }
}

#[cfg(not(target_os = "macos"))]
pub use unported::{allowed, screen_size, SystemInput, SystemScreen};

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorded(Vec<String>);

    impl Input for Recorded {
        fn click(&mut self, x: f64, y: f64, double: bool) {
            self.0.push(format!("click {x} {y} {double}"));
        }
        fn text(&mut self, text: &str) {
            self.0.push(format!("text {text}"));
        }
        fn key(&mut self, code: u16, flags: u64) {
            self.0.push(format!("key {code} {flags:#x}"));
        }
        fn scroll(&mut self, x: f64, y: f64, lines: i32) {
            self.0.push(format!("scroll {x} {y} {lines}"));
        }
    }

    const SCREEN: (f64, f64) = (1440.0, 900.0);

    fn action(json: &str) -> Result<Action, serde_json::Error> {
        serde_json::from_str(json)
    }

    fn done(json: &str) -> Result<Vec<String>, String> {
        let mut input = Recorded::default();
        perform(&action(json).unwrap(), SCREEN, &mut input).map(|()| input.0)
    }

    #[test]
    fn a_click_lands_on_the_point_of_the_capture() {
        let click = r#"{"kind":"click","x":500,"y":100,"double":false,"target":"Enviar"}"#;
        assert_eq!(done(click).unwrap(), ["click 720 90 false"]);
        let double = r#"{"kind":"click","x":0,"y":0,"double":true,"target":"x"}"#;
        assert_eq!(done(double).unwrap(), ["click 0 0 true"]);
    }

    #[test]
    fn the_edge_of_the_capture_is_still_inside_the_screen() {
        let corner = r#"{"kind":"click","x":1000,"y":1000,"double":false,"target":"x"}"#;
        assert_eq!(done(corner).unwrap(), ["click 1439 899 false"]);
    }

    #[test]
    fn a_point_outside_the_capture_does_nothing() {
        for json in [
            r#"{"kind":"click","x":1001,"y":10,"double":false,"target":"x"}"#,
            r#"{"kind":"scroll","x":10,"y":1001,"direction":"down"}"#,
        ] {
            assert!(done(json).is_err(), "{json}");
        }
    }

    #[test]
    fn text_is_typed_exactly_and_within_its_limit() {
        assert_eq!(
            done(r#"{"kind":"type","text":"Hola, Marta: ñ €"}"#).unwrap(),
            ["text Hola, Marta: ñ €"]
        );
        // A line break would be an Enter that the text shown does not say.
        assert!(done(r#"{"kind":"type","text":"rm -rf ~/Documents\n"}"#).is_err());
        // A direction character would show the text in another order than it is typed.
        assert!(done(r#"{"kind":"type","text":"abc\u202edef"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":"a\u200bb"}"#).is_err());
        // A line separator, a letter that shows as nothing, a tag character.
        assert!(done(r#"{"kind":"type","text":"a\u2028b"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":"a\u3164b"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":"a\u034fb"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":"a\udb40\udc41b"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":""}"#).is_err());
        let long = format!(r#"{{"kind":"type","text":"{}"}}"#, "ñ".repeat(501));
        assert!(done(&long).is_err());
        let longest = format!(r#"{{"kind":"type","text":"{}"}}"#, "ñ".repeat(500));
        assert!(done(&longest).is_ok());
        // An escape or a tab would be a key press hidden inside what reads as text.
        assert!(done(r#"{"kind":"type","text":"a\u001bb"}"#).is_err());
        assert!(done(r#"{"kind":"type","text":"a\tb"}"#).is_err());
    }

    #[test]
    fn a_key_is_pressed_with_its_modifiers() {
        assert_eq!(
            done(r#"{"kind":"key","key":"c","modifiers":["cmd"]}"#).unwrap(),
            ["key 8 0x100000"]
        );
        assert_eq!(
            done(r#"{"kind":"key","key":"enter","modifiers":[]}"#).unwrap(),
            ["key 36 0x0"]
        );
        assert_eq!(
            done(r#"{"kind":"key","key":"z","modifiers":["cmd","shift","cmd"]}"#).unwrap(),
            ["key 6 0x120000"]
        );
    }

    #[test]
    fn a_key_that_is_not_allowed_does_nothing() {
        for key in ["f13", "", "ab", "A", "ñ", "delete"] {
            let json = format!(r#"{{"kind":"key","key":"{key}","modifiers":[]}}"#);
            assert!(done(&json).is_err(), "{key}");
        }
    }

    #[test]
    fn a_scroll_moves_the_page_under_the_point() {
        assert_eq!(
            done(r#"{"kind":"scroll","x":500,"y":500,"direction":"down"}"#).unwrap(),
            ["scroll 720 450 -5"]
        );
        assert_eq!(
            done(r#"{"kind":"scroll","x":500,"y":500,"direction":"up"}"#).unwrap(),
            ["scroll 720 450 5"]
        );
    }

    #[test]
    fn nothing_but_the_four_actions_can_be_asked() {
        for json in [
            r#"{"kind":"run","command":"rm -rf ~"}"#,
            r#"{"kind":"drag","x":1,"y":1}"#,
            r#"{"kind":"click","x":1,"y":1,"double":false,"target":"x","button":"right"}"#,
            r#"{"kind":"click","x":-1,"y":1,"double":false,"target":"x"}"#,
            r#"{"kind":"click","x":1.5,"y":1,"double":false,"target":"x"}"#,
            r#"{"kind":"key","key":"c","modifiers":["hyper"]}"#,
            r#"{"kind":"type","text":"a","then":"enter"}"#,
        ] {
            assert!(action(json).is_err(), "{json}");
        }
    }

    /// What a test's screen shows: one element and its app under every point, and one focus.
    #[derive(Clone)]
    struct Shown {
        under: Option<Vec<AxElement>>,
        app: Option<AppIdentity>,
        focus: Option<Focus>,
    }

    impl Screen for Shown {
        fn elements_at(&self, _: f64, _: f64) -> Option<Vec<AxElement>> {
            self.under.clone()
        }
        fn app_at(&self, _: f64, _: f64) -> Option<AppIdentity> {
            self.app.clone()
        }
        fn focus(&self) -> Option<Focus> {
            self.focus.clone()
        }
        fn focused_app(&self) -> Option<AppIdentity> {
            self.app.clone()
        }
    }

    const OWN_PID: i32 = 4242;

    fn safari() -> AppIdentity {
        AppIdentity {
            pid: 100,
            bundle_id: Some("com.apple.Safari".into()),
            name: "Safari".into(),
        }
    }

    fn element(role: &str, title: &str) -> AxElement {
        AxElement {
            role: role.into(),
            title: Some(title.into()),
            ..AxElement::default()
        }
    }

    /// A screen with `under` under every point and the focus on `focused`, in Safari.
    fn shown(under: AxElement, focused: AxElement) -> Shown {
        Shown {
            under: Some(vec![under]),
            app: Some(safari()),
            focus: Some(Focus {
                element: focused,
                ..Focus::default()
            }),
        }
    }

    fn guarded(json: &str, permitted: bool, screen: &Shown) -> Result<Vec<String>, String> {
        let mut input = Recorded::default();
        perform_guarded(
            &action(json).unwrap(),
            SCREEN,
            permitted,
            screen,
            OWN_PID,
            &mut input,
        )
        .map(|()| input.0)
    }

    const CLICK_ON_SEARCH: &str =
        r#"{"kind":"click","x":500,"y":100,"double":false,"target":"Buscar"}"#;
    const ENTER: &str = r#"{"kind":"key","key":"enter","modifiers":[]}"#;
    const SPACE: &str = r#"{"kind":"key","key":"space","modifiers":[]}"#;

    #[test]
    fn a_click_is_judged_on_the_element_under_the_point_not_on_the_target() {
        // The processor calls it "Buscar"; the screen shows a Send button there, and says so.
        let send = shown(element("AXButton", "Enviar"), element("AXGroup", ""));
        assert_eq!(
            guarded(CLICK_ON_SEARCH, false, &send),
            Err(format!("{CAREFUL}:AXButton:Enviar"))
        );
        // Allowed by the principal, it is performed.
        assert_eq!(
            guarded(CLICK_ON_SEARCH, true, &send).unwrap(),
            ["click 720 90 false"]
        );
        // And a routine element is clicked without asking, whatever the target says.
        let field = shown(
            element("AXTextField", "Barra de direcciones"),
            element("AXGroup", ""),
        );
        let named_send = r#"{"kind":"click","x":500,"y":100,"double":false,"target":"Enviar"}"#;
        assert_eq!(
            guarded(named_send, false, &field).unwrap(),
            ["click 720 90 false"]
        );
    }

    #[test]
    fn return_and_space_go_without_asking_only_in_a_search_or_address_field() {
        let address = shown(
            element("AXGroup", ""),
            element("AXTextField", "Barra de direcciones"),
        );
        assert_eq!(guarded(ENTER, false, &address).unwrap(), ["key 36 0x0"]);
        assert_eq!(guarded(SPACE, false, &address).unwrap(), ["key 49 0x0"]);

        // A web form's field, a terminal, an Electron page that reads as a group.
        for (focused, said) in [
            (element("AXTextField", "Importe"), "AXTextField:Importe"),
            (element("AXTextArea", ""), "AXTextArea:"),
            (element("AXGroup", ""), "AXGroup:"),
        ] {
            let screen = shown(element("AXGroup", ""), focused);
            let careful = Err(format!("{CAREFUL}:{said}"));
            assert_eq!(guarded(ENTER, false, &screen), careful, "{said}");
            assert_eq!(guarded(SPACE, false, &screen), careful, "{said}");
            let shift_enter = r#"{"kind":"key","key":"enter","modifiers":["shift"]}"#;
            assert_eq!(guarded(shift_enter, false, &screen), careful, "{said}");
            assert_eq!(guarded(ENTER, true, &screen).unwrap(), ["key 36 0x0"]);
        }
    }

    #[test]
    fn text_is_typed_without_asking_only_into_a_field() {
        let field = shown(element("AXGroup", ""), element("AXTextField", "Importe"));
        let spaced = r#"{"kind":"type","text":"hola mundo"}"#;
        assert_eq!(guarded(spaced, false, &field).unwrap(), ["text hola mundo"]);
        // On a button a space presses it; on a page that is not read, letters can be shortcuts.
        for (focused, said) in [
            (element("AXButton", "Abrir"), "AXButton:Abrir"),
            (element("AXWebArea", "Slack"), "AXWebArea:Slack"),
        ] {
            let screen = shown(element("AXGroup", ""), focused);
            for json in [spaced, r#"{"kind":"type","text":"e"}"#] {
                assert_eq!(
                    guarded(json, false, &screen),
                    Err(format!("{CAREFUL}:{said}")),
                    "{json}"
                );
            }
        }
    }

    #[test]
    fn what_cannot_be_read_is_asked_for() {
        let unread = Shown {
            under: None,
            app: Some(safari()),
            focus: None,
        };
        assert_eq!(
            guarded(CLICK_ON_SEARCH, false, &unread),
            Err(CAREFUL.into())
        );
        assert_eq!(guarded(ENTER, false, &unread), Err(CAREFUL.into()));
        assert_eq!(guarded(SPACE, false, &unread), Err(CAREFUL.into()));
        // Keys that press nothing need no element.
        let tab = r#"{"kind":"key","key":"tab","modifiers":[]}"#;
        assert_eq!(guarded(tab, false, &unread).unwrap(), ["key 48 0x0"]);
        // Without knowing the app, nothing goes without asking.
        let nowhere = Shown {
            app: None,
            ..unread
        };
        assert_eq!(guarded(tab, false, &nowhere), Err(CAREFUL.into()));
        assert_eq!(guarded(tab, true, &nowhere).unwrap(), ["key 48 0x0"]);
    }

    #[test]
    fn an_app_of_the_blocklist_is_never_acted_on_even_when_allowed() {
        let mut settings = shown(element("AXButton", "Abrir"), element("AXGroup", ""));
        settings.app = Some(AppIdentity {
            pid: 200,
            bundle_id: Some("com.apple.systempreferences".into()),
            name: "System Settings".into(),
        });
        let refused = Err(format!("{BLOCKED}:Ajustes del Sistema"));
        let scroll = r#"{"kind":"scroll","x":500,"y":500,"direction":"down"}"#;
        for json in [CLICK_ON_SEARCH, ENTER, scroll] {
            assert_eq!(guarded(json, false, &settings), refused, "{json}");
            assert_eq!(guarded(json, true, &settings), refused, "{json}");
        }
        let mut own = settings.clone();
        own.app = Some(AppIdentity {
            pid: OWN_PID,
            bundle_id: None,
            name: "anomander-desktop".into(),
        });
        assert_eq!(
            guarded(CLICK_ON_SEARCH, true, &own),
            Err(format!("{BLOCKED}:ANOMANDER"))
        );
    }

    #[test]
    fn an_action_that_is_not_valid_is_refused_before_the_screen_is_judged() {
        let send = shown(element("AXButton", "Enviar"), element("AXGroup", ""));
        let outside = r#"{"kind":"click","x":1001,"y":10,"double":false,"target":"x"}"#;
        assert_eq!(
            guarded(outside, false, &send),
            Err("the action points outside the screen".into())
        );
    }
}
