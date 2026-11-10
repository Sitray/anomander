// What the shell reads from the daemon's output: the line that says the local channel listens
// (DK-3), and the last error line, which the window shows without any secret (DK-1 AC2).

/// The line `main.ts` logs once the local channel listens; it carries the address, never the token.
const LISTENING: &str = "anomander local channel listening on 127.0.0.1:";

/// How much of an error line the window gets; the full line stays in the daemon's own log.
pub const MAX_ERROR_CHARS: usize = 300;

pub const REDACTED: &str = "[secret]";

/// The port of `anomander local channel listening on 127.0.0.1:<port>`, or `None` for any other line.
pub fn listening_port(line: &str) -> Option<u16> {
    let port = line.trim_end().strip_prefix(LISTENING)?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok().filter(|port| *port != 0)
}

/// `line` with every non-empty secret replaced by `[secret]`, then cut to `MAX_ERROR_CHARS`.
/// Redacting first means a cut can never leave part of a secret behind.
pub fn redact(line: &str, secrets: &[&str]) -> String {
    let mut redacted = scrub(line.trim(), secrets);
    match redacted.char_indices().nth(MAX_ERROR_CHARS) {
        Some((cut, _)) => {
            redacted.truncate(cut);
            redacted.push('…');
            redacted
        }
        None => redacted,
    }
}

/// `line` with every non-empty secret replaced by `[secret]`, whole: for forwarding the daemon's
/// log to the app's own, where no secret may appear either (DK-5 AC2).
pub fn scrub(line: &str, secrets: &[&str]) -> String {
    let mut secrets: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    // The longest first, so a secret that contains another is replaced whole.
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    let mut scrubbed = line.to_owned();
    for secret in secrets {
        scrubbed = scrubbed.replace(secret, REDACTED);
    }
    scrubbed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listening_line_gives_its_port() {
        assert_eq!(
            listening_port("anomander local channel listening on 127.0.0.1:4312"),
            Some(4312)
        );
        assert_eq!(
            listening_port("anomander local channel listening on 127.0.0.1:50123\r"),
            Some(50123)
        );
    }

    #[test]
    fn any_other_line_gives_no_port() {
        for line in [
            "",
            "anomander daemon starting",
            "anomander read API listening on 127.0.0.1:4311",
            "anomander local channel listening on 0.0.0.0:4312",
            "anomander local channel listening on 127.0.0.1:",
            "anomander local channel listening on 127.0.0.1:99999",
            "anomander local channel listening on 127.0.0.1:12ab",
            "say anomander local channel listening on 127.0.0.1:4312",
        ] {
            assert_eq!(listening_port(line), None, "{line}");
        }
    }

    #[test]
    fn every_secret_is_replaced() {
        let line = "anomander daemon failed: 401 for bot123:ABC with key sk-xyz and sk-xyz";
        assert_eq!(
            redact(line, &["bot123:ABC", "sk-xyz"]),
            "anomander daemon failed: 401 for [secret] with key [secret] and [secret]"
        );
    }

    #[test]
    fn a_longer_secret_containing_a_shorter_one_is_replaced_whole() {
        assert_eq!(redact("key=abcdef", &["abc", "abcdef"]), "key=[secret]");
    }

    #[test]
    fn empty_secrets_are_ignored() {
        assert_eq!(redact("nothing here", &["", "x-absent"]), "nothing here");
    }

    #[test]
    fn a_long_line_is_cut_after_redaction() {
        let secret = "z".repeat(10);
        let line = format!("{}{secret}", "a".repeat(MAX_ERROR_CHARS - 2));
        let redacted = redact(&line, &[&secret]);
        // Cut before redaction, a prefix of the secret would remain.
        assert!(!redacted.contains('z'));
        assert!(redacted.contains("[s"));
        assert_eq!(redacted.chars().count(), MAX_ERROR_CHARS + 1);
        assert!(redacted.ends_with('…'));
    }

    #[test]
    fn a_cut_respects_multibyte_characters() {
        let line = "€".repeat(MAX_ERROR_CHARS + 5);
        let redacted = redact(&line, &[]);
        assert_eq!(redacted.chars().count(), MAX_ERROR_CHARS + 1);
    }

    #[test]
    fn scrubbing_replaces_secrets_without_cutting() {
        let line = format!("{} tok", "a".repeat(MAX_ERROR_CHARS * 2));
        let scrubbed = scrub(&line, &["tok"]);
        assert!(scrubbed.ends_with(" [secret]"));
        assert_eq!(scrubbed.len(), MAX_ERROR_CHARS * 2 + " [secret]".len());
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(redact("  boom \n", &[]), "boom");
    }
}
