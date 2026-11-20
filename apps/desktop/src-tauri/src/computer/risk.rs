// T1b: whether an action is of care, judged on what the screen itself says (the Accessibility
// element under the point or with the focus), never on what the processor says is there. The
// approach is gentle-dot's `computer/risk.rs` (MIT); the words are the daemon's own, from
// `packages/protocol/src/careful-words.json`, so both read a control the same way.
use std::sync::LazyLock;

use icu_normalizer::DecomposingNormalizerBorrowed;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::CodePointMapData;
use serde::Deserialize;

/// What the Accessibility API reports about an element.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AxElement {
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
    /// The hint an empty field shows (`AXPlaceholderValue`).
    pub placeholder: Option<String>,
}

/// The focused element, and its window's default button, if any.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Focus {
    pub element: AxElement,
    pub is_default_button: bool,
    pub default_button: Option<AxElement>,
}

#[derive(Deserialize)]
struct Words {
    stems: Vec<String>,
    words: Vec<String>,
    #[cfg_attr(not(test), allow(dead_code))]
    examples: Examples,
}

#[derive(Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
struct Examples {
    careful: Vec<String>,
    routine: Vec<String>,
}

/// The daemon's list, embedded when the shell is built.
static WORDS: LazyLock<Words> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/src/careful-words.json"
    )))
    .expect("careful-words.json is valid")
});

/// What a search field is called, folded: there Return only searches and Space only types.
const SEARCH_FIELD: &[&str] = &["search", "buscar", "busqueda"];
/// What an address field is called, folded (and `url` as a whole word): there Return opens a page.
const ADDRESS_FIELD: &[&str] = &["direccion", "address"];
/// An address that is a mail one is a form's field, where Return submits.
const MAIL_FIELD: &[&str] = &["mail", "correo"];

/// Roles a click, Return or Space can press: buttons, boxes, menu items and links (web pages
/// often render buttons as links).
const PRESSABLE_ROLES: &[&str] = &[
    "AXButton",
    "AXMenuButton",
    "AXPopUpButton",
    "AXCheckBox",
    "AXRadioButton",
    "AXMenuItem",
    "AXMenuBarItem",
    "AXLink",
];
/// Fields text is typed into.
pub const TEXT_INPUT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox"];

/// `text` as the daemon's `foldCareful` reads it: in lower case, NFKD (a fullwidth letter or a
/// ligature reads as plain letters), without marks (accents) and without the characters that
/// show as nothing (zero-width, word joiner, soft hyphen).
fn folded(text: &str) -> String {
    let marks = CodePointMapData::<GeneralCategory>::new();
    DecomposingNormalizerBorrowed::new_nfkd()
        .normalize(&text.to_lowercase())
        .chars()
        .filter(|&c| {
            !GeneralCategoryGroup::Mark.contains(marks.get(c))
                && !matches!(
                    c,
                    '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}'
                )
        })
        .collect()
}

/// Whether `text` names a control of care: the daemon's `isCarefulText`.
pub fn is_careful_text(text: &str) -> bool {
    let plain = folded(text);
    WORDS.stems.iter().any(|stem| plain.contains(stem.as_str()))
        || plain
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .any(|word| WORDS.words.iter().any(|listed| listed == word))
}

impl AxElement {
    /// Its title, description and value, joined.
    pub fn label(&self) -> String {
        [&self.title, &self.description, &self.value]
            .into_iter()
            .flatten()
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn is_pressable(&self) -> bool {
        PRESSABLE_ROLES.contains(&self.role.as_str())
    }

    fn is_text_input(&self) -> bool {
        TEXT_INPUT_ROLES.contains(&self.role.as_str())
    }

    /// A field that clearly searches or takes an address: its subrole says so, or its title,
    /// description or hint (never what was typed in it).
    fn is_search_field(&self) -> bool {
        if !self.is_text_input() {
            return false;
        }
        if self.subrole.as_deref() == Some("AXSearchField") {
            return true;
        }
        let named = [&self.title, &self.description, &self.placeholder]
            .into_iter()
            .flatten()
            .map(|text| folded(text))
            .collect::<Vec<_>>()
            .join(" ");
        let address = ADDRESS_FIELD.iter().any(|word| named.contains(word))
            && !MAIL_FIELD.iter().any(|word| named.contains(word));
        SEARCH_FIELD.iter().any(|word| named.contains(word))
            || address
            || named
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|word| word == "url")
    }
}

/// A click on the element under the point (first) or its ancestors (after it): it presses the
/// nearest control, named by its own text or the text inside it. Nothing read is of care.
pub fn careful_click(chain: &[AxElement]) -> bool {
    if chain.is_empty() {
        return true;
    }
    let Some(pressable) = chain.iter().position(AxElement::is_pressable) else {
        return false;
    };
    let label = pressed_label(chain, pressable);
    label.is_empty() || is_careful_text(&label)
}

