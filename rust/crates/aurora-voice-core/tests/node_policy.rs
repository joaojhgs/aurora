use aurora_voice_core::node_policy::{
    empty_node_config_document_v1, empty_node_config_document_v2, migrate_node_config_document_v1,
    migrate_node_config_document_v2, update_node_config_document_v2,
    validate_node_config_document_v1_json, validate_node_config_document_v1_value,
    validate_node_config_document_v2_json, validate_node_config_document_v2_value,
    NodeConfigModule, NodePolicyError, NullableField, Omitted, RoutingFallback, RoutingPreference,
    SpeechNetworkKind, MAX_FEATURE_OVERRIDES, MAX_SAFE_INTEGER,
};
use serde_json::{json, Value};

fn empty_v2_value() -> Value {
    serde_json::to_value(empty_node_config_document_v2(100).expect("valid timestamp"))
        .expect("serializable defaults")
}

#[test]
fn background_transcription_migrates_off_and_preserves_revisioned_preferences() {
    let mut old = empty_v2_value();
    old.as_object_mut()
        .unwrap()
        .remove("backgroundTranscription");
    let migrated = validate_node_config_document_v2_value(old).unwrap();
    assert!(!migrated.background_transcription.enabled);
    assert!(!migrated.background_transcription.ambient);
    assert!(!migrated.background_transcription.notification);
    assert_eq!(migrated.background_transcription.retention_days, 30);
    assert_eq!(migrated.revision, 1);
    let mut draft = serde_json::to_value(&migrated).unwrap();
    draft["backgroundTranscription"]["enabled"] = json!(true);
    draft["backgroundTranscription"]["ambient"] = json!(true);
    draft["backgroundTranscription"]["retentionDays"] = json!(14);
    draft["revision"] = json!(2);
    let saved = update_node_config_document_v2(&migrated, draft.clone(), 1, 200).unwrap();
    assert!(saved.background_transcription.ambient);
    assert_eq!(saved.background_transcription.retention_days, 14);
    assert!(update_node_config_document_v2(&saved, draft, 1, 300).is_err());
}

#[test]
fn background_transcription_rejects_invalid_retention_and_runtime_facts() {
    for patch in [
        json!({"retentionDays": 0}),
        json!({"retentionDays": 1.5}),
        json!({"enabled": "true"}),
        json!({"recording": true}),
        json!({"language": "x".repeat(65)}),
    ] {
        let mut value = empty_v2_value();
        value["backgroundTranscription"]
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(validate_node_config_document_v2_value(value).is_err());
    }
}

fn cross_language_vectors() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/node_policy_cross_language_vectors.json"
    ))
    .expect("cross-language vectors are valid JSON")
}

fn set_path(value: &mut Value, path: &[Value], replacement: Value) {
    let keys: Vec<&str> = path
        .iter()
        .map(|key| key.as_str().expect("fixture path segment is a string"))
        .collect();
    let (leaf, parents) = keys.split_last().expect("fixture path is non-empty");
    let mut target = value;
    for key in parents {
        target = target.get_mut(*key).expect("fixture parent exists");
    }
    target
        .as_object_mut()
        .expect("fixture leaf parent is an object")
        .insert((*leaf).to_owned(), replacement);
}

fn apply_patches(base: &Value, patches: &Value) -> Value {
    let mut result = base.clone();
    for patch in patches.as_array().expect("fixture patches are an array") {
        set_path(
            &mut result,
            patch["path"].as_array().expect("patch path is an array"),
            patch["value"].clone(),
        );
    }
    result
}

fn remove_path(value: &mut Value, path: &[Value]) {
    let keys: Vec<&str> = path
        .iter()
        .map(|key| key.as_str().expect("fixture path segment is a string"))
        .collect();
    let (leaf, parents) = keys.split_last().expect("fixture path is non-empty");
    let mut target = value;
    for key in parents {
        target = target.get_mut(*key).expect("fixture parent exists");
    }
    target
        .as_object_mut()
        .expect("fixture leaf parent is an object")
        .remove(*leaf)
        .expect("fixture leaf exists");
}

fn object_mut<'a>(value: &'a mut Value, path: &[&str]) -> &'a mut serde_json::Map<String, Value> {
    let mut current = value;
    for key in path {
        current = current.get_mut(*key).expect("fixture path exists");
    }
    current.as_object_mut().expect("path is an object")
}

