use aurora_voice_engine::{
    SpeechCatalogError, SpeechModelCatalog, TtsCatalogError, TtsVoiceCatalog,
};

const SPEECH_CATALOG: &str = include_str!("../resources/sherpa_onnx_speech_catalog.json");
const TTS_CATALOG: &str = include_str!("../resources/sherpa_onnx_tts_catalog.json");
const SCHEMA_VERSION: &str = "\"schema_version\": 1,";
const SPEECH_MAX_BYTES: usize = 250_000;
const TTS_MAX_BYTES: usize = 1_500_000;

fn with_schema_version(source: &str, raw_json_value: &str) -> String {
    assert_eq!(source.matches(SCHEMA_VERSION).count(), 1);
    source.replacen(
        SCHEMA_VERSION,
        &format!("\"schema_version\": {raw_json_value},"),
        1,
    )
}

fn with_duplicate_schema_version(source: &str, first_json_value: &str) -> String {
    assert_eq!(source.matches(SCHEMA_VERSION).count(), 1);
    source.replacen(
        SCHEMA_VERSION,
        &format!("\"schema_version\": {first_json_value}, \"schema_version\": 1,"),
        1,
    )
}

fn wrapped_raw_value(payload: &str, escaped_key: bool) -> String {
    let payload = serde_json::to_string(payload).expect("encode catalog as JSON text");
    let key = if escaped_key {
        r#"\u0024serde_json::private::RawValue"#
    } else {
        "$serde_json::private::RawValue"
    };
    format!(r#"{{"{key}":{payload}}}"#)
}

fn wrapped_number_marker(escaped_key: bool) -> &'static str {
    if escaped_key {
        r#"{"\u0024serde_json::private::Number":"1"}"#
    } else {
        r#"{"$serde_json::private::Number":"1"}"#
    }
}

#[test]
fn compiled_catalogs_keep_their_pins_and_runtime_overlay() {
    let speech = SpeechModelCatalog::from_json(SPEECH_CATALOG).expect("parse pinned speech JSON");
    let embedded_speech = SpeechModelCatalog::embedded().expect("embedded speech catalog");
    assert_eq!(speech, *embedded_speech);
    assert_eq!(speech.entries.len(), 19);
    assert_eq!(
        speech.entries_sha256,
        "e2a3f8790a67d0042611ba3e4ee4f7490571fba01364b92179e847fa04cd9f4e"
    );

    let tts = TtsVoiceCatalog::from_json(TTS_CATALOG).expect("parse pinned TTS JSON");
    let embedded_tts = TtsVoiceCatalog::embedded().expect("embedded TTS catalog");
    let runtime_tts = TtsVoiceCatalog::runtime().expect("runtime TTS catalog");
    assert_eq!(tts, *embedded_tts);
    assert_eq!(tts.entries.len(), 537);
    assert_eq!(
        tts.entries_sha256,
        "64ed347bb69deb695ea50d363bdcad99779a2ffa0ecfea790af368056504e4fa"
    );
    assert_eq!(runtime_tts.entries.len(), 539);
    assert_eq!(runtime_tts.entries_sha256, tts.entries_sha256);
}