/// The text of the pressable element at `pressable` in `chain` and of the elements inside it.
fn pressed_label(chain: &[AxElement], pressable: usize) -> String {
    chain[..=pressable]
        .iter()
        .map(AxElement::label)
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Return (or Enter) with this focus. It presses the focused control or the window's default
/// button, sends a composer, submits a web form (which shows no default button), runs a
/// terminal's line: it is of care everywhere but in a search or address field of a window whose
/// default button is not one of care. A focus that is neither a field nor a control (an Electron
/// app's page reads as a group) is one that could not be read.
pub fn careful_return(focus: &Focus) -> bool {
    let default_of_care = focus.default_button.as_ref().is_some_and(|button| {
        let label = button.label();
        label.is_empty() || is_careful_text(&label)
    });
    focus.is_default_button || default_of_care || !focus.element.is_search_field()
}

/// Space with this focus: it presses a focused control; it is routine only where it clearly
/// types, in a search or address field.
pub fn careful_space(focus: &Focus) -> bool {
    focus.is_default_button || !focus.element.is_search_field()
}

/// Text typed with this focus: routine only into a field. On a control a space presses it, and
/// on anything else (a page that is not read, a web app) letters can be shortcuts.
pub fn careful_typing(focus: &Focus) -> bool {
    !focus.element.is_text_input()
}

/// What the screen shows at a click, for the principal: the control it presses, or else the
/// element under the point. `None` when nothing was read.
pub fn seen_at_click(chain: &[AxElement]) -> Option<Seen> {
    let first = chain.first()?;
    Some(match chain.iter().position(AxElement::is_pressable) {
        Some(pressable) => Seen::new(&chain[pressable].role, &pressed_label(chain, pressable)),
        None => Seen::new(&first.role, &first.label()),
    })
}

/// What a step on a step of care was judged on, as the chat shows it instead of what the
/// processor said is there: the element's role (`AXButton`) and its name, on one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub role: String,
    pub label: String,
}

/// The longest name passed to the chat, in characters.
const MAX_SEEN_CHARS: usize = 80;

impl Seen {
    pub fn new(role: &str, label: &str) -> Self {
        // Shown between quotes on one line: no control, format or quote character survives.
        let clean: String = label
            .chars()
            .map(|c| {
                if c.is_control() || c.is_whitespace() || matches!(c, '«' | '»') {
                    ' '
                } else {
                    c
                }
            })
            .filter(|&c| {
                !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{00AD}')
            })
            .collect();
        let words = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        Self {
            role: role.chars().filter(char::is_ascii_alphanumeric).collect(),
            label: words.chars().take(MAX_SEEN_CHARS).collect(),
        }
    }

