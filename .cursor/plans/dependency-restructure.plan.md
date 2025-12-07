# Dependency Management Restructuring Plan

## Overview

This plan outlines a comprehensive investigation and restructuring of Aurora's dependency management system to support:

- Service-specific dependencies (each service only installs what it needs)
- Mode-specific dependencies (threads vs processes)
- Optional dependencies (plugins, hardware acceleration)
- Efficient Docker builds (smaller images, faster builds)
- CI/CD optimization (test dependencies only when needed)

## Current State Analysis

### Current Problems

1. **All services install all dependencies**

   - Every service Dockerfile installs `requirements-runtime.txt` which includes everything
   - Services like ConfigService don't need PyAudio, torch, faster-whisper, etc.
   - Results in large Docker images and slow builds

2. **Mode-specific dependencies mixed with core**

   - `bullmq>=1.7.0` and `janus>=1.0.0` in requirements-runtime.txt
   - BullMQ only needed for process mode
   - Janus may not be needed at all (verify)

3. **Hardware acceleration dependencies always included**

   - `torch==2.6.0`, `torchaudio==2.6.0`, `torchvision==2.6.0` always installed
   - CUDA libraries downloaded even when not using GPU
   - Should be optional based on hardware acceleration config

4. **Plugin dependencies in core requirements**

   - Some plugin-specific dependencies may be in core requirements
   - Should be clearly separated

5. **Test dependencies not clearly separated**

   - CI needs to install test dependencies
   - Should be easy to install just test deps

### Current Files Structure

```
requirements-runtime.txt    # All runtime deps (too broad)
requirements-docker.txt      # runtime + container tools
requirements-dev.txt         # Development tools
requirements-test.txt        # Test dependencies
requirements-lint.txt       # Linting tools
requirements.txt            # Legacy/complete list
pyproject.toml             # Complex optional dependencies
```

## Investigation Phase

### Phase 1: Dependency Analysis Tools Setup

**Goal**: Set up tools to analyze actual dependency usage

**Tasks**:

1. **Install dependency analysis tools**
   ```bash
   pip install pipdeptree pip-audit pipreqs dephell
   ```

2. **Use pipdeptree to map dependency tree**
   ```bash
   pipdeptree --all > dependency-tree.txt
   pipdeptree --json > dependency-tree.json
   ```

3. **Use pipreqs to scan actual imports**
   ```bash
   pipreqs app/ --savepath requirements-actual.txt
   pipreqs app/services/config/ --savepath requirements-config.txt
   pipreqs app/services/db/ --savepath requirements-db.txt
   # ... for each service
   ```

4. **Use dephell to analyze dependencies**
   ```bash
   dephell deps tree
   dephell deps check
   ```

5. **Create dependency usage analysis script**

   - Scan all Python files for imports
   - Map imports to packages
   - Identify which services use which packages
   - Generate service-specific dependency reports

**Tools to Evaluate**:

- `pipdeptree`: Visualize dependency tree
- `pipreqs`: Generate requirements from imports
- `dephell`: Dependency management and analysis
- `pip-audit`: Security audit
- `pip-tools`: Compile requirements with versions
- Custom Python script: Service-specific import analysis

**Deliverables**:

- `scripts/analyze-dependencies.py`: Custom analysis script
- `docs/dependency-analysis/`: Directory with analysis reports
- `docs/dependency-analysis/service-imports.json`: Service import mapping
- `docs/dependency-analysis/dependency-tree.txt`: Full dependency tree
- `docs/dependency-analysis/unused-dependencies.txt`: Potentially unused deps

### Phase 2: Service-Specific Dependency Mapping

**Goal**: Identify exact dependencies each service needs

**Tasks**:

1. **Analyze each service's imports**

   - Config Service: `app/services/config/`
   - DB Service: `app/services/db/`
   - Tooling Service: `app/services/tooling/`
   - Scheduler Service: `app/services/scheduler/`
   - TTS Service: `app/services/tts/`
   - Audio Input Service: `app/services/stt_audio_input/`
   - Wake Word Service: `app/services/stt_wakeword/`
   - Transcription Service: `app/services/stt_transcription/`
   - STT Coordinator Service: `app/services/stt_coordinator/`
   - Orchestrator Service: `app/services/orchestrator/`

