//! Shared shape-preserving conversion of bounded JSON text to `serde_json::Value`.
//!
//! Object and array values are explicitly constructed so serde_json private
//! marker-shaped objects retain their ordinary JSON object shape. Callers own
//! input-size bounds and all later typed, schema, policy, and domain validation.

use serde::de::{DeserializeOwned, IgnoredAny};
use serde_json::{Deserializer, Number, Value};
use thiserror::Error;

const MAX_JSON_CONTAINER_DEPTH: usize = 127;

/// Content-free error returned when JSON text cannot be converted safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("invalid JSON text")]
pub struct JsonTextError;

/// Parse JSON text without interpreting serde_json's private marker-shaped
/// objects as scalar values.
///
/// serde_json frames each key and scalar token. This walker constructs
/// containers itself, validates every duplicate occurrence before insertion,
/// and applies the existing root-inclusive container depth budget.
pub fn parse_json_value(input: &str) -> Result<Value, JsonTextError> {
    parse_json_value_with_key_policy(input, false)
}

/// Parse shape-preserving JSON while rejecting duplicate decoded object keys
/// at every depth, including escaped spellings of the same key. Existing
/// `parse_json_value` callers retain last-key-wins semantics. Callers own the
/// input-size limit and subsequent schema/domain validation.
pub fn parse_unique_json_value(input: &str) -> Result<Value, JsonTextError> {
    parse_json_value_with_key_policy(input, true)
}

fn parse_json_value_with_key_policy(
    input: &str,
    reject_duplicate_keys: bool,
) -> Result<Value, JsonTextError> {
    let cursor = skip_whitespace(input, 0, input.len())?;
    if cursor == input.len() {
        return Err(JsonTextError);
    }

    let (value, end) = decode_value_at(input, cursor, 0, reject_duplicate_keys)?;
    if skip_whitespace(input, end, input.len())? == input.len() {
        Ok(value)
    } else {
        Err(JsonTextError)
    }
}

fn skip_whitespace(input: &str, mut cursor: usize, limit: usize) -> Result<usize, JsonTextError> {
    if cursor > limit || limit > input.len() || !input.is_char_boundary(cursor) {
        return Err(JsonTextError);
    }
    let bytes = input.as_bytes();
    while cursor < limit && matches!(bytes[cursor], b' ' | b'\n' | b'\r' | b'\t') {
        cursor += 1;
    }
    Ok(cursor)
}

fn stream_value<T: DeserializeOwned>(suffix: &str) -> Result<(T, usize), JsonTextError> {
    let mut stream = Deserializer::from_str(suffix).into_iter::<T>();
    let value = stream
        .next()
        .ok_or(JsonTextError)?
        .map_err(|_| JsonTextError)?;
    let offset = stream.byte_offset();
    if offset == 0 || offset > suffix.len() || !suffix.is_char_boundary(offset) {
        return Err(JsonTextError);
    }
    Ok((value, offset))
}

fn decode_value_at(
    input: &str,
    cursor: usize,
    parent_depth: usize,
    reject_duplicate_keys: bool,
) -> Result<(Value, usize), JsonTextError> {
    let start = skip_whitespace(input, cursor, input.len())?;
    let suffix = input.get(start..).ok_or(JsonTextError)?;
    let first = *input.as_bytes().get(start).ok_or(JsonTextError)?;
    match first {
        b'{' => {
            let depth = parent_depth.checked_add(1).ok_or(JsonTextError)?;
            if depth > MAX_JSON_CONTAINER_DEPTH {
                return Err(JsonTextError);
            }
            decode_object(input, start, depth, reject_duplicate_keys)
        }
        b'[' => {
            let depth = parent_depth.checked_add(1).ok_or(JsonTextError)?;
            if depth > MAX_JSON_CONTAINER_DEPTH {
                return Err(JsonTextError);
            }
            decode_array(input, start, depth, reject_duplicate_keys)
        }
        b'"' | b't' | b'f' | b'n' | b'-' | b'0'..=b'9' => {
            // Frame only this scalar token. Container subtrees are traversed
            // once by the punctuation walker, with depth checked before entry.
            let (_, relative_end) = stream_value::<IgnoredAny>(suffix)?;
            let end = start.checked_add(relative_end).ok_or(JsonTextError)?;
            if end > input.len() || input.get(start..end).is_none() {
                return Err(JsonTextError);
            }
            let token = input.get(start..end).ok_or(JsonTextError)?;
            let value = match first {
                b'"' => serde_json::from_str::<String>(token)
                    .map(Value::String)
                    .map_err(|_| JsonTextError)?,
                b't' | b'f' => serde_json::from_str::<bool>(token)
                    .map(Value::Bool)
                    .map_err(|_| JsonTextError)?,
                b'n' => serde_json::from_str::<()>(token)
                    .map(|()| Value::Null)
                    .map_err(|_| JsonTextError)?,
                b'-' | b'0'..=b'9' => serde_json::from_str::<Number>(token)
                    .map(Value::Number)
                    .map_err(|_| JsonTextError)?,
                _ => return Err(JsonTextError),
            };
            Ok((value, end))
        }
        _ => Err(JsonTextError),
    }
}