    pub fn of(element: &AxElement) -> Self {
        Self::new(&element.role, &element.label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(role: &str, title: &str) -> AxElement {
        AxElement {
            role: role.into(),
            title: Some(title.into()),
            ..AxElement::default()
        }
    }

    fn focus(element: AxElement) -> Focus {
        Focus {
            element,
            ..Focus::default()
        }
    }

    #[test]
    fn the_daemon_examples_read_the_same_here() {
        for text in &WORDS.examples.careful {
            assert!(is_careful_text(text), "{text}");
        }
        for text in &WORDS.examples.routine {
            assert!(!is_careful_text(text), "{text}");
        }
    }

    #[test]
    fn words_compare_without_accents_or_case_and_short_ones_whole() {
        assert!(is_careful_text("CONTRASEÑA"));
        assert!(is_careful_text("sí"));
        assert!(is_careful_text("ok."));
        assert!(!is_careful_text("Bookmarks"));
        assert!(!is_careful_text("Design"));
    }

    #[test]
    fn clicking_a_control_of_care_is_careful_whatever_the_processor_said() {
        assert!(careful_click(&[element("AXButton", "Enviar")]));
        assert!(careful_click(&[element("AXMenuItem", "Delete Message")]));
        let described = AxElement {
            role: "AXButton".into(),
            description: Some("Comprar".into()),
            ..AxElement::default()
        };
        assert!(careful_click(&[described]));
        assert!(careful_click(&[element(
            "AXCheckBox",
            "Acepto los términos"
        )]));
    }

    #[test]
    fn text_inside_a_button_of_care_counts() {
        let label = AxElement {
            role: "AXStaticText".into(),
            value: Some("Pagar ahora".into()),
            ..AxElement::default()
        };
        let chain = [
            label,
            AxElement {
                role: "AXButton".into(),
                ..AxElement::default()
            },
        ];
        assert!(careful_click(&chain));
    }

    #[test]
    fn a_button_that_says_nothing_or_an_unread_point_is_careful() {
        assert!(careful_click(&[]));
        assert!(careful_click(&[AxElement {
            role: "AXButton".into(),
            ..AxElement::default()
        }]));
    }

    #[test]
    fn routine_clicks_are_routine() {
        assert!(!careful_click(&[element("AXButton", "Abrir")]));
        assert!(!careful_click(&[element(
            "AXTextField",
            "Barra de direcciones"
        )]));
        // A word of care outside anything pressable is not a press.
        assert!(!careful_click(&[element("AXStaticText", "Enviar")]));
        assert!(!careful_click(&[
            element("AXStaticText", "Enviar"),
            element("AXGroup", ""),
            element("AXWindow", "Correo"),
        ]));
    }

    fn search(title: &str) -> AxElement {
        element("AXTextField", title)
    }

    #[test]
    fn return_and_space_are_routine_only_in_a_search_or_address_field() {
        let searches = [
            AxElement {
                role: "AXTextField".into(),
                subrole: Some("AXSearchField".into()),
                ..AxElement::default()
            },
            search("Buscar"),
            search("Búsqueda"),
            search("Buscar correo"),
            AxElement {
                role: "AXTextField".into(),
                description: Some("Address and search bar".into()),
                ..AxElement::default()
            },
            AxElement {
                role: "AXComboBox".into(),
                placeholder: Some("Introduce la dirección o la URL".into()),
                ..AxElement::default()
            },
            search("URL"),
        ];
        for field in searches {
            assert!(!careful_return(&focus(field.clone())), "{field:?}");
            assert!(!careful_space(&focus(field.clone())), "{field:?}");
        }
    }

    #[test]
    fn return_and_space_are_careful_everywhere_else() {
        let composer = AxElement {
            role: "AXTextArea".into(),
            description: Some("Message #general".into()),
            ..AxElement::default()
        };
        for element in [
            // A web form's field: the page shows no default button, and Return submits it.
            element("AXTextField", "Importe"),
            // A terminal: Return runs the line.
            AxElement {
                role: "AXTextArea".into(),
                ..AxElement::default()
            },
            composer,
            // A mail address is a form's, not an address bar.
            element("AXTextField", "Email address"),
            element("AXTextField", "Dirección de correo"),
            // A typed "url" is not what the field is called.
            AxElement {
                role: "AXTextField".into(),
                value: Some("buscar url".into()),
                ..AxElement::default()
            },
            element("AXButton", "Abrir"),
            element("AXLink", "Tiempo en Madrid"),
            // An Electron app's page without its accessibility reads as a group.
            element("AXGroup", ""),
            element("AXWebArea", "Slack"),
        ] {
            assert!(careful_return(&focus(element.clone())), "{element:?}");
            assert!(careful_space(&focus(element.clone())), "{element:?}");
        }
    }

    #[test]
    fn a_default_button_makes_return_careful_even_in_a_search_field() {
        let pressed = Focus {
            element: search("Buscar"),
            is_default_button: true,
            default_button: None,
        };
        assert!(careful_return(&pressed));
        let of_care = Focus {
            element: search("Buscar"),
            is_default_button: false,
            default_button: Some(element("AXButton", "Pagar")),
        };
        assert!(careful_return(&of_care));
        let routine = Focus {
            element: search("Buscar"),
            is_default_button: false,
            default_button: Some(element("AXButton", "Hecho")),
        };
        assert!(!careful_return(&routine));
    }

    #[test]
    fn typing_is_routine_only_into_a_field() {
        assert!(!careful_typing(&focus(element("AXTextField", "Importe"))));
        assert!(!careful_typing(&focus(element("AXTextArea", ""))));
        assert!(careful_typing(&focus(element("AXButton", "Abrir"))));
        assert!(careful_typing(&focus(element("AXGroup", ""))));
        assert!(careful_typing(&focus(element("AXWebArea", "Discord"))));
    }

    #[test]
    fn what_was_seen_is_the_pressed_control_on_one_clean_line() {
        let chain = [
            AxElement {
                role: "AXStaticText".into(),
                value: Some("Pagar\n«ahora»\u{202E}".into()),
                ..AxElement::default()
            },
            AxElement {
                role: "AXButton".into(),
                ..AxElement::default()
            },
        ];
        assert_eq!(
            seen_at_click(&chain),
            Some(Seen {
                role: "AXButton".into(),
                label: "Pagar ahora".into()
            })
        );
        assert_eq!(
            seen_at_click(&[element("AXStaticText", "Hola")]),
            Some(Seen::new("AXStaticText", "Hola"))
        );
        assert_eq!(seen_at_click(&[]), None);
        let long = Seen::new("AXButton", &"a".repeat(500));
        assert_eq!(long.label.chars().count(), 80);
    }
}