2. **Map imports to packages**

   - Direct imports (e.g., `import numpy` → `numpy`)
   - Indirect imports (e.g., `from faster_whisper import WhisperModel` → `faster-whisper`)
   - Shared dependencies (e.g., `pydantic` used by many services)

3. **Identify shared/core dependencies**

   - Dependencies used by ALL services
   - Dependencies used by shared code (`app/shared/`)
   - Dependencies used by messaging infrastructure

4. **Categorize dependencies**

   - **Core/Shared**: Used by all or most services (pydantic, python-dotenv, etc.)
   - **Service-Specific**: Only used by one service (faster-whisper → transcription)
   - **Mode-Specific**: Only needed in specific modes (bullmq → process mode)
   - **Optional**: Plugins, hardware acceleration, etc.
   - **Test-Only**: Only needed for testing

**Deliverables**:

- `docs/dependency-analysis/service-dependencies.json`: Service → dependencies mapping
- `docs/dependency-analysis/core-dependencies.txt`: Shared dependencies
- `docs/dependency-analysis/service-specific-dependencies.json`: Service-specific deps

### Phase 3: Mode and Context Analysis

**Goal**: Identify dependencies needed only in specific contexts

**Tasks**:

1. **Process Mode Dependencies**

   - Analyze `app/messaging/bullmq_bus.py`
   - Identify: `bullmq`, `redis` client, etc.
   - Verify if `janus` is actually used

2. **Threads Mode Dependencies**

   - Analyze `app/messaging/local_bus.py`
   - Verify if any special dependencies needed
   - Check if `janus` is used

3. **Hardware Acceleration Dependencies**

   - Analyze `app/helpers/getUseHardwareAcceleration.py`
   - Map CUDA/ROCm/Metal dependencies
   - Identify when torch GPU packages are needed

4. **Plugin Dependencies**

   - Analyze each plugin module
   - Map plugin → dependencies
   - Verify if any are in core requirements unnecessarily

5. **Test Dependencies**

   - Analyze `tests/` directory
   - Identify test-only dependencies
   - Separate from runtime dependencies

**Deliverables**:

- `docs/dependency-analysis/mode-dependencies.json`: Mode → dependencies
- `docs/dependency-analysis/plugin-dependencies.json`: Plugin → dependencies
- `docs/dependency-analysis/test-dependencies.json`: Test-only dependencies
- `docs/dependency-analysis/hardware-acceleration-dependencies.json`: GPU/accel deps

### Phase 4: Unused Dependency Identification

**Goal**: Find dependencies that can be removed

**Tasks**:

1. **Compare declared vs actual usage**

   - Compare `requirements-runtime.txt` with actual imports
   - Identify packages in requirements but not imported
   - Check for transitive dependencies that might be unnecessary

2. **Check for redundant dependencies**

   - Multiple packages providing same functionality
   - Outdated packages that can be replaced
   - Packages with overlapping features

3. **Verify optional dependencies**

   - Check if optional deps in pyproject.toml are actually optional
   - Verify plugin dependencies are truly optional

4. **Security and maintenance audit**

   - Use `pip-audit` to find vulnerable packages
   - Check for outdated packages
   - Identify packages with no recent updates

**Deliverables**:

- `docs/dependency-analysis/unused-dependencies.txt`: Dependencies to remove
- `docs/dependency-analysis/redundant-dependencies.txt`: Redundant packages
- `docs/dependency-analysis/security-audit.txt`: Security issues
- `docs/dependency-analysis/outdated-packages.txt`: Packages needing updates

## Restructuring Phase

### Phase 5: New Dependency Structure Design

**Goal**: Design new dependency management structure

**Proposed Structure**:

**Primary**: Use `pyproject.toml` for all dependency management

- Core dependencies in `[project.dependencies]`
- Service-specific dependencies as optional groups: `[project.optional-dependencies.service-{name}]`
- Mode-specific dependencies as optional groups: `[project.optional-dependencies.mode-{name}]`
- Plugin dependencies as optional groups: `[project.optional-dependencies.plugin-{name}]`
- Hardware acceleration as optional groups: `[project.optional-dependencies.{hardware}]`

**Minimal requirement files** (only for Docker builds):

```
requirements/
├── docker-service-{name}.txt    # Service-specific for Docker (references pyproject.toml extras)
└── docker-all.txt                # All services for threads mode (references pyproject.toml extras)
```