#[test]
fn empty_documents_have_sdk_defaults_and_required_v2_stages() {
    let v1 = empty_node_config_document_v1(100).expect("default timestamp is safe");
    assert_eq!(v1.version, 1);
    assert_eq!(v1.services.len(), 5);
    assert_eq!(
        v1.services[&NodeConfigModule::Tooling].routing.prefer,
        RoutingPreference::Local
    );

    let v2 = empty_node_config_document_v2(100).expect("default timestamp is safe");
    assert_eq!(v2.version, 2);
    assert_eq!(v2.revision, 1);
    assert_eq!(v2.speech.version, 1);
    assert!(!v2.speech.sharing.stt);
    assert!(!v2.speech.sharing.tts);
    assert!(!v2.speech.sharing.kws);
    assert!(!v2.speech.sharing.vad);
    assert_eq!(v2.speech.limits.max_attempts, 2);
    assert_eq!(v2.speech.limits.admission_timeout_ms, 5_000);
    assert_eq!(v2.speech.limits.finite_deadline_ms, 60_000);
    assert_eq!(
        v2.speech.stages.kws.routing.prefer,
        RoutingPreference::LocalOnly
    );
    assert_eq!(
        v2.speech.stages.kws.routing.fallback,
        RoutingFallback::Error
    );
    assert!(v2.legacy_v1_snapshot.is_none());

    let golden: Value = serde_json::from_str(include_str!("fixtures/node_policy_v2_default.json"))
        .expect("golden vector is valid JSON");
    assert_eq!(
        serde_json::to_value(&v2).expect("defaults serialize"),
        golden
    );

    let serialized = serde_json::to_value(v2).expect("defaults serialize");
    let stt = &serialized["speech"]["stages"]["stt"];
    assert!(stt.get("networkKind").is_none());
    assert!(stt.get("target").is_none());
    assert_eq!(stt["experimentalRemote"], false);
    assert!(serialized["legacyV1Snapshot"].is_null());
}

#[test]
fn v1_migration_keeps_immutable_snapshot_and_inherits_stt_tts_routes() {
    let source = json!({
        "version": 0,
        "updatedAtMs": 710,
        "services": {
            "stt": { "routing": { "prefer": "network_only", "fallback": "local" } },
            "tts": { "routing": { "prefer": "local_only", "fallback": "none" } }
        }
    });
    let migrated =
        migrate_node_config_document_v2(source.clone(), 900).expect("legacy document migrates");
    let snapshot = migrated
        .legacy_v1_snapshot
        .as_deref()
        .expect("migration stores the validated V1 snapshot");
    assert_eq!(snapshot.updated_at_ms, 710);
    assert_eq!(migrated.updated_at_ms, 710);
    assert_eq!(
        migrated.speech.stages.stt.routing.prefer,
        RoutingPreference::NetworkOnly
    );
    assert_eq!(
        migrated.speech.stages.stt.routing.fallback,
        RoutingFallback::Local
    );
    assert_eq!(
        migrated.speech.stages.tts.routing.prefer,
        RoutingPreference::LocalOnly
    );
    assert_eq!(
        migrated.speech.stages.tts.routing.fallback,
        RoutingFallback::None
    );

    let wire = serde_json::to_value(&migrated).expect("migrated document serializes");
    let parsed = validate_node_config_document_v2_value(wire).expect("migrated document validates");
    assert_eq!(parsed.legacy_v1_snapshot.as_deref(), Some(snapshot));
    assert_eq!(parsed, migrated);
}

