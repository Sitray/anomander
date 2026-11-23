// T1b: the apps no action may target, whoever allowed it: ANOMANDER itself, System Settings, the
// login and authorization prompts, Keychain Access and the known password managers. After
// gentle-dot's `computer/blocklist.rs` (MIT), macOS only.
use crate::locale::Locale;

/// The app an action targets: the one with the focus for keys and text, the one under the
/// point for a click or a scroll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    pub pid: i32,
    pub bundle_id: Option<String>,
    /// Its bundle's name (`System Settings` for `System Settings.app`), or its executable's.
    pub name: String,
}

/// How the principal knows a blocked app: the name macOS shows it by, in each language. Only
/// shown: what blocks an app is its bundle id or its own name (`Entry::names`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Label {
    es: &'static str,
    en: &'static str,
}

impl Label {
    /// A name that is the same in every language.
    const fn same(name: &'static str) -> Label {
        Label { es: name, en: name }
    }

    pub fn in_(self, locale: Locale) -> &'static str {
        locale.pick(self.es, self.en)
    }
}

struct Entry {
    /// How the principal knows it, in the chat's language.
    label: Label,
    /// A bundle id also blocks its helpers (`com.apple.Passwords` blocks
    /// `com.apple.Passwords.MenuBarExtra`).
    bundles: &'static [&'static str],
    names: &'static [&'static str],
}

/// `identifier` in `tauri.conf.json`.
const OWN_BUNDLE: &str = "dev.anomander.desktop";

const BLOCKED: &[Entry] = &[
    Entry {
        label: Label::same("ANOMANDER"),
        bundles: &[OWN_BUNDLE],
        names: &["ANOMANDER", "anomander-desktop"],
    },
    Entry {
        label: Label {
            es: "Ajustes del Sistema",
            en: "System Settings",
        },
        bundles: &["com.apple.systempreferences", "com.apple.Settings"],
        names: &["System Settings", "System Preferences"],
    },
    Entry {
        label: Label::same("SecurityAgent"),
        bundles: &["com.apple.SecurityAgent"],
        names: &["SecurityAgent"],
    },
    Entry {
        label: Label::same("loginwindow"),
        bundles: &["com.apple.loginwindow"],
        names: &["loginwindow"],
    },
    // Permission (TCC) requests, Touch ID and password sheets, "open this app?" prompts.
    Entry {
        label: Label::same("UserNotificationCenter"),
        bundles: &["com.apple.UserNotificationCenter"],
        names: &["UserNotificationCenter"],
    },
    Entry {
        label: Label::same("LocalAuthentication"),
        bundles: &["com.apple.LocalAuthentication.UIAgent"],
        names: &["LocalAuthenticationUIAgent"],
    },
    Entry {
        label: Label::same("CoreServicesUIAgent"),
        bundles: &["com.apple.CoreServicesUIAgent"],
        names: &["CoreServicesUIAgent"],
    },
    Entry {
        label: Label {
            es: "Acceso a Llaveros",
            en: "Keychain Access",
        },
        bundles: &["com.apple.keychainaccess"],
        names: &["Keychain Access"],
    },
    Entry {
        label: Label::same("1Password"),
        bundles: &["com.1password", "com.agilebits"],
        names: &["1Password", "1Password 7", "1Password 8"],
    },
    Entry {
        label: Label::same("Bitwarden"),
        bundles: &["com.bitwarden"],
        names: &["Bitwarden"],
    },
    Entry {
        label: Label::same("Dashlane"),
        bundles: &["com.dashlane"],
        names: &["Dashlane"],
    },
    Entry {
        label: Label::same("LastPass"),
        bundles: &["com.lastpass"],
        names: &["LastPass"],
    },
    Entry {
        label: Label {
            es: "Contraseñas",
            en: "Passwords",
        },
        bundles: &["com.apple.Passwords"],
        names: &["Passwords"],
    },
    Entry {
        label: Label::same("KeePassXC"),
        bundles: &["org.keepassxc"],
        names: &["KeePassXC"],
    },
    Entry {
        label: Label::same("Enpass"),
        bundles: &["in.sinew"],
        names: &["Enpass"],
    },
    Entry {
        label: Label::same("Proton Pass"),
        bundles: &["me.proton.pass"],
        names: &["Proton Pass"],
    },
    Entry {
        label: Label::same("NordPass"),
        bundles: &["com.nordsec.nordpass"],
        names: &["NordPass"],
    },
    Entry {
        label: Label::same("Keeper"),
        bundles: &["com.keepersecurity"],
        names: &["Keeper", "Keeper Password Manager"],
    },
];

/// Why `app` may not be targeted, or `None` when it may. `own_pid` catches ANOMANDER when it
/// runs unbundled (`tauri dev` has no bundle id).
pub fn blocked(app: &AppIdentity, own_pid: i32) -> Option<Label> {
    if app.pid == own_pid {
        return Some(BLOCKED[0].label);
    }
    let name = app.name.trim();
    BLOCKED
        .iter()
        .find(|entry| {
            let by_bundle = app.bundle_id.as_deref().is_some_and(|bundle| {
                entry
                    .bundles
                    .iter()
                    .any(|listed| bundle_matches(bundle, listed))
            });
            by_bundle
                || entry
                    .names
                    .iter()
                    .any(|listed| listed.eq_ignore_ascii_case(name))
        })
        .map(|entry| entry.label)
}

