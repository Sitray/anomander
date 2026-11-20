// T1b: the screen as the Accessibility API reads it, for `guard`. A thin adapter: it only reads,
// and whatever it cannot read is `None`, which the guard takes for a step of care. It needs the
// same Accessibility permission as sending input, which `perform_action` checks first. Before it
// reads, it asks the app with the focus to expose its page (`AXManualAccessibility`, which
// Electron apps such as Slack or Discord need); an app that ignores it reads as a group, and the
// guard takes that focus for one it could not read.
use std::ffi::{c_void, CString};
use std::path::Path;

use super::blocklist::AppIdentity;
use super::risk::{AxElement, Focus, TEXT_INPUT_ROLES};
use super::Screen;

type CFTypeRef = *const c_void;

const AX_SUCCESS: i32 = 0;
const UTF8: u32 = 0x0800_0100;
/// How long one read may wait on an app that does not answer, in seconds.
const READ_TIMEOUT: f32 = 0.5;
/// The most UTF-16 units read of one attribute: a terminal's scrollback or a document is not
/// read whole on every key.
const MAX_UNITS: isize = 512;
/// How many ancestors of the element under the point are read: enough to reach the button
/// around a label or an image.
const ANCESTORS: usize = 6;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCopyElementAtPosition(
        application: CFTypeRef,
        x: f32,
        y: f32,
        element: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
    fn AXUIElementSetAttributeValue(
        element: CFTypeRef,
        attribute: CFTypeRef,
        value: CFTypeRef,
    ) -> i32;
}

#[repr(C)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    fn CFRelease(object: CFTypeRef);
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFGetTypeID(object: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCString(allocator: CFTypeRef, text: *const i8, encoding: u32)
        -> CFTypeRef;
    fn CFStringGetLength(text: CFTypeRef) -> isize;
    fn CFStringGetCharacters(text: CFTypeRef, range: CFRange, buffer: *mut u16);
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CFTypeRef,
        path: *const u8,
        length: isize,
        is_directory: u8,
    ) -> CFTypeRef;
    fn CFBundleCreate(allocator: CFTypeRef, url: CFTypeRef) -> CFTypeRef;
    fn CFBundleGetIdentifier(bundle: CFTypeRef) -> CFTypeRef;
}

/// A Core Foundation object this side created or copied, released once.
struct Owned(CFTypeRef);

impl Owned {
    fn new(object: CFTypeRef) -> Option<Self> {
        (!object.is_null()).then_some(Self(object))
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a live object this side owns, released only here.
        unsafe { CFRelease(self.0) }
    }
}

/// `text` as a CFString.
fn cf_string(text: &str) -> Option<Owned> {
    let text = CString::new(text).ok()?;
    // SAFETY: `text` is a valid C string for the duration of the call.
    Owned::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
}

/// The first `MAX_UNITS` of `object` as text, when it is a CFString. It is borrowed, not
/// released.
fn rust_string(object: CFTypeRef) -> Option<String> {
    // SAFETY: `object` is a live CF object, read as a string only when it is one, into a buffer
    // as long as the range asked for, which is inside the string.
    unsafe {
        if object.is_null() || CFGetTypeID(object) != CFStringGetTypeID() {
            return None;
        }
        let length = CFStringGetLength(object).clamp(0, MAX_UNITS);
        let mut units = vec![0u16; usize::try_from(length).ok()?];
        let range = CFRange {
            location: 0,
            length,
        };
        CFStringGetCharacters(object, range, units.as_mut_ptr());
        Some(String::from_utf16_lossy(&units))
    }
}

/// The value of `attribute` of `element`.
fn attribute(element: CFTypeRef, attribute: &str) -> Option<Owned> {
    let name = cf_string(attribute)?;
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: `element` is a live AXUIElement and `name` a live CFString; a copied value is
    // owned by the caller.
    let error = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut value) };
    if error != AX_SUCCESS {
        return None;
    }
    Owned::new(value)
}

fn text_of(element: CFTypeRef, name: &str) -> Option<String> {
    attribute(element, name).and_then(|value| rust_string(value.0))
}

fn describe(element: CFTypeRef) -> AxElement {
    let role = text_of(element, "AXRole").unwrap_or_default();
    // A field's value is what was typed in it, never its name: it is not read. A value that is
    // not text (a number, a checkbox's state) says nothing.
    let value = if TEXT_INPUT_ROLES.contains(&role.as_str()) {
        None
    } else {
        text_of(element, "AXValue")
    };
    AxElement {
        subrole: text_of(element, "AXSubrole"),
        title: text_of(element, "AXTitle"),
        description: text_of(element, "AXDescription"),
        value,
        placeholder: text_of(element, "AXPlaceholderValue"),
        role,
    }
}

/// The system-wide element, with a timeout so an app that does not answer cannot hold the
/// action back.
fn system_wide() -> Option<Owned> {
    // SAFETY: creates a new element, owned by the caller.
    let element = Owned::new(unsafe { AXUIElementCreateSystemWide() })?;
    // SAFETY: `element` is live; on the system-wide element the timeout applies to every read.
    unsafe { AXUIElementSetMessagingTimeout(element.0, READ_TIMEOUT) };
    Some(element)
}

