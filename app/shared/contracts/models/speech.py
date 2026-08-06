"""Provider-neutral speech routing contract primitives."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Annotated, Literal, cast

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.shared.contracts.io_model import IOModel

SPEECH_LANGUAGE_TABLE_REVISION: Literal["aurora-speech-language-v1"] = "aurora-speech-language-v1"
SpeechLanguageTag = Literal["de", "en", "es", "fr", "it", "ja", "ko", "pt", "zh"]
NormalizedSpeechLanguage = SpeechLanguageTag | Literal["auto"]

SUPPORTED_SPEECH_LANGUAGE_TAGS: tuple[SpeechLanguageTag, ...] = (
    "de",
    "en",
    "es",
    "fr",
    "it",
    "ja",
    "ko",
    "pt",
    "zh",
)
# V1 intentionally declares no locale fallbacks. A locale such as pt-BR stays
# ineligible until a later table revision names the exact pt-BR -> pt mapping.
SUPPORTED_SPEECH_LOCALE_FALLBACKS: tuple[tuple[str, str], ...] = ()
MAX_SPEECH_LANGUAGE_CANDIDATES = 8
MAX_SPEECH_CONSTRAINT_LANGUAGES = 64
MAX_READY_VOICE_IDS = 256
MAX_JS_SAFE_INTEGER = 9_007_199_254_740_991

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STANDARD_VOICE_ID_PATTERN = r"standard:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}"
_CLONE_VOICE_ID_PATTERN = (
    r"clone:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
LOGICAL_VOICE_ID_PATTERN = rf"^(?:{_STANDARD_VOICE_ID_PATTERN}|{_CLONE_VOICE_ID_PATTERN})$"
LogicalVoiceId = Annotated[str, Field(pattern=LOGICAL_VOICE_ID_PATTERN)]

_STANDARD_VOICE_ID_RE = re.compile(rf"^{_STANDARD_VOICE_ID_PATTERN}$")
_CLONE_VOICE_ID_RE = re.compile(rf"^{_CLONE_VOICE_ID_PATTERN}$")


def normalize_speech_language(
    value: str | None, *, allow_auto: bool = False
) -> NormalizedSpeechLanguage | None:
    """Normalize a wire language tag against Aurora's explicit v1 table."""

    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("speech language must be a string")
    normalized = value.strip().lower().replace("_", "-")
    if not normalized:
        return None
    if allow_auto and normalized == "auto":
        return "auto"
    if normalized not in SUPPORTED_SPEECH_LANGUAGE_TAGS:
        raise ValueError(f"unsupported speech language: {value!r}")
    return cast(SpeechLanguageTag, normalized)


def normalize_exact_speech_language(value: str | None) -> SpeechLanguageTag:
    """Normalize a required exact language tag."""

    normalized = normalize_speech_language(value)
    if normalized is None:
        raise ValueError("language must not be blank")
    return cast(SpeechLanguageTag, normalized)


def normalize_speech_language_candidates(values: list[str]) -> list[SpeechLanguageTag]:
    """Normalize, dedupe, sort, and bound automatic language candidates."""

    normalized = {normalize_exact_speech_language(value) for value in values}
    if len(normalized) > MAX_SPEECH_LANGUAGE_CANDIDATES:
        raise ValueError("auto language candidates exceed limit")
    return sorted(normalized)


def validate_logical_voice_id(value: str) -> LogicalVoiceId:
    """Validate a provider-neutral logical Aurora voice id."""

    if not isinstance(value, str):
        raise ValueError("voice_id must be a string")
    if value != value.strip():
        raise ValueError("voice_id must not contain surrounding whitespace")
    if _STANDARD_VOICE_ID_RE.fullmatch(value) or _CLONE_VOICE_ID_RE.fullmatch(value):
        return value
    raise ValueError("voice_id must match standard:<group>:<name> or clone:<uuid>")


def _validate_sha256(value: str, field_name: str) -> str:
    if not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a SHA-256 hex digest")
    return value