**Dependency Composition Rules**:

1. **Service Dockerfile**: Install via `pip install -e .[service-{name},mode-processes]`
2. **Threads Mode**: Install via `pip install -e .[all-services,mode-threads]`
3. **CI Test**: Install via `pip install -e .[test]`
4. **Development**: Install via `pip install -e .[dev]`
5. **User Setup**: Install via `pip install -e .[runtime,{provider},{hardware}]` (existing structure)

**Tasks**:

1. **Reorganize pyproject.toml dependencies**

   - Keep core dependencies in `[project.dependencies]` (shared by all)
   - Create service-specific optional groups: `service-config`, `service-db`, `service-tooling`, etc.
   - Create mode-specific optional groups: `mode-threads`, `mode-processes`
   - Keep existing optional groups (plugins, hardware acceleration) but organize better
   - Remove unused dependencies (janus, halo, etc.)
   - Add missing dependencies (pvporcupine, typing-extensions, etc.)

2. **Create minimal requirement files for Docker** (only if needed)

   - Create service-specific requirement files that reference pyproject.toml extras
   - These are only for Docker builds where we can't use `pip install -e .`

3. **Update dependency groups in pyproject.toml**

   - Organize by service: `service-config`, `service-db`, `service-tooling`, etc.
   - Organize by mode: `mode-threads`, `mode-processes`
   - Keep existing groups for backward compatibility
   - Create convenience groups: `all-services`, `all-plugins`, etc.

4. **Maintain backward compatibility**

   - Keep existing optional dependency groups working
   - Update `runtime` group to include all core dependencies
   - Ensure existing installation methods still work

**Deliverables**:

- Reorganized `pyproject.toml` with service/mode-specific optional groups
- Minimal requirement files (only for Docker if needed)
- Updated installation documentation
- Migration guide from old to new structure

### Phase 6: Dockerfile Updates

**Goal**: Update Dockerfiles to use service-specific dependencies

**Tasks**:

1. **Update each service Dockerfile**

   - Remove `requirements-runtime.txt` reference
   - Install only needed dependencies using pyproject.toml extras:
     ```dockerfile
     COPY pyproject.toml setup.cfg ./
     COPY app/ app/
     COPY modules/ modules/
     RUN pip install --no-cache-dir -e .[service-config,mode-processes]
     ```

   - Or use minimal requirement files if `pip install -e .` doesn't work in Docker

2. **Optimize Dockerfile layers**

   - Copy base requirements first (better caching)
   - Copy service-specific requirements
   - Install in single RUN command for efficiency

3. **Create base Dockerfile**

   - Common setup (user creation, directories)
   - Can be used as base image for services

4. **Update docker-compose**

   - Verify all services use correct Dockerfiles
   - Ensure dependency installation works

**Deliverables**:

- Updated service Dockerfiles in `docker/services/`
- Base Dockerfile (if using multi-stage builds)
- Updated `docker-compose.process.yml`
- Build verification script

### Phase 7: Installation Scripts and Tools

**Goal**: Create tools for easy dependency installation

**Tasks**:

1. **Create installation helper script**
   ```python
   # scripts/install-deps.py
   # Usage:
   #   python scripts/install-deps.py --service config
   #   python scripts/install-deps.py --mode threads
   #   python scripts/install-deps.py --mode processes --service db
   #   python scripts/install-deps.py --test
   #   python scripts/install-deps.py --dev
   ```

2. **Create Docker build helper**
   ```bash
   # scripts/docker-build-service.sh
   # Builds a single service with correct dependencies
   ```

3. **Update Makefile**

   - Add targets for installing service-specific deps
   - Add targets for Docker builds
   - Add targets for CI dependency installation

4. **Create dependency validation script**

   - Verify all services can import their dependencies
   - Check for missing dependencies
   - Validate Docker builds

**Deliverables**:

- `scripts/install-deps.py`: Dependency installation helper
- `scripts/docker-build-service.sh`: Docker build helper
- Updated `Makefile` with new targets
- `scripts/validate-dependencies.py`: Validation script

### Phase 8: Documentation and Migration

**Goal**: Document new structure and migration path

**Tasks**:

1. **Create dependency documentation**

   - Document new structure
   - Explain dependency composition
   - Provide examples

