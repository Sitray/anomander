// What a notification of an answer says. macOS shows a few lines at most, so a long answer is cut
// at a word, never in the middle of a character. DK-22 (B29): with "Solo avisar" it says only
// that there is something, so nothing of the message reaches a locked screen.
use crate::locale::Locale;
use crate::snapshot::NotificationMode;

/// The longest body, in characters.
const LIMIT: usize = 180;

pub fn body(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= LIMIT {
        return flat;
    }
    let cut: String = flat.chars().take(LIMIT).collect();
    let kept = match cut.rfind(' ') {
        Some(space) => &cut[..space],
        None => cut.as_str(),
    };
    format!("{kept}…")
}

/// The body of every notification the shell shows, as the principal chose (DK-22).
pub fn shown(mode: NotificationMode, text: &str, locale: Locale) -> String {
    match mode {
        NotificationMode::Content => body(text),
        NotificationMode::NoticeOnly => locale
            .pick(
                "ANOMANDER tiene algo para ti",
                "ANOMANDER has something for you",
            )
            .to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_answer_is_shown_whole_on_one_line() {
        assert_eq!(
            body("Apuntado: 23,00 € en cena.\n\n¿Algo más?"),
            "Apuntado: 23,00 € en cena. ¿Algo más?"
        );
    }

    #[test]
    fn a_long_answer_is_cut_at_a_word() {
        let long = "número ".repeat(60);
        let shown = body(&long);
        assert!(shown.ends_with("número…"), "{shown}");
        assert!(shown.chars().count() <= LIMIT + 1);
    }

    #[test]
    fn notify_only_says_there_is_something_and_no_word_of_the_message() {
        let text = "Apuntado: 23,00 € en cena. Recuerda que eres vegetariano.";
        assert_eq!(
            shown(NotificationMode::NoticeOnly, text, Locale::Es),
            "ANOMANDER tiene algo para ti"
        );
        assert_eq!(
            shown(NotificationMode::NoticeOnly, text, Locale::En),
            "ANOMANDER has something for you"
        );
    }

    #[test]
    fn showing_the_content_is_the_body_as_before() {
        let text = "Apuntado: 23,00 € en cena.\n\n¿Algo más?";
        assert_eq!(
            shown(NotificationMode::Content, text, Locale::Es),
            body(text)
        );
        assert_eq!(NotificationMode::default(), NotificationMode::Content);
    }

    #[test]
    fn a_long_word_is_cut_between_characters() {
        let shown = body(&"ñ".repeat(400));
        assert_eq!(shown.chars().count(), LIMIT + 1);
    }
}
