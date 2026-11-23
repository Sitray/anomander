// The language the principal reads: the shell's own text (the menu bar, its notification, the
// diagnostic report, the names of the blocked apps), the daemon's (`ANOMANDER_LOCALE`) and every
// webview's (`window.__ANOMANDER_LOCALE__`). Spanish on a Spanish system, English on any other, as
// `localeOf` in `packages/protocol/src/locale.ts` decides. Read once, at start, from the system's
// preferred language, never from `LANG`: an app opened from the Finder has none.
use std::sync::OnceLock;

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    Es,
    En,
}

impl Locale {
    /// The language for a system language tag: Spanish for any Spanish one (`es`, `es-ES`,
    /// `es-419`, `es_ES.UTF-8`), English for every other one, and for none.
    pub fn of(tag: Option<&str>) -> Locale {
        let tag = tag.unwrap_or_default().trim();
        let spanish = tag
            .get(..2)
            .is_some_and(|start| start.eq_ignore_ascii_case("es"))
            && tag[2..]
                .chars()
                .next()
                .is_none_or(|next| matches!(next, '-' | '_' | '.'));
        if spanish {
            Locale::Es
        } else {
            Locale::En
        }
    }

    /// The language for a Windows language ID (`LANGID`): Spanish when its primary language is
    /// (`LANG_SPANISH`, the low ten bits), whatever the country.
    pub fn of_language_id(id: u16) -> Locale {
        const LANG_SPANISH: u16 = 0x0a;
        if id & 0x3ff == LANG_SPANISH {
            Locale::Es
        } else {
            Locale::En
        }
    }

    /// What the daemon reads in `ANOMANDER_LOCALE`.
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Es => "es",
            Locale::En => "en",
        }
    }

    /// `es` in Spanish, `en` in English.
    pub fn pick<T>(self, es: T, en: T) -> T {
        match self {
            Locale::Es => es,
            Locale::En => en,
        }
    }

    /// What every webview runs before its own scripts. One of two fixed literals: nothing from
    /// outside is ever put in it.
    pub fn init_script(self) -> &'static str {
        match self {
            Locale::Es => "window.__ANOMANDER_LOCALE__ = 'es';",
            Locale::En => "window.__ANOMANDER_LOCALE__ = 'en';",
        }
    }
}

static CHOSEN: OnceLock<Locale> = OnceLock::new();

/// Chooses the language of the shell's text for the life of the process; the first choice stays.
pub fn choose(locale: Locale) {
    let _ = CHOSEN.set(locale);
}

/// The language chosen at start; Spanish until one is, as the text always was.
pub fn current() -> Locale {
    CHOSEN.get().copied().unwrap_or(Locale::Es)
}

/// Hands `locale` to every webview before its scripts run.
pub fn plugin<R: Runtime>(locale: Locale) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("locale")
        .js_init_script(locale.init_script())
        .build()
}

/// The system's preferred language: the first of the principal's languages in System Settings ›
/// General › Language & Region on macOS.
#[cfg(target_os = "macos")]
pub fn system() -> Locale {
    let languages = objc2_foundation::NSLocale::preferredLanguages();
    Locale::of(
        languages
            .firstObject()
            .map(|tag| tag.to_string())
            .as_deref(),
    )
}

/// The system's preferred language: the language of Windows' display (Settings › Time & language).
#[cfg(windows)]
pub fn system() -> Locale {
    // SAFETY: takes nothing and returns a value; it reads the user's settings.
    Locale::of_language_id(unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() })
}

/// Elsewhere (a development build on Linux), the variables a POSIX system reads for messages.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn system() -> Locale {
    let tag = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()));
    Locale::of(tag.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_spanish_tag_is_spanish() {
        for tag in [
            "es",
            "es-ES",
            "es-419",
            "es_ES.UTF-8",
            "ES",
            "Es-mx",
            " es-AR ",
            "es.UTF-8",
        ] {
            assert_eq!(Locale::of(Some(tag)), Locale::Es, "{tag:?}");
        }
    }

    #[test]
    fn every_other_tag_and_none_is_english() {
        for tag in [
            "en", "en-US", "en-GB", "fr-FR", "pt-BR", "est", "eses", "e", "", "  ", "ca-ES", "C",
            "ñ",
        ] {
            assert_eq!(Locale::of(Some(tag)), Locale::En, "{tag:?}");
        }
        assert_eq!(Locale::of(None), Locale::En);
    }

    #[test]
    fn a_spanish_windows_language_id_is_spanish_whatever_the_country() {
        // es-ES (modern sort), es-ES (traditional), es-MX, es-419.
        for id in [0x0c0a, 0x040a, 0x080a, 0x580a] {
            assert_eq!(Locale::of_language_id(id), Locale::Es, "{id:#06x}");
        }
        // en-US, en-GB, fr-FR, ca-ES, and 0 when it could not be read.
        for id in [0x0409, 0x0809, 0x040c, 0x0403, 0] {
            assert_eq!(Locale::of_language_id(id), Locale::En, "{id:#06x}");
        }
    }

    #[test]
    fn the_daemon_and_the_webviews_get_one_of_two_fixed_values() {
        assert_eq!(Locale::Es.as_str(), "es");
        assert_eq!(Locale::En.as_str(), "en");
        assert_eq!(
            Locale::Es.init_script(),
            "window.__ANOMANDER_LOCALE__ = 'es';"
        );
        assert_eq!(
            Locale::En.init_script(),
            "window.__ANOMANDER_LOCALE__ = 'en';"
        );
    }

    #[test]
    fn the_text_is_spanish_until_a_language_is_chosen() {
        // No test chooses one: the shell's Spanish assertions hold whatever this machine speaks.
        assert_eq!(current(), Locale::Es);
        assert_eq!(Locale::Es.pick("sí", "yes"), "sí");
        assert_eq!(Locale::En.pick("sí", "yes"), "yes");
    }
}