fn decode_object(
    input: &str,
    start: usize,
    depth: usize,
    reject_duplicate_keys: bool,
) -> Result<(Value, usize), JsonTextError> {
    if input.as_bytes().get(start) != Some(&b'{') {
        return Err(JsonTextError);
    }

    let mut values = serde_json::Map::new();
    let mut cursor = skip_whitespace(input, start + 1, input.len())?;
    if input.as_bytes().get(cursor) == Some(&b'}') {
        return Ok((Value::Object(values), cursor + 1));
    }

    loop {
        let key_start = skip_whitespace(input, cursor, input.len())?;
        let suffix = input.get(key_start..).ok_or(JsonTextError)?;
        let (key, key_len) = stream_value::<String>(suffix)?;
        let key_end = key_start.checked_add(key_len).ok_or(JsonTextError)?;
        if key_end > input.len() || input.get(key_start..key_end).is_none() {
            return Err(JsonTextError);
        }

        let colon = skip_whitespace(input, key_end, input.len())?;
        if input.as_bytes().get(colon) != Some(&b':') {
            return Err(JsonTextError);
        }
        let value_start = skip_whitespace(input, colon + 1, input.len())?;
        let (value, value_end) = decode_value_at(input, value_start, depth, reject_duplicate_keys)?;
        // Decode before insert so malformed values in overwritten duplicate
        // members still fail closed; Map insertion gives last-key-wins.
        if reject_duplicate_keys && values.contains_key(&key) {
            return Err(JsonTextError);
        }
        values.insert(key, value);

        cursor = skip_whitespace(input, value_end, input.len())?;
        match input.as_bytes().get(cursor) {
            Some(b'}') => return Ok((Value::Object(values), cursor + 1)),
            Some(b',') => {
                cursor = skip_whitespace(input, cursor + 1, input.len())?;
                if input.as_bytes().get(cursor) == Some(&b'}') {
                    return Err(JsonTextError);
                }
            }
            _ => return Err(JsonTextError),
        }
    }
}