2. **Create migration guide**

   - How to migrate from old to new structure
   - Update existing Dockerfiles
   - Update CI/CD pipelines

3. **Update README files**

   - Installation instructions
   - Docker build instructions
   - Development setup

4. **Create dependency decision tree**

   - When to add dependencies
   - Where to add dependencies
   - How to test dependency changes

**Deliverables**:

- `docs/DEPENDENCY_MANAGEMENT.md`: Comprehensive guide
- `docs/MIGRATION_GUIDE.md`: Migration instructions
- Updated `README.md` and service READMEs
- `docs/DEPENDENCY_DECISIONS.md`: Decision tree and guidelines

## Implementation Checklist

### Investigation Phase

- [ ] Phase 1: Set up dependency analysis tools
- [ ] Phase 1: Create dependency analysis script
- [ ] Phase 1: Generate dependency analysis reports
- [ ] Phase 2: Analyze each service's imports
- [ ] Phase 2: Map imports to packages
- [ ] Phase 2: Identify shared dependencies
- [ ] Phase 2: Categorize dependencies
- [ ] Phase 3: Analyze mode-specific dependencies
- [ ] Phase 3: Analyze plugin dependencies
- [ ] Phase 3: Analyze test dependencies
- [ ] Phase 4: Identify unused dependencies
- [ ] Phase 4: Check for redundant dependencies
- [ ] Phase 4: Security audit

### Restructuring Phase

- [ ] Phase 5: Create new directory structure
- [ ] Phase 5: Extract core dependencies
- [ ] Phase 5: Create service-specific files
- [ ] Phase 5: Create mode-specific files
- [ ] Phase 5: Create optional dependency files
- [ ] Phase 5: Update pyproject.toml
- [ ] Phase 6: Update all service Dockerfiles
- [ ] Phase 6: Optimize Dockerfile layers
- [ ] Phase 6: Create base Dockerfile (if needed)
- [ ] Phase 6: Update docker-compose
- [ ] Phase 7: Create installation helper script
- [ ] Phase 7: Create Docker build helper
- [ ] Phase 7: Update Makefile
- [ ] Phase 7: Create validation script
- [ ] Phase 8: Update setup.sh (Linux/macOS)
- [ ] Phase 8: Update setup.bat (Windows)
- [ ] Phase 8: Update setup.py (Python setup script)
- [ ] Phase 8: Update auxiliary setup scripts
- [ ] Phase 8: Test setup scripts
- [ ] Phase 9: Create documentation
- [ ] Phase 9: Create migration guide
- [ ] Phase 9: Update README files
- [ ] Phase 9: Update installation documentation

## Success Criteria

1. **Service Docker images are significantly smaller**

   - Config service: < 500MB (currently likely > 2GB)
   - Each service only includes what it needs

2. **Docker builds are faster**

   - Better layer caching
   - Fewer dependencies to install

3. **Clear dependency structure**

   - Easy to understand what each service needs
   - Easy to add new services
   - Easy to add new optional features

4. **Maintainable**

   - Clear guidelines for adding dependencies
   - Automated validation
   - Good documentation

5. **Backward compatible**

   - Existing installation methods still work
   - Migration path is clear
   - No breaking changes for end users

## Tools and Resources

### Python Tools

- `pipdeptree`: Dependency tree visualization
- `pipreqs`: Generate requirements from imports
- `dephell`: Dependency management
- `pip-audit`: Security auditing
- `pip-tools`: Requirements compilation
- `pip-check`: Check for outdated packages

### Analysis Scripts

- Custom Python script for import analysis
- Service-specific dependency extraction
- Dependency usage tracking

### Documentation

- Dependency decision tree
- Service dependency matrix
- Mode dependency matrix
- Plugin dependency matrix

## Next Steps

1. **Start with Phase 1**: Set up analysis tools and create analysis script
2. **Run Phase 2-4**: Complete investigation
3. **Review findings**: Identify quick wins and major issues
4. **Implement Phase 5-8**: Restructure based on findings
5. **Test thoroughly**: Verify all services work with new structure
6. **Document**: Complete all documentation
7. **Migrate**: Update CI/CD and existing setups

## Notes

- This is a large refactoring that should be done incrementally
- Start with one service (e.g., ConfigService) as proof of concept
- Validate approach before applying to all services
- Maintain backward compatibility during transition
- Consider creating a migration script to help users