"""Unit tests for version compatibility checking."""

import pytest

from app.services.gateway.mesh.version_compat import (
    is_compatible,
    parse_semver,
)


class TestParseSemver:
    """Tests for parse_semver()."""

    def test_standard_version(self):
        assert parse_semver("1.2.3") == (1, 2, 3)

    def test_zero_version(self):
        assert parse_semver("0.0.0") == (0, 0, 0)

    def test_large_numbers(self):
        assert parse_semver("100.200.300") == (100, 200, 300)

    def test_pre_release(self):
        result = parse_semver("1.0.0-beta.1")
        assert result == (1, 0, 0)

    def test_build_metadata(self):
        result = parse_semver("1.0.0+build.123")
        assert result == (1, 0, 0)

    def test_pre_release_and_build(self):
        result = parse_semver("2.1.0-alpha.1+build.456")
        assert result == (2, 1, 0)

    def test_two_part_version(self):
        assert parse_semver("1.2") == (1, 2, 0)

    def test_single_part_version(self):
        assert parse_semver("3") == (3, 0, 0)

    def test_invalid_version(self):
        assert parse_semver("not-a-version") is None

    def test_empty_string(self):
        assert parse_semver("") is None

    def test_whitespace_stripped(self):
        assert parse_semver("  1.2.3  ") == (1, 2, 3)


class TestIsCompatible:
    """Tests for is_compatible()."""

    def test_any_policy_always_compatible(self):
        assert is_compatible("1.0.0", "99.99.99", "any") is True
        assert is_compatible("1.0.0", "0.0.1", "any") is True

    def test_exact_policy_same_version(self):
        assert is_compatible("1.2.3", "1.2.3", "exact") is True

    def test_exact_policy_different_version(self):
        assert is_compatible("1.2.3", "1.2.4", "exact") is False

    def test_exact_policy_different_major(self):
        assert is_compatible("1.0.0", "2.0.0", "exact") is False

    def test_compatible_policy_same_major(self):
        assert is_compatible("1.0.0", "1.5.0", "compatible") is True

    def test_compatible_policy_remote_newer(self):
        assert is_compatible("1.0.0", "1.2.3", "compatible") is True

    def test_compatible_policy_remote_older(self):
        assert is_compatible("1.5.0", "1.2.0", "compatible") is False

    def test_compatible_policy_different_major(self):
        assert is_compatible("1.0.0", "2.0.0", "compatible") is False

    def test_compatible_policy_with_min_version(self):
        assert is_compatible("1.0.0", "1.5.0", "compatible", min_version="1.3.0") is True

    def test_compatible_policy_below_min_version(self):
        assert is_compatible("1.0.0", "1.2.0", "compatible", min_version="1.3.0") is False

    def test_compatible_policy_exact_min_version(self):
        assert is_compatible("1.0.0", "1.3.0", "compatible", min_version="1.3.0") is True

    def test_unparseable_versions_exact(self):
        assert is_compatible("abc", "abc", "exact") is True
        assert is_compatible("abc", "def", "exact") is False

    def test_unparseable_versions_compatible_fail_closed(self):
        # "compatible" is an ordering question and an unparseable version
        # cannot be ordered, so it must not satisfy a min_version constraint.
        assert is_compatible("abc", "def", "compatible") is False
        assert is_compatible("1.0.0", "latest", "compatible") is False
        assert is_compatible("latest", "1.0.0", "compatible") is False

    def test_unknown_policy_is_permissive(self):
        assert is_compatible("1.0.0", "2.0.0", "unknown_policy") is True
