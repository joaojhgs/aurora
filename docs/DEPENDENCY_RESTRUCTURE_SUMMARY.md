# Dependency Management Restructuring - Summary

## What Was Done

### 1. Created Comprehensive Investigation Plan
- **File**: `.cursor/plans/dependency-restructure.plan.md`
- **Content**: Detailed 8-phase plan covering investigation and restructuring
- **Phases**:
  1. Dependency Analysis Tools Setup
  2. Service-Specific Dependency Mapping
  3. Mode and Context Analysis
  4. Unused Dependency Identification
  5. New Dependency Structure Design
  6. Dockerfile Updates
  7. Installation Scripts and Tools
  8. Documentation and Migration

### 2. Created Dependency Analysis Script
- **File**: `scripts/analyze-dependencies.py`
- **Features**:
  - Analyzes Python imports across codebase
  - Maps imports to package names
  - Identifies service-specific dependencies
  - Finds shared dependencies
  - Compares actual usage with declared requirements
- **Usage**:
  ```bash
  python scripts/analyze-dependencies.py --service config
  python scripts/analyze-dependencies.py --all
  python scripts/analyze-dependencies.py --compare requirements-runtime.txt
  ```

### 3. Updated Makefile
- **New Commands**:
  - `make analyze-deps`: Analyze all services
  - `make analyze-deps-service SERVICE=<name>`: Analyze specific service
  - `make analyze-deps-compare`: Compare with requirements
  - `make install-analysis-tools`: Install analysis tools
  - `make generate-dependency-tree`: Generate dependency tree
  - `make audit-dependencies`: Security audit

### 4. Created Individual Service Dockerfiles
- **Location**: `docker/services/`
- **Files Created**:
  - `Dockerfile.config`
  - `Dockerfile.db`
  - `Dockerfile.tooling`
  - `Dockerfile.scheduler`
  - `Dockerfile.tts`
  - `Dockerfile.audio-input`
  - `Dockerfile.wakeword`
  - `Dockerfile.transcription`
  - `Dockerfile.stt-coordinator`
  - `Dockerfile.orchestrator`
- **Status**: Created but still install all dependencies (needs restructuring)

### 5. Updated docker-compose.process.yml
- **Changes**: Updated to use individual service Dockerfiles
- **Status**: Ready for testing once dependencies are restructured

## Current Issues

1. **All services still install all dependencies**
   - Each Dockerfile installs `requirements-runtime.txt` which includes everything
   - Need to create service-specific requirement files

2. **Mode-specific dependencies not separated**
   - `bullmq` and `janus` in requirements-runtime.txt
   - Should be in mode-specific files

3. **Hardware acceleration dependencies always included**
   - `torch`, `torchaudio`, `torchvision` always installed
   - Should be optional

4. **No service-specific requirement files yet**
   - Need to create `requirements/services/` structure
   - Need to extract dependencies per service

## Next Steps

### Immediate (Investigation Phase)

1. **Run dependency analysis**
   ```bash
   make install-analysis-tools
   make analyze-deps
   make generate-dependency-tree
   make audit-dependencies
   ```

2. **Analyze each service**
   ```bash
   make analyze-deps-service SERVICE=config
   make analyze-deps-service SERVICE=db
   make analyze-deps-service SERVICE=tooling
   # ... for each service
   ```

3. **Compare with requirements**
   ```bash
   make analyze-deps-compare
   ```

4. **Review analysis results**
   - Check `docs/dependency-analysis/` for reports
   - Identify unused dependencies
   - Identify service-specific dependencies
   - Identify shared dependencies

### Short-term (Restructuring Phase)

1. **Create new requirement file structure**
   - Create `requirements/` directory structure
   - Extract core dependencies
   - Extract service-specific dependencies
   - Extract mode-specific dependencies

2. **Update Dockerfiles**
   - Update each service Dockerfile to use service-specific requirements
   - Test builds
   - Verify images are smaller

3. **Create installation helpers**
   - Create `scripts/install-deps.py`
   - Update Makefile with new targets
   - Create validation scripts

### Long-term (Documentation and Migration)

1. **Document new structure**
   - Create comprehensive documentation
   - Create migration guide
   - Update README files

2. **Migrate existing setups**
   - Update CI/CD pipelines
   - Update development documentation
   - Create migration scripts

## Expected Benefits

1. **Smaller Docker Images**
   - Config service: < 500MB (currently likely > 2GB)
   - Each service only includes what it needs

2. **Faster Builds**
   - Better layer caching
   - Fewer dependencies to install

3. **Clearer Structure**
   - Easy to understand what each service needs
   - Easy to add new services
   - Easy to add optional features

4. **Better Maintainability**
   - Clear guidelines for adding dependencies
   - Automated validation
   - Good documentation

## Tools Available

- **Analysis Script**: `scripts/analyze-dependencies.py`
- **Make Targets**: Various analysis commands
- **Plan Document**: `.cursor/plans/dependency-restructure.plan.md`

## Quick Start

To begin the investigation:

```bash
# Install analysis tools
make install-analysis-tools

# Create analysis directory
mkdir -p docs/dependency-analysis

# Analyze all services
make analyze-deps

# Generate dependency tree
make generate-dependency-tree

# Security audit
make audit-dependencies

# Compare with requirements
make analyze-deps-compare
```

Then review the results in `docs/dependency-analysis/` and proceed with restructuring based on findings.










