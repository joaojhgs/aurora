# Final Migration to pyproject.toml - Complete

**Date**: 2025-11-07  
**Status**: ✅ Complete

## Summary

All requirements.txt files have been removed and all scripts, CI/CD configurations, and documentation have been migrated to use `pyproject.toml` as the single source of truth for dependency management.

## Files Removed

1. ✅ **`requirements-runtime.txt`** - Removed (replaced by `pyproject.toml` `[project.dependencies]` and `runtime` extra)
2. ✅ **`requirements-dev.txt`** - Removed (replaced by `pyproject.toml` `dev` extra)
3. ✅ **`requirements-test.txt`** - Removed (replaced by `pyproject.toml` `test` extras)
4. ✅ **`requirements-docker.txt`** - Removed (replaced by `pyproject.toml` `all-services` and `mode-threads` extras)
5. ✅ **`requirements-lint.txt`** - Removed (replaced by `pyproject.toml` `dev` extra)
6. ✅ **`requirements.txt`** - Removed (legacy file)
7. ✅ **`modules/ui/requirements.txt`** - Removed (replaced by `pyproject.toml` `ui` extra)

## Scripts Updated

1. ✅ **`scripts/analyze-dependencies.py`**
   - Updated to read from `pyproject.toml` instead of `requirements-runtime.txt`
   - Added `get_dependencies_from_pyproject()` function
   - Updated `compare_with_requirements()` to support both pyproject.toml and legacy requirements files
   - Updated usage documentation

2. ✅ **`scripts/analyze-transitive-deps.py`**
   - Updated to read from `pyproject.toml` instead of `requirements-runtime.txt`
   - Added TOML parsing with fallback to `toml` package for Python < 3.11

3. ✅ **`Makefile`**
   - Updated `analyze-deps-compare` target to use `pyproject.toml` instead of `requirements-runtime.txt`

## CI/CD Updated

All GitHub Actions workflows and tox.ini were already updated in the previous migration:
- ✅ All workflows use `pip install -e .[<extras>]`
- ✅ tox.ini uses `-e {toxinidir}[dev,test]`

## Documentation Updated

1. ✅ **`modules/ui/README.md`**
   - Updated installation command from `pip install -r requirements.txt` to `pip install -e .[ui]`

2. ✅ **`.github/copilot-instructions.md`**
   - Already updated in previous migration

3. ✅ **`docs/CONTRIBUTE.md`**
   - Already updated in previous migration

## pyproject.toml Structure

All dependencies are now organized in `pyproject.toml`:

### Core Dependencies (`[project.dependencies]`)
- Essential runtime dependencies shared by all services

### Optional Dependencies (`[project.optional-dependencies]`)

**Service-specific:**
- `service-config`, `service-db`, `service-scheduler`, `service-tooling`
- `service-stt-audio-input`, `service-stt-wakeword`, `service-stt-transcription`
- `service-stt-coordinator`, `service-tts`, `service-orchestrator`

**Mode-specific:**
- `mode-threads` (no additional dependencies)
- `mode-processes` (bullmq)

**Development:**
- `dev` (development tools, linting, testing)
- `test`, `test-unit`, `test-integration`, `test-e2e`, `test-performance`, `test-all`

**Modules:**
- `ui` (PyQt6 for UI module)

**Convenience:**
- `all-services` (combines all service groups)
- `runtime` (full runtime dependencies)

## Migration Benefits

1. **Single Source of Truth**: All dependencies defined in one place
2. **Consistency**: CI/CD, local development, and Docker all use the same system
3. **Maintainability**: No need to keep multiple files in sync
4. **Modern Standards**: Follows PEP 621 standards
5. **Flexibility**: Easy to add new optional dependency groups

## Installation Commands

### For Users
```bash
# Runtime (all services, threads mode)
pip install -e .[all-services,mode-threads]

# Runtime (all services, processes mode)
pip install -e .[all-services,mode-processes]

# Specific service (processes mode)
pip install -e .[service-{name},mode-processes]
```

### For Developers
```bash
# Development dependencies
pip install -e .[dev]

# Development with all test dependencies
pip install -e .[dev,test-all]
```

### For Testing
```bash
# Core test dependencies
pip install -e .[test]

# Specific test types
pip install -e .[test-unit]
pip install -e .[test-integration]
pip install -e .[test-e2e]
pip install -e .[test-performance]

# All test dependencies
pip install -e .[test-all]
```

### For Modules
```bash
# UI module
pip install -e .[ui]

# OpenRecall module
pip install -e .[openrecall]
```

## Verification

All scripts and tools now use `pyproject.toml`:
- ✅ `scripts/analyze-dependencies.py` - Reads from pyproject.toml
- ✅ `scripts/analyze-transitive-deps.py` - Reads from pyproject.toml
- ✅ `Makefile` - Uses pyproject.toml for comparison
- ✅ All GitHub Actions workflows - Use `pip install -e .[<extras>]`
- ✅ `tox.ini` - Uses `-e {toxinidir}[dev,test]`
- ✅ `Dockerfile` (main) - Uses `pip install -e .[all-services,mode-threads]`
- ✅ Service Dockerfiles - Use `pip install -e .[service-{name},mode-processes]`

## Backward Compatibility

No backward compatibility needed - all requirements files have been removed. All tools and scripts have been updated to use `pyproject.toml` directly.

## Next Steps

1. ✅ All requirements files removed
2. ✅ All scripts migrated
3. ✅ All CI/CD configurations migrated
4. ✅ All documentation updated
5. ⏭️ Test all workflows to ensure they work correctly
6. ⏭️ Update any external documentation that references requirements files

## Related Documentation

- [CI/CD Migration to pyproject.toml](./CI-PYPROJECT-TOML-MIGRATION.md)
- [Requirements Files Cleanup](./REQUIREMENTS-FILES-CLEANUP.md)
- [Dependency Restructuring Summary](../DEPENDENCY_RESTRUCTURE_SUMMARY.md)










