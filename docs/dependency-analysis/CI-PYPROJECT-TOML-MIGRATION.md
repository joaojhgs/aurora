# CI/CD Migration to pyproject.toml

**Date**: 2025-11-07  
**Status**: ✅ Complete

## Summary

Updated all CI/CD configurations and documentation to use `pyproject.toml` as the primary dependency management system instead of requirements.txt files.

## Changes Made

### GitHub Actions Workflows

All workflows updated to use `pip install -e .[<extras>]` instead of `pip install -r requirements-*.txt`:

1. **`.github/workflows/test-core.yml`**
   - **Before**: `pip install -r requirements-dev.txt` and `pip install -r requirements-test.txt`
   - **After**: `pip install -e .[dev,test]`

2. **`.github/workflows/test-all.yml`**
   - **Before**: `pip install -r requirements-dev.txt` and `pip install -r requirements-test.txt`
   - **After**: `pip install -e .[dev,test-all]`

3. **`.github/workflows/test-modules.yml`**
   - **Before**: `pip install -r requirements-dev.txt`, `pip install -r requirements-test.txt`, and `pip install -r modules/ui/requirements.txt`
   - **After**: 
     - UI module: `pip install -e .[dev,test,ui]`
     - OpenRecall module: `pip install -e .[dev,test,openrecall]`

4. **`.github/workflows/test-e2e.yml`**
   - **Before**: `pip install -r requirements-dev.txt` and `pip install -r requirements-test.txt`
   - **After**: `pip install -e .[dev,test-e2e]`

5. **`.github/workflows/test-performance.yml`**
   - **Before**: `pip install -r requirements-dev.txt` and `pip install -r requirements-test.txt`
   - **After**: `pip install -e .[dev,test-performance]`

6. **`.github/workflows/lint.yml`**
   - **Before**: `pip install -r requirements-lint.txt`
   - **After**: `pip install -e .[dev]` (linting tools are in the `dev` extra)

7. **`.github/workflows/release.yml`**
   - **Already using pyproject.toml**: `pip install -e .[build,dev]` and `pip install -e .[runtime,build,torch-cpu]`
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
      -e {toxinidir}[dev,test]
  ```

### Documentation Updates

1. **`.github/copilot-instructions.md`**
   - Updated installation command from `pip install -r requirements-dev.txt` to `pip install -e .[dev]`
   - Updated dependency management notes to reflect `pyproject.toml` as primary source
   - Updated file structure documentation

2. **`docs/CONTRIBUTE.md`**
   - Updated test installation command from `pip install -r requirements-test.txt` to `pip install -e .[test]`

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
pip install -r requirements-dev.txt
pip install -r requirements-test.txt
```

**New way**:
```bash
pip install -e .[dev,test]
```

### For CI/CD

**Old way**:
```yaml
- name: Install dependencies
  run: |
    pip install -r requirements-dev.txt
    pip install -r requirements-test.txt
```

**New way**:
```yaml
- name: Install dependencies
  run: |
    python -m pip install --upgrade pip setuptools wheel
    pip install -e .[dev,test]
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

- [Dependency Restructuring Summary](../DEPENDENCY_RESTRUCTURE_SUMMARY.md)
- [Requirements Files Cleanup](./REQUIREMENTS-FILES-CLEANUP.md)
- [pyproject.toml Structure](../../pyproject.toml)