#[test]
fn catalog_schema_version_accepts_integer_tokens_only() {
    for (name, raw_value) in [
        ("decimal_integral", "1.0"),
        ("exponent_integral", "1e0"),
        ("literal_number_object", wrapped_number_marker(false)),
        ("escaped_number_object", wrapped_number_marker(true)),
        ("ordinary_marker_text", r#""$serde_json::private::Number""#),
    ] {
        let speech = with_schema_version(SPEECH_CATALOG, raw_value);
        assert_eq!(
            SpeechModelCatalog::from_json(&speech),
            Err(SpeechCatalogError::Invalid),
            "speech schema_version case {name}"
        );
        let tts = with_schema_version(TTS_CATALOG, raw_value);
        assert_eq!(
            TtsVoiceCatalog::from_json(&tts),
            Err(TtsCatalogError::Invalid),
            "TTS schema_version case {name}"
        );
    }

    assert!(SpeechModelCatalog::from_json(&with_schema_version(SPEECH_CATALOG, "1")).is_ok());
    assert!(TtsVoiceCatalog::from_json(&with_schema_version(TTS_CATALOG, "1")).is_ok());
}

#[test]
fn raw_value_wrapped_catalogs_are_rejected_for_both_key_spellings() {
    for escaped_key in [false, true] {
        let speech = wrapped_raw_value(SPEECH_CATALOG, escaped_key);
        assert_eq!(
            SpeechModelCatalog::from_json(&speech),
            Err(SpeechCatalogError::Invalid),
            "speech wrapper escaped={escaped_key}"
        );
        let tts = wrapped_raw_value(TTS_CATALOG, escaped_key);
        assert_eq!(
            TtsVoiceCatalog::from_json(&tts),
            Err(TtsCatalogError::Invalid),
            "TTS wrapper escaped={escaped_key}"
        );
    }
}

#[test]
fn valid_last_duplicate_schema_version_wins_but_each_occurrence_is_parsed() {
    let accepted_speech = with_duplicate_schema_version(SPEECH_CATALOG, r#"{"discarded":true}"#);
    let speech = SpeechModelCatalog::from_json(&accepted_speech)
        .expect("later valid speech schema_version wins");
    assert_eq!(speech.schema_version, 1);
    assert_eq!(speech.entries.len(), 19);

    let accepted_tts = with_duplicate_schema_version(TTS_CATALOG, r#"{"discarded":true}"#);
    let tts = TtsVoiceCatalog::from_json(&accepted_tts).expect("later valid schema_version wins");
    assert_eq!(tts.schema_version, 1);
    assert_eq!(tts.entries.len(), 537);

    let overwritten_lone_surrogate = SPEECH_CATALOG.replacen(
        SCHEMA_VERSION,
        r#""schema_version":"\uD800", "schema_version":1,"#,
        1,
    );
    assert_eq!(
        SpeechModelCatalog::from_json(&overwritten_lone_surrogate),
        Err(SpeechCatalogError::Invalid)
    );
}

#[test]
fn overwritten_values_obey_the_existing_json_container_depth_limit() {
    for (total_container_depth, nested_array_depth) in [(127, 126), (128, 127)] {
        let mut earlier = "0".to_owned();
        for _ in 0..nested_array_depth {
            earlier = format!("[{earlier}]");
        }
        let speech = with_duplicate_schema_version(SPEECH_CATALOG, &earlier);
        let tts = with_duplicate_schema_version(TTS_CATALOG, &earlier);
        if total_container_depth == 127 {
            let speech = SpeechModelCatalog::from_json(&speech).expect("depth 127 is accepted");
            assert_eq!(speech.schema_version, 1);
            assert_eq!(speech.entries.len(), 19);
            let tts = TtsVoiceCatalog::from_json(&tts).expect("depth 127 is accepted");
            assert_eq!(tts.schema_version, 1);
            assert_eq!(tts.entries.len(), 537);
        } else {
            assert_eq!(
                SpeechModelCatalog::from_json(&speech),
                Err(SpeechCatalogError::Invalid)
            );
            assert_eq!(
                TtsVoiceCatalog::from_json(&tts),
                Err(TtsCatalogError::Invalid)
            );
        }
    }
}

#[test]
fn catalog_size_and_pin_failures_keep_distinct_public_errors() {
    let too_large_speech = format!(
        "{}{}",
        SPEECH_CATALOG,
        " ".repeat(SPEECH_MAX_BYTES + 1 - SPEECH_CATALOG.len())
    );
    assert_eq!(
        SpeechModelCatalog::from_json(&too_large_speech),
        Err(SpeechCatalogError::ResourceLimit)
    );

    let too_large_tts = format!(
        "{}{}",
        TTS_CATALOG,
        " ".repeat(TTS_MAX_BYTES + 1 - TTS_CATALOG.len())
    );
    assert_eq!(
        TtsVoiceCatalog::from_json(&too_large_tts),
        Err(TtsCatalogError::ResourceLimit)
    );

    assert_eq!(
        SpeechModelCatalog::from_json("{not-json"),
        Err(SpeechCatalogError::Invalid)
    );
    assert_eq!(
        TtsVoiceCatalog::from_json("{not-json"),
        Err(TtsCatalogError::Invalid)
    );

    let tampered_tts = TTS_CATALOG.replacen(
        "standard:piper:en_us-ljspeech-medium",
        "standard:piper:en_us-ljspeech-meddium",
        1,
    );
    assert_ne!(tampered_tts, TTS_CATALOG);
    assert_eq!(
        TtsVoiceCatalog::from_json(&tampered_tts),
        Err(TtsCatalogError::Trust)
    );
}
