# CI/CD Migration to pyproject.toml

**Date**: 2025-11-07  
**Status**: ✅ Complete

## Summary

Updated all CI/CD configurations and documentation to use `pyproject.toml` as the primary dependency management system instead of requirements.txt files.

## Changes Made

### GitHub Actions Workflows

Current durable workflows use `uv sync --extra ...`/pyproject extras instead of requirements files:

1. **`.github/workflows/python-tests.yml`**
   - **Before**: `requirements file: requirements-dev.txt` and `requirements file: requirements-test.txt`
   - **After**: `uv sync --extra dev,test`

2. **`release.yml` readiness/manual test lanes**
   - **Before**: `requirements file: requirements-dev.txt` and `requirements file: requirements-test.txt`
   - **After**: `uv sync --extra dev,test-all`

3. **package/module-specific local test lanes**
   - **Before**: `requirements file: requirements-dev.txt`, `requirements file: requirements-test.txt`, and `requirements file: modules/ui/requirements.txt`
   - **After**: 
     - UI module: `uv sync --extra dev,test,ui`
     - OpenRecall module: `uv sync --extra dev,test,openrecall`

4. **`.github/workflows/e2e.yml`**
   - **Before**: `requirements file: requirements-dev.txt` and `requirements file: requirements-test.txt`
   - **After**: `uv sync --extra dev,test-e2e`

5. **`.github/workflows/performance.yml`**
   - **Before**: `requirements file: requirements-dev.txt` and `requirements file: requirements-test.txt`
   - **After**: `uv sync --extra dev,test-performance`

6. **`.github/workflows/quality.yml`**
   - **Before**: `requirements file: requirements-lint.txt`
   - **After**: `uv sync --extra dev` (linting tools are in the `dev` extra)

7. **`.github/workflows/release.yml`**
   - **Already using pyproject.toml**: `uv sync --extra build,dev` and `uv sync --extra runtime,build,torch-cpu`
   - **No changes needed**

### tox.ini

**Updated to use pyproject.toml**:
- **Before**: 
  ```ini
  deps =
      -r requirements-dev.txt
      -r requirements-test.txt
  ```
- **After**: 
  ```ini
  deps = 
      -e {toxinidir}[dev,test
  ```

### Documentation Updates

1. **`.github/copilot-instructions.md`**
   - Updated installation command from `requirements file: requirements-dev.txt` to `uv sync --extra dev`
   - Updated dependency management notes to reflect `pyproject.toml` as primary source
   - Updated file structure documentation

2. **`docs/CONTRIBUTE.md`**
   - Updated test installation command from `requirements file: requirements-test.txt` to `uv sync --extra test`

## pyproject.toml Optional Dependency Groups Used

The following optional dependency groups from `pyproject.toml` are now used in CI/CD:

- **`dev`**: Development tools (black, flake8, mypy, pre-commit, pytest, etc.)
- **`test`**: Core test dependencies (pytest, pytest-asyncio, pytest-cov, etc.)
- **`test-all`**: All test dependencies (unit, integration, e2e, performance)
- **`test-e2e`**: End-to-end test dependencies (pytest-playwright, selenium)
- **`test-performance`**: Performance test dependencies (pytest-benchmark, locust)
- **`ui`**: UI module dependencies (PyQt6)
- **`openrecall`**: OpenRecall module dependencies
- **`build`**: Build tools (pyinstaller, etc.)
- **`runtime`**: Runtime dependencies
- **`torch-cpu`**: CPU-only PyTorch

## Benefits

1. **Single Source of Truth**: `pyproject.toml` is now the primary dependency manager
2. **Consistency**: All CI/CD and local development use the same dependency management system
3. **Maintainability**: Dependencies are defined in one place, reducing duplication
4. **Flexibility**: Easy to add new optional dependency groups for specific use cases
5. **Modern Standards**: Follows PEP 621 standards for Python project metadata

## Backward Compatibility

Legacy requirements.txt files are still kept for:
- **tox.ini compatibility**: `requirements-dev.txt` and `requirements-test.txt` are still referenced by tox.ini (though tox.ini now uses pyproject.toml directly)
- **Analysis tools**: `requirements-runtime.txt` is still used by dependency analysis scripts for comparison
- **Documentation**: Some documentation may still reference requirements files for historical context

## Migration Path

### For Developers

**Old way**:
```bash
requirements file: requirements-dev.txt
requirements file: requirements-test.txt
```

**New way**:
```bash
uv sync --extra dev,test
```

### For CI/CD

**Old way**:
```yaml
- name: Install dependencies
  run: |
    requirements file: requirements-dev.txt
    requirements file: requirements-test.txt
```

**New way**:
```yaml
- name: Install dependencies
  run: |
    python -m pip install --upgrade pip setuptools wheel
    uv sync --extra dev,test
```

## Next Steps

1. ✅ All GitHub Actions workflows updated
2. ✅ tox.ini updated
3. ✅ Documentation updated
4. ⏭️ Consider updating dependency analysis scripts to compare against `pyproject.toml` instead of `requirements-runtime.txt`
5. ⏭️ Consider removing legacy requirements files once all tools are migrated (if possible)

## Testing

All CI/CD workflows should be tested to ensure:
- Dependencies install correctly
- Tests run successfully
- Linting passes
- Builds complete successfully

## Related Documentation

- [Dependency Restructuring Summary(../DEPENDENCY_RESTRUCTURE_SUMMARY.md)
- [Requirements Files Cleanup(./REQUIREMENTS-FILES-CLEANUP.md)
- [pyproject.toml Structure(../../pyproject.toml)










