// Which values of `mcp.json` the daemon's output hides.

/// The words a secret's name usually holds. Every value of `mcp.json` is kept as one, and the
/// code cannot tell which are: a value whose name has one of these words, or any header, is
/// hidden in the daemon's output from `SHORTEST_NAMED` characters; any other from
/// `SHORTEST_UNNAMED`, so a `DEBUG=1` does not blank that character wherever the daemon writes
/// it. A word, not a part of one: `PATH` and `API_VERSION` hold none.
const SECRET_WORDS: [&str; 23] = [
    "token",
    "tokens",
    "key",
    "keys",
    "apikey",
    "secret",
    "secrets",
    "password",
    "passwd",
    "pass",
    "pwd",
    "pw",
    "auth",
    "authorization",
    "credential",
    "credentials",
    "creds",
    "cookie",
    "session",
    "pat",
    "dsn",
    "bearer",
    "jwt",
];
const SHORTEST_NAMED: usize = 4;
const SHORTEST_UNNAMED: usize = 8;

/// Whether the value kept under `account` (`mcp/<server>/<env|headers>/<name>`) is hidden in the
/// daemon's output.
pub(super) fn hidden(account: &str, value: &str) -> bool {
    let mut parts = account.splitn(4, '/').skip(2);
    let field = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default().to_lowercase();
    let named = field == "headers"
        || name
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| SECRET_WORDS.contains(&word));
    let shortest = if named {
        SHORTEST_NAMED
    } else {
        SHORTEST_UNNAMED
    };
    value.chars().count() >= shortest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_of_a_connection_is_hidden_by_its_name_and_its_length() {
        for (account, value) in [
            ("mcp/s/env/API_KEY", "abcd"),
            ("mcp/s/env/GITHUB_TOKEN", "ñ-12"),
            ("mcp/s/env/db_password", "hunter2"),
            ("mcp/s/headers/X-Custom", "abcd"),
            ("mcp/s/env/GH_PAT", "ghp_1234"),
            // Under any name, once it is long enough to be one.
            ("mcp/s/env/ENDPOINT", "https://u:p@host/db"),
        ] {
            assert!(hidden(account, value), "{account}");
        }
        // A value this long is hidden under any name, as before names were looked at.
        for name in [
            "DB_PW",
            "SMTP_PW",
            "PIN",
            "JWT",
            "BEARER",
            "CREDS",
            "DATABASE_URL",
        ] {
            assert!(hidden(&format!("mcp/s/env/{name}"), "12345678"), "{name}");
        }
        for (account, value) in [
            ("mcp/s/env/API_KEY", "abc"),
            ("mcp/s/env/DEBUG", "1"),
            ("mcp/s/env/LANGUAGE", "ñññññññ"),
            // A hint is a whole word of the name: these hold one only inside another.
            ("mcp/s/env/API_VERSION", "2026"),
            ("mcp/s/env/PATH", "/bin"),
            ("mcp/s/env/AUTHOR", "erica"),
            ("mcp/s/env/KEYBOARD", "es-ES"),
        ] {
            assert!(!hidden(account, value), "{account}");
        }
    }
}
