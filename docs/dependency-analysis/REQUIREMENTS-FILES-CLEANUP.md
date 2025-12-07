# Requirements Files Cleanup

**Date**: 2025-11-07  
**Status**: ✅ Complete

## Summary

Removed unused requirements.txt files and updated remaining ones to use `pyproject.toml` as the primary dependency management system.

## Files Removed

1. **`requirements-lint.txt`** - Not used anywhere (only mentioned in its own comment)
2. **`requirements.txt`** - Legacy file, not used anywhere

## Files Kept (for backward compatibility)

1. **`requirements-runtime.txt`** - Kept for:
   - Analysis scripts (for comparison)
   - Makefile (for comparison)
   - `requirements-dev.txt` (includes it)
   - `requirements-docker.txt` (includes it)
   - **Note**: New installations should use `pip install -e .[runtime]`

2. **`requirements-docker.txt`** - Kept for:
   - Main Dockerfile (legacy monolithic container)
   - **Note**: Main Dockerfile now uses `pyproject.toml` instead
   - **Status**: Deprecated, kept for backward compatibility

3. **`requirements-dev.txt`** - Kept for:
   - `tox.ini` (testing framework)
   - **Note**: New installations should use `pip install -e .[dev-full]`

4. **`requirements-test.txt`** - Kept for:
   - `tox.ini` (testing framework)
   - `requirements-dev.txt` (includes it)
   - **Note**: New installations should use `pip install -e .[test]`

5. **`modules/ui/requirements.txt`** - Kept for:
   - UI module (PyQt6) - separate from main dependencies

## Files Updated

1. **`Dockerfile`** (main):
   - **Before**: Used `requirements-docker.txt`
   - **After**: Uses `pip install -e .[all-services,mode-threads]`
   - **Reason**: Aligns with new dependency management approach

2. **`requirements-runtime.txt`**:
   - Added deprecation notice
   - Recommends using `pip install -e .[runtime]`

3. **`requirements-docker.txt`**:
   - Added deprecation notice
   - Notes that main Dockerfile now uses `pyproject.toml`

4. **`requirements-dev.txt`**:
   - Added note about backward compatibility with `tox.ini`
   - Recommends using `pip install -e .[dev-full]`

5. **`requirements-test.txt`**:
   - Added note about backward compatibility with `tox.ini`
   - Recommends using `pip install -e .[test]`

## Current Status

### Primary Dependency Management
- ✅ **`pyproject.toml`** - Primary source of truth for all dependencies
- ✅ Service-specific Dockerfiles use `pip install -e .[service-{name},mode-processes]`
- ✅ Main Dockerfile uses `pip install -e .[all-services,mode-threads]`
- ✅ Setup scripts use `pip install -e .[runtime,{provider},{hardware}]`

### Legacy Files (kept for compatibility)
- ⚠️ `requirements-runtime.txt` - For analysis tools and backward compatibility
- ⚠️ `requirements-docker.txt` - Deprecated, main Dockerfile updated
- ⚠️ `requirements-dev.txt` - For `tox.ini` compatibility
- ⚠️ `requirements-test.txt` - For `tox.ini` compatibility

## Migration Path

### For Users
- **Old**: `pip install -r requirements-runtime.txt`
- **New**: `pip install -e .[runtime]`

### For Developers
- **Old**: `pip install -r requirements-dev.txt`
- **New**: `pip install -e .[dev-full]`

### For Testing
- **Old**: `pip install -r requirements-test.txt`
- **New**: `pip install -e .[test]`

### For Docker
- **Old**: Main Dockerfile used `requirements-docker.txt`
- **New**: Main Dockerfile uses `pip install -e .[all-services,mode-threads]`
- **Service Dockerfiles**: Use `pip install -e .[service-{name},mode-processes]`

## Benefits

1. **Single source of truth**: `pyproject.toml` is the primary dependency manager
2. **Reduced maintenance**: Fewer files to keep in sync
3. **Better organization**: Dependencies organized by service, mode, and purpose
4. **Backward compatibility**: Legacy files kept for tools that still need them (tox.ini, analysis scripts)

## Next Steps

1. ⏭️ Update `tox.ini` to use `pyproject.toml` instead of requirements files (if possible)
2. ⏭️ Update analysis scripts to compare against `pyproject.toml` instead of `requirements-runtime.txt`
3. ⏭️ Consider removing `requirements-docker.txt` once main Dockerfile migration is confirmed working