class SpeechLanguageRequirement(IOModel):
    """Canonical language requirement used by route policy and target checks."""

    mode: Literal["exact", "auto"]
    language: SpeechLanguageTag | None = None
    auto_language_candidates: list[SpeechLanguageTag] = Field(
        default_factory=list, max_length=MAX_SPEECH_LANGUAGE_CANDIDATES
    )
    table_revision: Literal["aurora-speech-language-v1"] = SPEECH_LANGUAGE_TABLE_REVISION
    digest: str | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        return normalize_speech_language(value)

    @field_validator("auto_language_candidates", mode="before")
    @classmethod
    def _normalize_candidates(cls, value: list[str]) -> list[SpeechLanguageTag]:
        return normalize_speech_language_candidates(value)

    @field_validator("digest")
    @classmethod
    def _normalize_digest(cls, value: str | None) -> str | None:
        return _validate_sha256(value, "digest") if value is not None else None

    @model_validator(mode="after")
    def _validate_shape_and_digest(self) -> SpeechLanguageRequirement:
        if self.mode == "exact":
            if self.language is None:
                raise ValueError("exact language requirement needs language")
            if self.auto_language_candidates:
                raise ValueError("exact language requirement cannot include auto candidates")
        else:
            if self.language is not None:
                raise ValueError("auto language requirement cannot include exact language")
        expected = self.compute_digest()
        if self.digest is not None and self.digest != expected:
            raise ValueError("language requirement digest mismatch")
        self.digest = expected
        return self

    def canonical_payload(self) -> dict[str, object]:
        """Return the canonical digest payload."""

        return {
            "auto_language_candidates": self.auto_language_candidates,
            "language": self.language,
            "mode": self.mode,
            "table_revision": self.table_revision,
        }

    def compute_digest(self) -> str:
        """Return the canonical SHA-256 digest for this requirement."""

        payload = json.dumps(self.canonical_payload(), separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SpeechLocaleFallback(IOModel):
    """Explicit locale/language fallback supported by a resident speech model."""

    requested_language: SpeechLanguageTag
    served_language: SpeechLanguageTag

    model_config = ConfigDict(extra="forbid")

    @field_validator("requested_language", "served_language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str) -> str:
        return normalize_exact_speech_language(value)

    @model_validator(mode="after")
    def _validate_declared_fallback(self) -> SpeechLocaleFallback:
        fallback = (self.requested_language, self.served_language)
        if fallback not in SUPPORTED_SPEECH_LOCALE_FALLBACKS:
            raise ValueError("locale fallback is not declared by the language table")
        return self


class SpeechMethodConstraints(IOModel):
    """Recipient-projected speech method constraints used for route eligibility."""

    constraint_version: Literal["aurora-speech-method-constraints-v1"] = (
        "aurora-speech-method-constraints-v1"
    )
    locale_table_revision: Literal["aurora-speech-language-v1"] = SPEECH_LANGUAGE_TABLE_REVISION
    exact_languages: list[SpeechLanguageTag] = Field(
        default_factory=list, max_length=MAX_SPEECH_CONSTRAINT_LANGUAGES
    )
    supports_auto_detect: bool = False
    auto_detect_languages: list[SpeechLanguageTag] = Field(
        default_factory=list, max_length=MAX_SPEECH_CONSTRAINT_LANGUAGES
    )
    locale_fallbacks: list[SpeechLocaleFallback] = Field(
        default_factory=list, max_length=MAX_SPEECH_CONSTRAINT_LANGUAGES
    )
    ready_voice_ids: list[LogicalVoiceId] = Field(
        default_factory=list, max_length=MAX_READY_VOICE_IDS
    )
    resident_model_identity_digest: str | None = None
    speech_capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)

    model_config = ConfigDict(extra="forbid")

    @field_validator("exact_languages", "auto_detect_languages", mode="before")
    @classmethod
    def _normalize_language_set(cls, value: list[str]) -> list[SpeechLanguageTag]:
        normalized = {normalize_exact_speech_language(item) for item in value}
        if len(normalized) > MAX_SPEECH_CONSTRAINT_LANGUAGES:
            raise ValueError("constraint language list exceeds limit")
        return sorted(normalized)

    @field_validator("ready_voice_ids", mode="before")
    @classmethod
    def _normalize_voice_ids(cls, value: list[str]) -> list[LogicalVoiceId]:
        return sorted({validate_logical_voice_id(item) for item in value})

    @field_validator("locale_fallbacks")
    @classmethod
    def _normalize_locale_fallbacks(
        cls, value: list[SpeechLocaleFallback]
    ) -> list[SpeechLocaleFallback]:
        unique = {
            (fallback.requested_language, fallback.served_language): fallback for fallback in value
        }
        return [unique[key] for key in sorted(unique)]

    @field_validator("resident_model_identity_digest")
    @classmethod
    def _normalize_resident_digest(cls, value: str | None) -> str | None:
        return (
            _validate_sha256(value, "resident_model_identity_digest") if value is not None else None
        )

    @model_validator(mode="after")
    def _validate_constraints(self) -> SpeechMethodConstraints:
        exact_languages = set(self.exact_languages)
        coverage = set(self.auto_detect_languages)
        if self.supports_auto_detect:
            if len(coverage) < 2:
                raise ValueError("auto coverage must contain at least two languages")
            if not coverage.issubset(exact_languages):
                raise ValueError("auto coverage must be a subset of exact languages")
        elif coverage:
            raise ValueError("auto coverage requires supports_auto_detect")
        for fallback in self.locale_fallbacks:
            if fallback.served_language not in exact_languages:
                raise ValueError("fallback served language must be exact-ready")
        if (
            exact_languages
            or self.locale_fallbacks
            or self.ready_voice_ids
            or self.supports_auto_detect
        ) and self.resident_model_identity_digest is None:
            raise ValueError("ready speech constraints require a resident model identity")
        return self


class SpeechRouteBinding(IOModel):
    """Trusted internal route metadata created by local/Gateway/Mesh routing."""

    service_instance_id: str = Field(min_length=1, max_length=256)
    projection_digest: str
    projection_revision: str = Field(min_length=1, max_length=256)
    provider_lease_epoch: str = Field(min_length=1, max_length=256)
    provider_lease_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    speech_capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    requirement_digest: str

    model_config = ConfigDict(extra="forbid")

    @field_validator("service_instance_id", "projection_revision", "provider_lease_epoch")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("route binding values must not be blank")
        return value

    @field_validator("projection_digest", "requirement_digest")
    @classmethod
    def _normalize_digest(cls, value: str) -> str:
        return _validate_sha256(value, "digest")


class SpeechStorageSummary(IOModel):
    """Redacted bounded storage summary for management surfaces."""

    bytes_used: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    artifact_count: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)

    model_config = ConfigDict(extra="forbid")
