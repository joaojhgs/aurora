//! Text checks shared by native runtime-profile boundaries.
//!
//! These mirror the UI's ECMAScript text rules. They do not resolve a secret
//! reference, select a profile, or grant access to a device.

use std::sync::LazyLock;

static WAKE_PHRASE: LazyLock<Option<regress::Regex>> =
    LazyLock::new(|| regress::Regex::with_flags(r"^[\p{L}\p{N}][\p{L}\p{N}' -]*$", "u").ok());
static BLOCKED_PHRASE: LazyLock<Option<regress::Regex>> = LazyLock::new(|| {
    regress::Regex::with_flags(r"(?:https?:|wss?:|token|secret|password|key=)", "iu").ok()
});
static SECRET_QUERY_KEY: LazyLock<Option<regress::Regex>> = LazyLock::new(|| {
    regress::Regex::with_flags(
        r"(?:token|secret|password|credential|authorization|bearer|key)",
        "iu",
    )
    .ok()
});

/// Whether a string is nonempty, within the UTF-8 byte limit, and unchanged by
/// ECMAScript `String.trim`. Interior characters are preserved.
pub fn is_canonical_profile_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim_matches(is_ecmascript_trim_character) == value
}

fn is_ecmascript_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'..='\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Check canonical wake-phrase text with the UI's Unicode letter/number
/// categories and Unicode case-insensitive exclusions. A pattern compilation
/// failure rejects the phrase. Asset catalog availability is checked elsewhere.
pub fn is_runtime_profile_wake_phrase_text(value: &str) -> bool {
    if !is_canonical_profile_text(value, 64) {
        return false;
    }
    let (Some(shape), Some(blocked)) = (WAKE_PHRASE.as_ref(), BLOCKED_PHRASE.as_ref()) else {
        return false;
    };
    shape
        .find(value)
        .is_some_and(|matched| matched.start() == 0 && matched.end() == value.len())
        && blocked.find(value).is_none()
}

/// Check an already form-decoded endpoint query key against the UI's Unicode
/// case-insensitive credential-name rule. A pattern compilation failure rejects
/// all query keys. This function neither parses nor logs endpoint values.
pub fn is_runtime_profile_secret_query_key(value: &str) -> bool {
    SECRET_QUERY_KEY
        .as_ref()
        .is_none_or(|pattern| pattern.find(value).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_ecmascript_patterns_compile() {
        assert!(WAKE_PHRASE.is_some());
        assert!(BLOCKED_PHRASE.is_some());
        assert!(SECRET_QUERY_KEY.is_some());
    }

    #[test]
    fn trim_matches_ecmascript_without_stripping_other_control_characters() {
        for character in [
            '\u{0009}', '\u{000a}', '\u{000b}', '\u{000c}', '\u{000d}', '\u{0020}', '\u{00a0}',
            '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
            '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}',
            '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            assert!(!is_canonical_profile_text(&format!("{character}name"), 160));
            assert!(!is_canonical_profile_text(&format!("name{character}"), 160));
            assert!(is_canonical_profile_text(&format!("na{character}me"), 160));
        }
        for character in ['\u{0085}', '\u{001c}', '\u{180e}', '\u{200b}'] {
            assert!(is_canonical_profile_text(
                &format!("{character}name{character}"),
                160
            ));
        }
        assert!(!is_canonical_profile_text("", 160));
        assert!(is_canonical_profile_text(&"é".repeat(48), 96));
        assert!(!is_canonical_profile_text(&"é".repeat(49), 96));
    }

    #[test]
    fn phrases_use_unicode_general_categories_and_exact_full_match() {
        for value in [
            "Hey Aurora",
            "Olá Aurora",
            "你好",
            "Ⅷ Aurora",
            "٢ Aurora",
            "𐐀 Aurora",
            "Aurora's-call",
        ] {
            assert!(is_runtime_profile_wake_phrase_text(value), "{value}");
        }
        for value in [
            "",
            " Hey Aurora",
            "Hey Aurora\n",
            "😀 Aurora",
            "\u{0345}Aurora",
            "A\u{0301}",
            "-Aurora",
            "https:hello",
            "Secret Aurora",
            "paſſword",
            "key=Aurora",
            "a\tAurora",
            "a\u{2028}Aurora",
        ] {
            assert!(!is_runtime_profile_wake_phrase_text(value), "{value}");
        }
        assert!(is_runtime_profile_wake_phrase_text(&"a".repeat(64)));
        assert!(!is_runtime_profile_wake_phrase_text(&"a".repeat(65)));
    }

    #[test]
    fn query_keys_apply_unicode_case_folding_and_substring_rules() {
        for value in [
            "token",
            "myToken",
            "PASSWORD",
            "paſſword",
            "Key",
            "credential",
            "authorization",
            "bearer",
            "secret",
            "monkeynessless",
        ] {
            assert!(is_runtime_profile_secret_query_key(value), "{value}");
        }
        for value in ["", "room", "language", "public"] {
            assert!(!is_runtime_profile_secret_query_key(value), "{value}");
        }
    }
}