/// `bundle` is `listed` or one of its helpers (`listed.something`), in any case.
fn bundle_matches(bundle: &str, listed: &str) -> bool {
    let (bundle, listed) = (bundle.to_lowercase(), listed.to_lowercase());
    bundle == listed
        || bundle
            .strip_prefix(&listed)
            .is_some_and(|rest| rest.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locale::Locale;

    /// The Spanish name: the cases below read as the principal of a Spanish system does.
    fn blocked(app: &AppIdentity, own_pid: i32) -> Option<&'static str> {
        super::blocked(app, own_pid).map(|label| label.in_(Locale::Es))
    }

    const OWN_PID: i32 = 4242;

    fn app(bundle: Option<&str>, name: &str) -> AppIdentity {
        AppIdentity {
            pid: 100,
            bundle_id: bundle.map(str::to_string),
            name: name.into(),
        }
    }

    #[test]
    fn every_listed_bundle_is_blocked() {
        for (bundle, label) in [
            ("dev.anomander.desktop", "ANOMANDER"),
            ("com.apple.systempreferences", "Ajustes del Sistema"),
            ("com.apple.SecurityAgent", "SecurityAgent"),
            ("com.apple.loginwindow", "loginwindow"),
            ("com.apple.UserNotificationCenter", "UserNotificationCenter"),
            (
                "com.apple.LocalAuthentication.UIAgent",
                "LocalAuthentication",
            ),
            ("com.apple.CoreServicesUIAgent", "CoreServicesUIAgent"),
            ("com.apple.keychainaccess", "Acceso a Llaveros"),
            ("com.1password.1password", "1Password"),
            ("com.agilebits.onepassword7", "1Password"),
            ("com.bitwarden.desktop", "Bitwarden"),
            ("com.dashlane.dashlanephonefinal", "Dashlane"),
            ("com.lastpass.LastPass", "LastPass"),
            ("com.apple.Passwords", "Contraseñas"),
            ("org.keepassxc.keepassxc", "KeePassXC"),
            ("in.sinew.Enpass-Desktop", "Enpass"),
            ("me.proton.pass.electron", "Proton Pass"),
            ("com.nordsec.nordpass", "NordPass"),
            ("com.keepersecurity.passwordmanager", "Keeper"),
        ] {
            assert_eq!(
                blocked(&app(Some(bundle), "x"), OWN_PID),
                Some(label),
                "{bundle}"
            );
        }
    }

    #[test]
    fn the_names_macos_shows_follow_the_language_and_the_match_does_not() {
        for (bundle, name, es, en) in [
            (
                "com.apple.systempreferences",
                "System Settings",
                "Ajustes del Sistema",
                "System Settings",
            ),
            (
                "com.apple.keychainaccess",
                "Keychain Access",
                "Acceso a Llaveros",
                "Keychain Access",
            ),
            (
                "com.apple.Passwords",
                "Passwords",
                "Contraseñas",
                "Passwords",
            ),
            (
                "com.1password.1password",
                "1Password",
                "1Password",
                "1Password",
            ),
        ] {
            for app in [app(Some(bundle), "x"), app(None, name)] {
                let label = super::blocked(&app, OWN_PID);
                assert_eq!(
                    label.map(|label| label.in_(Locale::Es)),
                    Some(es),
                    "{app:?}"
                );
                assert_eq!(
                    label.map(|label| label.in_(Locale::En)),
                    Some(en),
                    "{app:?}"
                );
            }
        }
    }

    #[test]
    fn helpers_are_blocked_and_case_does_not_matter() {
        let helper = app(Some("com.apple.Passwords.MenuBarExtra"), "x");
        assert_eq!(blocked(&helper, OWN_PID), Some("Contraseñas"));
        let shouting = app(Some("COM.APPLE.KEYCHAINACCESS"), "x");
        assert_eq!(blocked(&shouting, OWN_PID), Some("Acceso a Llaveros"));
    }

    #[test]
    fn similar_bundles_and_ordinary_apps_are_allowed() {
        for bundle in [
            "com.apple.PasswordsX",
            "com.lastpassword.app",
            "com.apple.Safari",
            "com.google.Chrome",
        ] {
            assert_eq!(blocked(&app(Some(bundle), "x"), OWN_PID), None, "{bundle}");
        }
        assert_eq!(blocked(&app(None, "Some Tool"), OWN_PID), None);
    }

    #[test]
    fn anomander_is_blocked_by_its_own_pid() {
        let unbundled = AppIdentity {
            pid: OWN_PID,
            bundle_id: None,
            name: "anything".into(),
        };
        assert_eq!(blocked(&unbundled, OWN_PID), Some("ANOMANDER"));
    }

    #[test]
    fn an_app_without_a_bundle_id_is_known_by_its_name() {
        assert_eq!(
            blocked(&app(None, "SecurityAgent"), OWN_PID),
            Some("SecurityAgent")
        );
        assert_eq!(
            blocked(&app(None, "loginwindow"), OWN_PID),
            Some("loginwindow")
        );
        assert_eq!(
            blocked(&app(None, "keychain access"), OWN_PID),
            Some("Acceso a Llaveros")
        );
        // A bundle id that is not listed does not hide a listed name.
        assert_eq!(
            blocked(&app(Some("com.example.renamed"), "1Password"), OWN_PID),
            Some("1Password")
        );
    }
}
