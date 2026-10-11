//! Shape-preserving JSON decoding for generic Gateway response bodies.
//!
//! The caller owns response acquisition, status handling, deadlines, and any
//! body-size policy. This helper only validates UTF-8 and parses opaque JSON.

use aurora_voice_core::json_text::parse_json_value;
use serde_json::Value;

/// A content-free response JSON decoding failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ResponseJsonError;

/// Decode response bytes as strict UTF-8 and preserve marker-shaped JSON objects.
///
/// Both invalid UTF-8 and invalid JSON map to the same fixed error. The parsed
/// value is returned directly without a typed DTO conversion.
pub(super) fn parse_aurora_response(bytes: &[u8]) -> Result<Value, ResponseJsonError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ResponseJsonError)?;
    parse_json_value(text).map_err(|_| ResponseJsonError)
}

#[cfg(test)]
mod tests {
    use super::{parse_aurora_response, ResponseJsonError};
    use serde_json::{Map, Value};

    fn one_string_member(key: &str, value: &str) -> Value {
        let mut object = Map::new();
        object.insert(key.to_owned(), Value::String(value.to_owned()));
        Value::Object(object)
    }

    fn mixed_container_nesting(depth: usize) -> Vec<u8> {
        let mut input = String::new();
        for level in 0..depth {
            if level % 2 == 0 {
                input.push_str("{\"item\":");
            } else {
                input.push('[');
            }
        }
        input.push_str("null");
        for level in (0..depth).rev() {
            input.push(if level % 2 == 0 { '}' } else { ']' });
        }
        input.into_bytes()
    }

    #[test]
    fn literal_number_marker_object_keeps_object_shape() {
        let bytes = br#"{"$serde_json::private::Number":"7"}"#;
        let expected = one_string_member("$serde_json::private::Number", "7");
        assert_eq!(parse_aurora_response(bytes), Ok(expected));
    }

    #[test]
    fn escaped_number_marker_object_keeps_object_shape() {
        let bytes = br#"{"\u0024serde_json::private::Number":"7"}"#;
        let expected = one_string_member("$serde_json::private::Number", "7");
        assert_eq!(parse_aurora_response(bytes), Ok(expected));
    }

    #[test]
    fn literal_and_escaped_number_marker_objects_nested_in_arrays_keep_object_shape() {
        let nested = one_string_member("$serde_json::private::Number", "7");
        let mut parent = Map::new();
        parent.insert("nested".to_owned(), nested);
        let expected = Value::Array(vec![Value::Object(parent)]);
        for bytes in [
            br#"[{"nested":{"$serde_json::private::Number":"7"}}]"#.as_slice(),
            br#"[{"nested":{"\u0024serde_json::private::Number":"7"}}]"#.as_slice(),
        ] {
            assert_eq!(parse_aurora_response(bytes), Ok(expected.clone()));
        }
    }

    #[test]
    fn literal_raw_value_marker_object_keeps_object_shape() {
        let bytes = br#"{"$serde_json::private::RawValue":"{}"}"#;
        let expected = one_string_member("$serde_json::private::RawValue", "{}");
        assert_eq!(parse_aurora_response(bytes), Ok(expected));
    }

    #[test]
    fn escaped_raw_value_marker_object_keeps_object_shape() {
        let bytes = br#"{"\u0024serde_json::private::RawValue":"{}"}"#;
        let expected = one_string_member("$serde_json::private::RawValue", "{}");
        assert_eq!(parse_aurora_response(bytes), Ok(expected));
    }

    #[test]
    fn literal_and_escaped_raw_value_marker_objects_nested_in_arrays_keep_object_shape() {
        let nested = one_string_member("$serde_json::private::RawValue", "{}");
        let mut parent = Map::new();
        parent.insert("nested".to_owned(), nested);
        let expected = Value::Array(vec![Value::Object(parent)]);
        for bytes in [
            br#"[{"nested":{"$serde_json::private::RawValue":"{}"}}]"#.as_slice(),
            br#"[{"nested":{"\u0024serde_json::private::RawValue":"{}"}}]"#.as_slice(),
        ] {
            assert_eq!(parse_aurora_response(bytes), Ok(expected.clone()));
        }
    }

    #[test]
    fn ordinary_marker_looking_strings_and_json_root_shapes_are_preserved() {
        let ordinary =
            br#"{"text":"$serde_json::private::Number and $serde_json::private::RawValue"}"#;
        let mut expected_object = Map::new();
        expected_object.insert(
            "text".to_owned(),
            Value::String(
                "$serde_json::private::Number and $serde_json::private::RawValue".to_owned(),
            ),
        );
        assert_eq!(
            parse_aurora_response(ordinary),
            Ok(Value::Object(expected_object))
        );

        let controls = [
            (br#"{"ok":true}"#.as_slice(), {
                let mut object = Map::new();
                object.insert("ok".to_owned(), Value::Bool(true));
                Value::Object(object)
            }),
            (b"[1,{\"ok\":false}]".as_slice(), {
                let mut item = Map::new();
                item.insert("ok".to_owned(), Value::Bool(false));
                Value::Array(vec![Value::Number(1.into()), Value::Object(item)])
            }),
            (br#""text""#.as_slice(), Value::String("text".to_owned())),
            (b"1".as_slice(), Value::Number(1.into())),
            (b"true".as_slice(), Value::Bool(true)),
            (b"false".as_slice(), Value::Bool(false)),
            (b"null".as_slice(), Value::Null),
        ];
        for (input, expected) in controls {
            assert_eq!(parse_aurora_response(input), Ok(expected));
        }
    }

    #[test]
    fn duplicate_keys_are_last_wins_when_all_occurrences_are_valid() {
        assert_eq!(
            parse_aurora_response(br#"{"revision":1,"revision":2}"#),
            Ok({
                let mut object = Map::new();
                object.insert("revision".to_owned(), Value::Number(2.into()));
                Value::Object(object)
            })
        );
    }

    #[test]
    fn overwritten_invalid_unicode_is_rejected() {
        assert_eq!(
            parse_aurora_response(br#"{"text":"\uD800","text":"valid"}"#),
            Err(ResponseJsonError)
        );
    }

    #[test]
    fn root_inclusive_mixed_depth_127_accepts_and_128_rejects() {
        assert!(parse_aurora_response(&mixed_container_nesting(127)).is_ok());
        assert_eq!(
            parse_aurora_response(&mixed_container_nesting(128)),
            Err(ResponseJsonError)
        );
    }

    #[test]
    fn overwritten_overdepth_duplicate_is_rejected() {
        let nested =
            String::from_utf8(mixed_container_nesting(128)).expect("generated nesting is UTF-8");
        let bytes = format!("{{\"value\":{nested},\"value\":null}}");
        assert_eq!(
            parse_aurora_response(bytes.as_bytes()),
            Err(ResponseJsonError)
        );
    }

    #[test]
    fn malformed_bytes_and_trailing_tokens_return_one_content_free_error() {
        for input in [
            b"".as_slice(),
            b"{".as_slice(),
            br#"{"value":"\q"}"#.as_slice(),
            b"{} {}".as_slice(),
            b"\xff".as_slice(),
            b"\"/private/path/secret.bin \xff\"".as_slice(),
        ] {
            assert_eq!(parse_aurora_response(input), Err(ResponseJsonError));
        }
    }
}