fn decode_array(
    input: &str,
    start: usize,
    depth: usize,
    reject_duplicate_keys: bool,
) -> Result<(Value, usize), JsonTextError> {
    if input.as_bytes().get(start) != Some(&b'[') {
        return Err(JsonTextError);
    }

    let mut values = Vec::new();
    let mut cursor = skip_whitespace(input, start + 1, input.len())?;
    if input.as_bytes().get(cursor) == Some(&b']') {
        return Ok((Value::Array(values), cursor + 1));
    }

    loop {
        let value_start = skip_whitespace(input, cursor, input.len())?;
        let (value, value_end) = decode_value_at(input, value_start, depth, reject_duplicate_keys)?;
        values.push(value);

        cursor = skip_whitespace(input, value_end, input.len())?;
        match input.as_bytes().get(cursor) {
            Some(b']') => return Ok((Value::Array(values), cursor + 1)),
            Some(b',') => {
                cursor = skip_whitespace(input, cursor + 1, input.len())?;
                if input.as_bytes().get(cursor) == Some(&b']') {
                    return Err(JsonTextError);
                }
            }
            _ => return Err(JsonTextError),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::{parse_json_value, parse_unique_json_value};
    use serde_json::Value;

    #[test]
    fn strict_mode_rejects_duplicate_decoded_keys_at_every_depth() {
        for input in [
            r#"{"version":1,"version":2}"#,
            r#"{"version":2,"\u0076ersion":2}"#,
            r#"{"outer":{"id":"first","id":"last"}}"#,
            r#"{"outer":{"id":"first","\u0069d":"last"}}"#,
            r#"{"items":[{"id":"first","id":"last"}]}"#,
            r#"{"outer":{"id":"first"},"outer":{"id":"last"}}"#,
        ] {
            assert!(parse_unique_json_value(input).is_err(), "{input}");
            assert!(parse_json_value(input).is_ok(), "default remains last-wins");
        }
    }

    #[test]
    fn strict_mode_preserves_shapes_numbers_depth_and_valid_distinct_keys() {
        for input in [
            r#"{"id":"first","ID":"second","nested":{"id":"other"}}"#,
            r#"{"$serde_json::private::Number":"2"}"#,
            r#"{"marker":{"$serde_json::private::RawValue":"false"}}"#,
            r#"{"integer":2,"decimal":2.0,"exponent":2e0}"#,
            r#"[{},[],true,false,null,"\uD83D\uDE00"]"#,
        ] {
            assert_eq!(parse_unique_json_value(input), parse_json_value(input));
        }
        for input in ["", "{", "{} false", "[1,]", "{\"id\":\"\\uD800\"}"] {
            assert!(parse_unique_json_value(input).is_err());
        }
        let exact = format!("{}0{}", "[".repeat(127), "]".repeat(127));
        let over = format!("{}0{}", "[".repeat(128), "]".repeat(128));
        assert!(parse_unique_json_value(&exact).is_ok());
        assert!(parse_unique_json_value(&over).is_err());
    }

    #[test]
    fn raw_marker_objects_and_ordinary_token_text_keep_their_shapes() {
        for input in [
            r#"{"$serde_json::private::Number":"1","nested":{"$serde_json::private::RawValue":"false"}}"#,
            r#"{"\u0024serde_json::private::Number":"1","nested":{"\u0024serde_json::private::RawValue":"false"}}"#,
        ] {
            let parsed = parse_json_value(input).expect("parse raw object");
            let root = parsed.as_object().expect("root remains an object");
            assert_eq!(
                root.get("$serde_json::private::Number")
                    .and_then(Value::as_str),
                Some("1")
            );
            assert_eq!(
                root.get("nested")
                    .and_then(Value::as_object)
                    .and_then(|nested| nested.get("$serde_json::private::RawValue"))
                    .and_then(Value::as_str),
                Some("false")
            );
        }

        let text = parse_json_value(
            r#"{"token":"ordinary text containing $serde_json::private::RawValue"}"#,
        )
        .expect("parse ordinary token text");
        assert_eq!(
            text.get("token").and_then(Value::as_str),
            Some("ordinary text containing $serde_json::private::RawValue")
        );

        for (input, marker_key, marker_value) in [
            (
                r#"{"$serde_json::private::Number":"1"}"#,
                "$serde_json::private::Number",
                "1",
            ),
            (
                r#"{"\u0024serde_json::private::Number":"1"}"#,
                "$serde_json::private::Number",
                "1",
            ),
            (
                r#"{"$serde_json::private::RawValue":"not-json"}"#,
                "$serde_json::private::RawValue",
                "not-json",
            ),
            (
                r#"{"\u0024serde_json::private::RawValue":"not-json"}"#,
                "$serde_json::private::RawValue",
                "not-json",
            ),
        ] {
            let parsed = parse_json_value(input).expect("parse single-key marker object");
            let object = parsed.as_object().expect("marker remains an object");
            assert_eq!(object.len(), 1);
            assert_eq!(
                object.get(marker_key).and_then(Value::as_str),
                Some(marker_value)
            );
        }
    }

    #[test]
    fn duplicate_keys_are_last_wins_after_every_occurrence_is_decoded() {
        let parsed =
            parse_json_value(r#"{"outer":{"revision":1,"revision":2},"outer":{"revision":3}}"#)
                .expect("parse duplicate keys");
        assert_eq!(
            parsed
                .get("outer")
                .and_then(Value::as_object)
                .and_then(|outer| outer.get("revision"))
                .and_then(Value::as_u64),
            Some(3)
        );

        assert!(parse_json_value(r#"{"revision":"\uD800","revision":1}"#).is_err());
        assert!(parse_json_value(r#"{"revision":"\uDC00","revision":1}"#).is_err());
    }

    #[test]
    fn unicode_pair_and_numeric_spellings_keep_existing_value_semantics() {
        let paired = parse_json_value(r#"{"text":"\uD83D\uDE00"}"#).expect("valid surrogate pair");
        assert_eq!(paired.get("text").and_then(Value::as_str), Some("😀"));

        let integer = parse_json_value(r#"{"revision":1}"#).expect("parse integer spelling");
        assert_eq!(integer.get("revision").and_then(Value::as_u64), Some(1));
        assert_eq!(integer.get("revision").and_then(Value::as_f64), Some(1.0));

        for input in [r#"{"revision":1.0}"#, r#"{"revision":1e0}"#] {
            let parsed = parse_json_value(input).expect("parse decimal/exponent spelling");
            assert_eq!(parsed.get("revision").and_then(Value::as_u64), None);
            assert_eq!(parsed.get("revision").and_then(Value::as_f64), Some(1.0));
        }
    }

    #[test]
    fn existing_container_depth_budget_applies_to_overwritten_values() {
        let accepted = format!("{}0{}", "[".repeat(127), "]".repeat(127));
        assert!(parse_json_value(&accepted).is_ok());

        let rejected = format!("{}0{}", "[".repeat(128), "]".repeat(128));
        assert!(parse_json_value(&rejected).is_err());

        let overwritten_127 = format!("{}0{}", "[".repeat(126), "]".repeat(126));
        let duplicate_at_127 = format!("{{\"revision\":{overwritten_127},\"revision\":1}}");
        assert!(parse_json_value(&duplicate_at_127).is_ok());

        let overwritten_128 = format!("{}0{}", "[".repeat(127), "]".repeat(127));
        let duplicate_at_128 = format!("{{\"revision\":{overwritten_128},\"revision\":1}}");
        assert!(parse_json_value(&duplicate_at_128).is_err());
    }

    #[test]
    fn fresh_suffix_streams_frame_values_before_parent_delimiters() {
        let parsed = parse_json_value(
            r#" {"integer":1,"boolean":true,"null":null,"text":"é","nested":{"empty":{}},"items":[{},[]]} 
"#,
        )
        .expect("parse adjacent members and mixed empty containers");
        assert_eq!(parsed["integer"].as_u64(), Some(1));
        assert_eq!(parsed["boolean"].as_bool(), Some(true));
        assert!(parsed["null"].is_null());
        assert_eq!(parsed["text"].as_str(), Some("é"));
        assert_eq!(parsed["nested"]["empty"], Value::Object(Default::default()));
        assert_eq!(parsed["items"], serde_json::json!([{}, []]));

        for invalid in [
            "{}[]",
            "true false",
            "[]{}",
            r#"{"value":1}trailing"#,
            r#"{"value":1,}"#,
            "[1,]",
            r#"{"value" 1}"#,
            r#"{"value":1]"#,
        ] {
            assert!(parse_json_value(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn decoded_utf8_and_escaped_duplicate_keys_coalesce_last_wins() {
        let parsed = parse_json_value(r#"{"é":0,"\u00e9":1,"nested":{"word":"😀","empty":[]}}"#)
            .expect("parse UTF-8 and escaped keys");
        assert_eq!(parsed.as_object().expect("object").len(), 2);
        assert_eq!(parsed["é"].as_u64(), Some(1));
        assert_eq!(parsed["nested"]["word"].as_str(), Some("😀"));
        assert_eq!(parsed["nested"]["empty"], Value::Array(Vec::new()));
    }

    #[test]
    fn every_overwritten_key_and_string_is_decoded() {
        for invalid in [
            r#"{"\uD800":0,"valid":1}"#,
            r#"{"key":"\uD800","key":"valid"}"#,
            r#"{"outer":[{"text":"\uDC00"}],"outer":null}"#,
        ] {
            assert!(parse_json_value(invalid).is_err(), "accepted {invalid:?}");
        }

        let parsed = parse_json_value(r#"{"key":"old","key":"new"}"#)
            .expect("valid duplicate occurrences remain last-wins");
        assert_eq!(parsed["key"].as_str(), Some("new"));
    }

    #[test]
    fn conversion_errors_do_not_include_input_contents() {
        let error =
            parse_json_value(r#"{"private":"not valid""#).expect_err("reject incomplete object");
        assert_eq!(error.to_string(), "invalid JSON text");
        assert!(!format!("{error:?}").contains("private"));
    }
}