fn element_at(x: f64, y: f64) -> Option<Owned> {
    let system = system_wide()?;
    let mut found: CFTypeRef = std::ptr::null();
    // SAFETY: `system` is live; a found element is owned by the caller. Points are in the same
    // global, top-left coordinates the input is posted in.
    let error =
        unsafe { AXUIElementCopyElementAtPosition(system.0, x as f32, y as f32, &mut found) };
    if error != AX_SUCCESS {
        return None;
    }
    Owned::new(found)
}

/// The app with the focus, asked to expose its page first. Best effort: an app that does not
/// know the attribute answers an error, which is ignored.
fn focused_application() -> Option<Owned> {
    let app = attribute(system_wide()?.0, "AXFocusedApplication")?;
    if let Some(name) = cf_string("AXManualAccessibility") {
        // SAFETY: `app` is a live AXUIElement, `name` a live CFString and the value a constant.
        unsafe { AXUIElementSetAttributeValue(app.0, name.0, kCFBooleanTrue) };
    }
    Some(app)
}

fn focused() -> Option<Owned> {
    attribute(focused_application()?.0, "AXFocusedUIElement")
}

/// The app of the process that owns `element`.
fn app_of(element: CFTypeRef) -> Option<AppIdentity> {
    let mut pid = 0;
    // SAFETY: `element` is a live AXUIElement; `pid` outlives the call.
    if unsafe { AXUIElementGetPid(element, &mut pid) } != AX_SUCCESS {
        return None;
    }
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer has the size it is said to have.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    let path = String::from_utf8(buffer[..length].to_vec()).ok()?;
    let (bundle_path, name) = bundle_of(&path);
    Some(AppIdentity {
        pid,
        bundle_id: bundle_path.and_then(bundle_id),
        name,
    })
}

/// The outermost `.app` or `.bundle` an executable is in, and its name (or the executable's
/// when it is in none).
fn bundle_of(executable: &str) -> (Option<&str>, String) {
    let mut end = 0;
    for component in executable.split('/') {
        end += component.len() + 1;
        if let Some(name) = component
            .strip_suffix(".app")
            .or_else(|| component.strip_suffix(".bundle"))
        {
            return (Some(&executable[..end - 1]), name.to_string());
        }
    }
    let name = Path::new(executable)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    (None, name)
}

fn bundle_id(bundle_path: &str) -> Option<String> {
    let length = isize::try_from(bundle_path.len()).ok()?;
    // SAFETY: the path's bytes outlive the call; the URL and the bundle are owned here, and the
    // identifier is borrowed from the bundle, read before it is released.
    unsafe {
        let url = Owned::new(CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            bundle_path.as_ptr(),
            length,
            1,
        ))?;
        let bundle = Owned::new(CFBundleCreate(std::ptr::null(), url.0))?;
        rust_string(CFBundleGetIdentifier(bundle.0))
    }
}

/// The screen of this Mac.
pub struct SystemScreen;

impl Screen for SystemScreen {
    fn elements_at(&self, x: f64, y: f64) -> Option<Vec<AxElement>> {
        // The app under the point is most often the one with the focus.
        drop(focused_application());
        let mut current = element_at(x, y)?;
        let mut chain = vec![describe(current.0)];
        for _ in 0..ANCESTORS {
            let Some(parent) = attribute(current.0, "AXParent") else {
                break;
            };
            let read = describe(parent.0);
            let top = matches!(read.role.as_str(), "AXWindow" | "AXApplication");
            chain.push(read);
            if top {
                break;
            }
            current = parent;
        }
        Some(chain)
    }

    fn app_at(&self, x: f64, y: f64) -> Option<AppIdentity> {
        app_of(element_at(x, y)?.0)
    }

    fn focus(&self) -> Option<Focus> {
        let element = focused()?;
        let default = attribute(element.0, "AXWindow")
            .and_then(|window| attribute(window.0, "AXDefaultButton"));
        // SAFETY: both are live AXUIElements.
        let is_default_button = default
            .as_ref()
            .is_some_and(|button| unsafe { CFEqual(button.0, element.0) } != 0);
        Some(Focus {
            element: describe(element.0),
            is_default_button,
            default_button: default.map(|button| describe(button.0)),
        })
    }

    fn focused_app(&self) -> Option<AppIdentity> {
        app_of(focused_application()?.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_is_named_by_its_outermost_bundle() {
        assert_eq!(
            bundle_of("/System/Applications/System Settings.app/Contents/MacOS/System Settings"),
            (
                Some("/System/Applications/System Settings.app"),
                "System Settings".into()
            )
        );
        assert_eq!(
            bundle_of("/Applications/1Password.app/Contents/Library/LoginItems/Helper.app/x"),
            (Some("/Applications/1Password.app"), "1Password".into())
        );
        assert_eq!(
            bundle_of("/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"),
            (
                Some("/System/Library/CoreServices/loginwindow.app"),
                "loginwindow".into()
            )
        );
        assert_eq!(bundle_of("/usr/local/bin/tool"), (None, "tool".into()));
    }
}