#[test]
fn strict_v2_validation_rejects_unknown_missing_and_unsafe_values() {
    let mut unknown_root = empty_v2_value();
    unknown_root["unexpected"] = json!(true);
    assert_eq!(
        validate_node_config_document_v2_value(unknown_root),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut unknown_nested = empty_v2_value();
    unknown_nested["speech"]["stages"]["tts"]["unexpected"] = json!(true);
    assert_eq!(
        validate_node_config_document_v2_value(unknown_nested),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut missing_stage = empty_v2_value();
    object_mut(&mut missing_stage, &["speech", "stages"]).remove("vad");
    assert_eq!(
        validate_node_config_document_v2_value(missing_stage),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut unknown_stage = empty_v2_value();
    unknown_stage["speech"]["stages"]["wakeword"] = json!({});
    assert_eq!(
        validate_node_config_document_v2_value(unknown_stage),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut invalid_id = empty_v2_value();
    invalid_id["speech"]["stages"]["stt"]["target"] = json!({"peerId": ".not-valid"});
    assert_eq!(
        validate_node_config_document_v2_value(invalid_id),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut wrong_kws_policy = empty_v2_value();
    wrong_kws_policy["speech"]["stages"]["kws"]["routing"]["prefer"] = json!("network_only");
    assert_eq!(
        validate_node_config_document_v2_value(wrong_kws_policy),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut null_omission_only = empty_v2_value();
    null_omission_only["speech"]["stages"]["tts"]["networkKind"] = Value::Null;
    assert_eq!(
        validate_node_config_document_v2_value(null_omission_only),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut null_experimental = empty_v2_value();
    null_experimental["speech"]["stages"]["tts"]["experimentalRemote"] = Value::Null;
    assert_eq!(
        validate_node_config_document_v2_value(null_experimental),
        Err(NodePolicyError::InvalidDocument)
    );

    for unsafe_revision in [json!(0), json!(-1), json!(1.5), json!(MAX_SAFE_INTEGER + 1)] {
        let mut invalid = empty_v2_value();
        invalid["revision"] = unsafe_revision;
        assert_eq!(
            validate_node_config_document_v2_value(invalid),
            Err(NodePolicyError::InvalidDocument)
        );
    }

    let mut invalid_limit = empty_v2_value();
    invalid_limit["speech"]["limits"]["admissionTimeoutMs"] = json!(60_001);
    assert_eq!(
        validate_node_config_document_v2_value(invalid_limit),
        Err(NodePolicyError::InvalidDocument)
    );
}

#[test]
fn feature_override_ids_are_bounded_and_prototype_safe() {
    let mut bad_proto = empty_v2_value();
    bad_proto["expose"]["featureOverrides"]["tooling"]["__proto__"] = json!({"enabled": true});
    assert_eq!(
        validate_node_config_document_v2_value(bad_proto),
        Err(NodePolicyError::InvalidDocument)
    );

    let mut too_many = empty_v2_value();
    too_many["expose"]["featureOverrides"]["tooling"] = json!({});
    let overrides = too_many["expose"]["featureOverrides"]["tooling"]
        .as_object_mut()
        .expect("feature overrides are an object");
    for index in 0..=MAX_FEATURE_OVERRIDES {
        overrides.insert(format!("feature.{index}"), json!({"enabled": true}));
    }
    assert_eq!(
        validate_node_config_document_v2_value(too_many),
        Err(NodePolicyError::InvalidDocument)
    );
}

#[test]
fn javascript_safe_integer_spellings_and_last_duplicate_key_win() {
    let vectors = cross_language_vectors();
    let json_text = include_str!("fixtures/node_policy_v2_default.json");
    let expected: Value = serde_json::from_str(json_text).expect("default golden is valid JSON");
    for replacement in vectors["safeNumberSpellings"]
        .as_array()
        .expect("number vectors are an array")
    {
        let needle = replacement["needle"]
            .as_str()
            .expect("search needle is a string");
        let substitute = replacement["replacement"]
            .as_str()
            .expect("number replacement is a string");
        assert!(
            json_text.contains(needle),
            "numeric needle must occur in base input"
        );
        let candidate = json_text.replacen(needle, substitute, 1);
        assert_ne!(candidate, json_text, "numeric input must change");
        assert!(
            candidate.contains(substitute),
            "numeric spelling must be present"
        );
        assert_eq!(
            serde_json::to_value(
                validate_node_config_document_v2_json(&candidate).expect("safe integer spelling")
            )
            .expect("normalized output serializes"),
            expected
        );
    }

    let snapshot_spellings = &vectors["snapshotNumberSpellings"];
    let v1_text = include_str!("fixtures/node_policy_v1_default.json");
    let v1_with_spellings = v1_text
        .replacen(
            snapshot_spellings["snapshotVersionNeedle"]
                .as_str()
                .expect("snapshot version needle is a string"),
            snapshot_spellings["snapshotVersionReplacement"]
                .as_str()
                .expect("snapshot version replacement is a string"),
            1,
        )
        .replacen(
            snapshot_spellings["snapshotTimestampNeedle"]
                .as_str()
                .expect("snapshot timestamp needle is a string"),
            snapshot_spellings["snapshotTimestampReplacement"]
                .as_str()
                .expect("snapshot timestamp replacement is a string"),
            1,
        );
    assert_ne!(v1_with_spellings, v1_text);
    let snapshot_member = format!("\"legacyV1Snapshot\": {v1_with_spellings}");
    let v2_with_snapshot = json_text.replacen("\"legacyV1Snapshot\": null", &snapshot_member, 1);
    assert_ne!(v2_with_snapshot, json_text);
    let parsed_snapshot = validate_node_config_document_v2_json(&v2_with_snapshot)
        .expect("safe numeric spellings inside V1 snapshot are accepted");
    let snapshot = parsed_snapshot
        .legacy_v1_snapshot
        .expect("V1 snapshot is retained");
    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.updated_at_ms, 100);

    let duplicate_vectors = &vectors["duplicateKeys"];
    let needle = duplicate_vectors["needle"]
        .as_str()
        .expect("duplicate key needle is a string");
    assert!(
        json_text.contains(needle),
        "duplicate key needle must occur in base input"
    );
    let duplicate = json_text.replacen(
        needle,
        duplicate_vectors["firstInvalidLastValid"]
            .as_str()
            .expect("valid duplicate vector is a string"),
        1,
    );
    assert_ne!(duplicate, json_text, "duplicate-key input must change");
    assert!(duplicate.contains("\"prefer\": \"unsupported\", \"prefer\": \"local\""));
    assert_eq!(
        validate_node_config_document_v2_json(&duplicate)
            .expect("last duplicate key wins")
            .services[&NodeConfigModule::Tooling]
            .routing
            .prefer,
        RoutingPreference::Local
    );

    let invalid_duplicate = json_text.replacen(
        needle,
        duplicate_vectors["firstValidLastInvalid"]
            .as_str()
            .expect("invalid duplicate vector is a string"),
        1,
    );
    assert_ne!(
        invalid_duplicate, json_text,
        "reverse duplicate-key input must change"
    );
    assert!(invalid_duplicate.contains("\"prefer\": \"local\", \"prefer\": \"unsupported\""));
    assert_eq!(
        validate_node_config_document_v2_json(&invalid_duplicate),
        Err(NodePolicyError::InvalidDocument)
    );
}

#[test]
fn raw_json_preserves_reserved_token_objects_and_string_payloads() {
    let vectors = cross_language_vectors();
    let json_text = include_str!("fixtures/node_policy_v2_default.json");
    for vector in vectors["rawTokenObjectCases"]
        .as_array()
        .expect("raw token cases are an array")
    {
        let needle = vector["needle"]
            .as_str()
            .expect("raw token needle is a string");
        let replacement = vector["replacement"]
            .as_str()
            .expect("raw token replacement is a string");
        assert!(json_text.contains(needle), "{}", vector["name"]);
        let input = json_text.replacen(needle, replacement, 1);
        assert_ne!(input, json_text, "{}", vector["name"]);
        assert_eq!(
            validate_node_config_document_v2_json(&input),
            Err(NodePolicyError::InvalidDocument),
            "{}",
            vector["name"]
        );
    }

    let string_control = &vectors["rawJsonStringControl"];
    let string_control_needle = string_control["needle"]
        .as_str()
        .expect("string-control needle is a string");
    assert!(json_text.contains(string_control_needle));
    let input = json_text.replacen(
        string_control_needle,
        string_control["replacement"]
            .as_str()
            .expect("string-control replacement is a string"),
        1,
    );
    assert_ne!(input, json_text, "string-control input must change");
    let parsed = validate_node_config_document_v2_json(&input)
        .expect("reserved-token text in a normal string remains ordinary text");
    assert_eq!(
        parsed.speech.stages.stt.language,
        NullableField::Value(
            string_control["expectedLanguage"]
                .as_str()
                .expect("expected string is a string")
                .to_owned()
        )
    );

    for token in [
        "$serde_json::private::Number",
        "$serde_json::private::RawValue",
    ] {
        let mut forged_value = empty_v2_value();
        let mut object = serde_json::Map::new();
        object.insert(token.to_owned(), json!("1.0"));
        forged_value["revision"] = Value::Object(object);
        assert_eq!(
            validate_node_config_document_v2_value(forged_value),
            Err(NodePolicyError::InvalidDocument),
            "an explicitly constructed token-shaped Value remains an object"
        );
    }

    let mut actual_number_value = empty_v2_value();
    actual_number_value["revision"] = Value::from(1.0);
    assert_eq!(
        validate_node_config_document_v2_value(actual_number_value)
            .expect("a real integral Value number remains numeric")
            .revision,
        1
    );
}

#[test]
fn raw_json_checks_overwritten_values_and_preserves_the_existing_depth_budget() {
    let vectors = cross_language_vectors();
    let json_text = include_str!("fixtures/node_policy_v2_default.json");
    let duplicate = &vectors["rawDuplicateControls"];
    let overwritten_surrogate = json_text.replacen(
        duplicate["revisionNeedle"]
            .as_str()
            .expect("revision needle is a string"),
        duplicate["overwrittenLoneSurrogate"]
            .as_str()
            .expect("surrogate duplicate is raw JSON text"),
        1,
    );
    assert_eq!(
        validate_node_config_document_v2_json(&overwritten_surrogate),
        Err(NodePolicyError::InvalidJson),
        "overwritten duplicate strings are still decoded"
    );

    let accepted_depth = format!("{}0{}", "[".repeat(127), "]".repeat(127));
    assert_eq!(
        validate_node_config_document_v2_json(&accepted_depth),
        Err(NodePolicyError::InvalidDocument),
        "127 nested containers pass JSON conversion and reach document validation"
    );
    let rejected_depth = format!("{}0{}", "[".repeat(128), "]".repeat(128));
    assert_eq!(
        validate_node_config_document_v2_json(&rejected_depth),
        Err(NodePolicyError::InvalidJson),
        "the 128th nested container preserves serde_json's recursion boundary"
    );

    let too_deep_duplicate_value = format!("{}0{}", "[".repeat(127), "]".repeat(127));
    let needle = duplicate["revisionNeedle"]
        .as_str()
        .expect("revision needle is a string");
    let replacement = format!("\"revision\": {too_deep_duplicate_value}, \"revision\": 1,");
    let overwritten_depth = json_text.replacen(needle, &replacement, 1);
    assert_ne!(overwritten_depth, json_text);
    assert_eq!(
        validate_node_config_document_v2_json(&overwritten_depth),
        Err(NodePolicyError::InvalidJson),
        "an overwritten duplicate still shares the input's depth budget"
    );
}

#[test]
fn enum_deserialization_accepts_only_sdk_string_spellings() {
    assert_eq!(
        serde_json::to_string(&RoutingPreference::LocalOnly).expect("preference serializes"),
        "\"local_only\""
    );
    assert_eq!(
        serde_json::to_string(&RoutingFallback::None).expect("fallback serializes"),
        "\"none\""
    );
    assert_eq!(
        serde_json::to_string(&SpeechNetworkKind::Mesh).expect("network kind serializes"),
        "\"mesh\""
    );

    for input in [
        "\"local\"",
        "\"network\"",
        "\"local_only\"",
        "\"network_only\"",
    ] {
        assert!(serde_json::from_str::<RoutingPreference>(input).is_ok());
    }
    for input in ["\"local\"", "\"network\"", "\"error\"", "\"none\""] {
        assert!(serde_json::from_str::<RoutingFallback>(input).is_ok());
    }
    for input in ["\"mesh\"", "\"gateway\""] {
        assert!(serde_json::from_str::<SpeechNetworkKind>(input).is_ok());
    }
    for input in ["{\"local\":null}", "{\"network\":null}"] {
        assert!(serde_json::from_str::<RoutingPreference>(input).is_err());
    }
    for input in ["{\"local\":null}", "{\"network\":null}"] {
        assert!(serde_json::from_str::<RoutingFallback>(input).is_err());
    }
    for input in ["{\"mesh\":null}", "{\"gateway\":null}"] {
        assert!(serde_json::from_str::<SpeechNetworkKind>(input).is_err());
    }

    let vectors = cross_language_vectors();
    let default_v2: Value =
        serde_json::from_str(include_str!("fixtures/node_policy_v2_default.json"))
            .expect("default V2 is valid JSON");
    for control in vectors["enumStringControls"]
        .as_array()
        .expect("enum string controls are an array")
    {
        let mut patches = vec![json!({ "path": control["path"], "value": control["value"] })];
        if control["enableExperimental"] == true {
            patches.push(json!({
                "path": ["speech", "stages", "kws", "experimentalRemote"],
                "value": true
            }));
        }
        let value = apply_patches(&default_v2, &Value::Array(patches));
        assert!(
            validate_node_config_document_v2_value(value).is_ok(),
            "valid enum spelling must remain accepted: {control}"
        );
    }
}

#[test]
fn raw_json_unicode_boundary_matches_shared_scalar_vectors() {
    let vectors = cross_language_vectors();
    let boundary = &vectors["unicodeBoundary"];
    let json_text = include_str!("fixtures/node_policy_v2_default.json");
    let needle = boundary["needle"]
        .as_str()
        .expect("Unicode boundary needle is a string");
    assert!(json_text.contains(needle));

    for vector in boundary["cases"]
        .as_array()
        .expect("Unicode cases are an array")
    {
        let replacement = vector["replacement"]
            .as_str()
            .expect("Unicode replacement is a string");
        let raw_input = json_text.replacen(needle, replacement, 1);
        assert_ne!(raw_input, json_text, "{}", vector["name"]);
        assert!(raw_input.contains(replacement), "{}", vector["name"]);

        match vector["rust"].as_str() {
            Some("reject") => assert_eq!(
                validate_node_config_document_v2_json(&raw_input),
                Err(NodePolicyError::InvalidJson),
                "{}",
                vector["name"]
            ),
            Some("accept") => {
                let parsed = validate_node_config_document_v2_json(&raw_input)
                    .expect("representable JSON string is accepted");
                let value = match &parsed.speech.stages.stt.language {
                    NullableField::Value(value) => value,
                    _ => panic!("Unicode vector sets a language string"),
                };
                assert_eq!(
                    value,
                    vector["sdkValue"]
                        .as_str()
                        .expect("accepted Unicode vector has an expected string"),
                    "{}",
                    vector["name"]
                );
            }
            _ => panic!("Unicode vector has an unsupported Rust expectation"),
        }
    }
}

#[test]
fn shared_sdk_rust_validation_vectors_have_identical_normalized_values() {
    let vectors = cross_language_vectors();
    let default_v1: Value =
        serde_json::from_str(include_str!("fixtures/node_policy_v1_default.json"))
            .expect("v1 default golden is valid JSON");
    let default_v2: Value =
        serde_json::from_str(include_str!("fixtures/node_policy_v2_default.json"))
            .expect("v2 default golden is valid JSON");
    assert_eq!(vectors["defaultV1Fixture"], "node_policy_v1_default.json");
    assert_eq!(vectors["defaultV2Fixture"], "node_policy_v2_default.json");
    assert_eq!(
        serde_json::to_value(empty_node_config_document_v1(100).expect("timestamp is safe"))
            .expect("v1 defaults serialize"),
        default_v1
    );
    assert_eq!(
        serde_json::to_value(empty_node_config_document_v2(100).expect("timestamp is safe"))
            .expect("v2 defaults serialize"),
        default_v2
    );

    let migration = &vectors["migration"];
    assert_eq!(
        migration["expectedSnapshotFixture"],
        "node_policy_v1_default.json"
    );
    let migration_input = migration["input"]
        .as_str()
        .expect("migration input is JSON text");
    let now = migration["now"]
        .as_u64()
        .expect("migration time is an integer");
    let migrated = migrate_node_config_document_v2(
        serde_json::from_str(migration_input).expect("migration vector parses as JSON"),
        now,
    )
    .expect("legacy document migrates");
    let mut expected_migration = default_v2.clone();
    expected_migration["legacyV1Snapshot"] = default_v1.clone();
    assert_eq!(
        serde_json::to_value(migrated).expect("migration output serializes"),
        expected_migration
    );

    let stage = &vectors["acceptedStage"];
    let stage_input = apply_patches(&default_v2, &stage["inputPatches"]);
    let stage_expected = apply_patches(&default_v2, &stage["expectedPatches"]);
    assert_eq!(
        serde_json::to_value(
            validate_node_config_document_v2_value(stage_input)
                .expect("stage/null vector is valid")
        )
        .expect("stage output serializes"),
        stage_expected
    );

    for patch in vectors["rejectedPatches"]
        .as_array()
        .expect("rejection vectors are an array")
    {
        let invalid = apply_patches(
            &default_v2,
            &json!([{ "path": patch["path"], "value": patch["value"] }]),
        );
        assert_eq!(
            validate_node_config_document_v2_value(invalid),
            Err(NodePolicyError::InvalidDocument),
            "{}",
            patch["name"]
        );
    }
    for removed in vectors["removedPaths"]
        .as_array()
        .expect("removal vectors are an array")
    {
        let mut invalid = default_v2.clone();
        remove_path(
            &mut invalid,
            removed["path"]
                .as_array()
                .expect("removal path is an array"),
        );
        assert_eq!(
            validate_node_config_document_v2_value(invalid),
            Err(NodePolicyError::InvalidDocument),
            "{}",
            removed["name"]
        );
    }

    for shape in vectors["invalidObjectShapes"]
        .as_array()
        .expect("object-shape vectors are an array")
    {
        let mut invalid = default_v2.clone();
        set_path(
            &mut invalid,
            shape["path"].as_array().expect("shape path is an array"),
            json!([]),
        );
        assert_eq!(
            validate_node_config_document_v2_value(invalid),
            Err(NodePolicyError::InvalidDocument),
            "{}",
            shape["name"]
        );
    }
    for shape in vectors["invalidMigrationObjectShapes"]
        .as_array()
        .expect("migration object-shape vectors are an array")
    {
        let input = shape["input"]
            .as_str()
            .expect("migration shape input is JSON text");
        assert_eq!(
            migrate_node_config_document_v2(
                serde_json::from_str(input).expect("migration shape is valid JSON"),
                99,
            ),
            Err(NodePolicyError::InvalidDocument),
            "{}",
            shape["name"]
        );
    }

    for sparse in vectors["sparseMigrations"]
        .as_array()
        .expect("sparse migration vectors are an array")
    {
        let input: Value = serde_json::from_str(
            sparse["input"]
                .as_str()
                .expect("sparse migration input is JSON text"),
        )
        .expect("sparse migration input is valid JSON");
        let expected_snapshot = validate_node_config_document_v1_value(input.clone())
            .expect("sparse V1 document validates");
        let migrated = migrate_node_config_document_v2(input.clone(), 99)
            .expect("sparse V1 document migrates");
        assert_eq!(migrated.services, expected_snapshot.services);
        assert_eq!(
            migrated.legacy_v1_snapshot.as_deref(),
            Some(&expected_snapshot)
        );
        assert_eq!(
            serde_json::to_value(&migrated).expect("migration serializes")["speech"]["stages"]
                ["stt"]["routing"],
            sparse["sttRouting"],
            "{} STT default routing",
            sparse["name"]
        );
        assert_eq!(
            serde_json::to_value(&migrated).expect("migration serializes")["speech"]["stages"]
                ["tts"]["routing"],
            sparse["ttsRouting"],
            "{} TTS routing",
            sparse["name"]
        );

        let valid_v1 = migrate_node_config_document_v1(input.clone(), MAX_SAFE_INTEGER + 1)
            .expect("unused now is ignored for valid V1 pass-through");
        let valid_v2 = migrate_node_config_document_v2(input, MAX_SAFE_INTEGER + 1)
            .expect("unused now is ignored for valid V2 migration pass-through");
        assert_eq!(valid_v1, expected_snapshot);
        assert_eq!(
            valid_v2.legacy_v1_snapshot.as_deref(),
            Some(&expected_snapshot)
        );
    }
    let valid_v2 = empty_node_config_document_v2(100).expect("default V2 document is valid");
    assert_eq!(
        migrate_node_config_document_v2(
            serde_json::to_value(&valid_v2).expect("V2 document serializes"),
            MAX_SAFE_INTEGER + 1,
        ),
        Ok(valid_v2)
    );

    let ordinary = &vectors["ordinaryUpdate"];
    let current = empty_node_config_document_v2(100).expect("default document is valid");
    let draft = apply_patches(
        &serde_json::to_value(&current).expect("current document serializes"),
        &ordinary["draftPatches"],
    );
    let expected = apply_patches(&default_v2, &ordinary["expectedPatches"]);
    let candidate = update_node_config_document_v2(
        &current,
        draft,
        ordinary["expectedRevision"]
            .as_u64()
            .expect("expected revision is an integer"),
        ordinary["now"].as_u64().expect("update time is an integer"),
    )
    .expect("ordinary update produces a candidate");
    assert_eq!(
        serde_json::to_value(candidate).expect("candidate serializes"),
        expected
    );

    let stale = update_node_config_document_v2(
        &current,
        serde_json::to_value(&current).expect("current document serializes"),
        vectors["staleConflict"]["expectedRevision"]
            .as_u64()
            .expect("stale revision is an integer"),
        101,
    );
    assert_eq!(
        stale,
        Err(NodePolicyError::RevisionConflict {
            expected_revision: 0,
            current_revision: 1,
        })
    );

    let safeguards = &vectors["intentionalRustSafeguards"];
    assert_eq!(
        safeguards["description"],
        "Rust retains the validated current V1 snapshot and rejects unsafe revision exhaustion; the current SDK update helper uses the draft snapshot and returns the unsafe max+1 candidate. These are documented safeguard divergences, not parity failures."
    );
    let current = migrate_node_config_document_v2(
        serde_json::from_str(migration_input).expect("migration vector parses"),
        now,
    )
    .expect("current document has a snapshot");
    let mut draft = serde_json::to_value(&current).expect("current document serializes");
    draft["legacyV1Snapshot"] = safeguards["draftSnapshot"].clone();
    let updated = update_node_config_document_v2(&current, draft, current.revision, 101)
        .expect("pure update returns a candidate");
    assert_eq!(updated.legacy_v1_snapshot, current.legacy_v1_snapshot);

    let max_revision = safeguards["maxSafeRevision"]
        .as_u64()
        .expect("maximum safe revision is an integer");
    let mut exhausted = empty_node_config_document_v2(100).expect("timestamp is safe");
    exhausted.revision = max_revision;
    let draft = serde_json::to_value(&exhausted).expect("exhausted document serializes");
    assert_eq!(
        update_node_config_document_v2(&exhausted, draft, max_revision, 101),
        Err(NodePolicyError::RevisionExhausted)
    );
}

#[test]
fn nullable_fields_preserve_null_while_omission_only_fields_reject_null() {
    let mut value = empty_v2_value();
    value["speech"]["stages"]["stt"]["target"] = Value::Null;
    value["speech"]["stages"]["stt"]["modelId"] = json!("logical model/path");
    value["speech"]["stages"]["stt"]["language"] = Value::Null;
    value
        .as_object_mut()
        .expect("document is an object")
        .remove("legacyV1Snapshot");

    let parsed =
        validate_node_config_document_v2_value(value).expect("nullable fields are accepted");
    assert!(matches!(
        &parsed.speech.stages.stt.target,
        NullableField::Null
    ));
    assert!(
        matches!(&parsed.speech.stages.stt.model_id, NullableField::Value(value) if value == "logical model/path")
    );
    assert!(matches!(
        &parsed.speech.stages.stt.language,
        NullableField::Null
    ));
    assert!(parsed.legacy_v1_snapshot.is_none());
    let encoded = serde_json::to_value(parsed).expect("document serializes");
    assert!(encoded["speech"]["stages"]["stt"]["target"].is_null());
    assert_eq!(
        encoded["speech"]["stages"]["stt"]["modelId"],
        "logical model/path"
    );
    assert!(encoded["speech"]["stages"]["stt"]["language"].is_null());
}

#[test]
fn v1_valid_document_is_strict_and_sparse_legacy_migration_uses_defaults() {
    let v1 = empty_node_config_document_v1(100).expect("default timestamp is safe");
    let encoded = serde_json::to_string(&v1).expect("V1 defaults serialize");
    assert!(validate_node_config_document_v1_json(&encoded).is_ok());

    let sparse = migrate_node_config_document_v2(
        json!({
            "updatedAtMs": 33,
            "services": {"tts": {"prefer": "network", "fallback": "local"}}
        }),
        99,
    )
    .expect("sparse V1 migration succeeds");
    assert_eq!(sparse.updated_at_ms, 33);
    assert_eq!(
        sparse.speech.stages.tts.routing.prefer,
        RoutingPreference::Network
    );
    assert_eq!(
        sparse.speech.stages.stt.routing.prefer,
        RoutingPreference::Local
    );
    assert!(sparse.legacy_v1_snapshot.is_some());

    let invalid = encoded.replace("\"version\":1", "\"version\":1,\"extra\":true");
    assert_eq!(
        validate_node_config_document_v1_json(&invalid),
        Err(NodePolicyError::InvalidDocument)
    );
}

#[test]
fn pure_update_preserves_current_snapshot_and_returns_only_candidate_document() {
    let current = migrate_node_config_document_v2(
        json!({"version":0,"services":{"stt":{"prefer":"network","fallback":"local"}}}),
        100,
    )
    .expect("legacy input migrates");
    let original_snapshot = current.legacy_v1_snapshot.clone();
    let mut draft = serde_json::to_value(&current).expect("current document serializes");
    draft["legacyV1Snapshot"] = Value::Null;
    draft["speech"]["sharing"]["stt"] = json!(true);

    let candidate = update_node_config_document_v2(&current, draft, current.revision, 200)
        .expect("candidate update is valid");
    assert_eq!(candidate.revision, current.revision + 1);
    assert_eq!(candidate.updated_at_ms, 200);
    assert!(candidate.speech.sharing.stt);
    assert_eq!(candidate.legacy_v1_snapshot, original_snapshot);
    assert_eq!(current.revision, 1);

    let stale = update_node_config_document_v2(
        &current,
        serde_json::to_value(&current).expect("current document serializes"),
        current.revision + 1,
        201,
    );
    assert!(matches!(
        stale,
        Err(NodePolicyError::RevisionConflict { .. })
    ));
}

#[test]
fn update_keeps_current_snapshot_when_draft_has_a_different_valid_snapshot() {
    let current =
        migrate_node_config_document_v2(json!({"version":0,"updatedAtMs":101,"services":{}}), 101)
            .expect("current legacy migration succeeds");
    let different =
        migrate_node_config_document_v2(json!({"version":0,"updatedAtMs":202,"services":{}}), 202)
            .expect("different legacy migration succeeds");
    let mut draft = serde_json::to_value(&current).expect("current document serializes");
    draft["legacyV1Snapshot"] = serde_json::to_value(
        different
            .legacy_v1_snapshot
            .expect("migration has a snapshot"),
    )
    .expect("different snapshot serializes");

    let candidate =
        update_node_config_document_v2(&current, draft, 1, 300).expect("candidate update is valid");
    assert_eq!(candidate.legacy_v1_snapshot, current.legacy_v1_snapshot);
}

#[test]
fn update_rejects_revision_exhaustion_without_mutating_current_document() {
    let mut current = empty_node_config_document_v2(100).expect("default timestamp is safe");
    current.revision = MAX_SAFE_INTEGER;
    let before = current.clone();
    let result = update_node_config_document_v2(
        &current,
        serde_json::to_value(&current).expect("current document serializes"),
        MAX_SAFE_INTEGER,
        200,
    );
    assert_eq!(result, Err(NodePolicyError::RevisionExhausted));
    assert_eq!(current, before);
}

#[test]
fn target_nullable_components_round_trip_independently() {
    let mut value = empty_v2_value();
    value["speech"]["stages"]["tts"]["target"] = json!({
        "peerId": "peer-1",
        "resourceId": null,
        "modelId": "model-1"
    });
    let parsed = validate_node_config_document_v2_value(value).expect("target is valid");
    let target = match &parsed.speech.stages.tts.target {
        NullableField::Value(target) => target,
        _ => panic!("target should be present"),
    };
    assert!(matches!(&target.resource_id, NullableField::Null));
    assert!(matches!(&target.model_id, NullableField::Value(value) if value == "model-1"));
    let serialized = serde_json::to_value(parsed).expect("document serializes");
    assert!(serialized["speech"]["stages"]["tts"]["target"]["resourceId"].is_null());
}

#[test]
fn legacy_migration_rejects_wrong_service_and_routing_shapes() {
    let invalid_version = migrate_node_config_document_v2(json!({"version": 3}), 100);
    assert_eq!(invalid_version, Err(NodePolicyError::UnsupportedVersion));
    let invalid_service =
        migrate_node_config_document_v2(json!({"version": 0,"services":{"tts":null}}), 100);
    assert_eq!(invalid_service, Err(NodePolicyError::InvalidDocument));
}

#[test]
fn speech_stage_network_kind_and_ids_use_sdk_wire_names() {
    let mut value = empty_v2_value();
    value["speech"]["stages"]["tts"]["networkKind"] = json!("mesh");
    value["speech"]["stages"]["tts"]["target"] = json!({"peerId":"peer-1"});
    let parsed = validate_node_config_document_v2_value(value).expect("stage is valid");
    assert_eq!(
        &parsed.speech.stages.tts.network_kind,
        &Omitted::Value(SpeechNetworkKind::Mesh)
    );
    assert_eq!(
        parsed.speech.stages.tts.routing.prefer,
        RoutingPreference::Local
    );
    assert_eq!(
        parsed.speech.stages.tts.routing.fallback,
        RoutingFallback::Network
    );
    let target = match &parsed.speech.stages.tts.target {
        NullableField::Value(target) => target,
        _ => panic!("target should be present"),
    };
    assert_eq!(target.peer_id, "peer-1");
}
