// What a notification of an answer says. macOS shows a few lines at most, so a long answer is cut
// at a word, never in the middle of a character.

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
    fn a_long_word_is_cut_between_characters() {
        let shown = body(&"ñ".repeat(400));
        assert_eq!(shown.chars().count(), LIMIT + 1);
    }
}
