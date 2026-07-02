# Aurora Voice Assistant - Makefile
# Simple commands for common development tasks

# Prefer Docker Compose V2 (`docker compose`) when the plugin is installed
DOCKER_COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
# Match Tiltfile `project_name` so `make docker-process-up` and `tilt up` use the same project/images
AURORA_COMPOSE_PROJECT ?= aurora-process
DEP_ANALYSIS_DIR ?= .artifacts/dependency-analysis

.PHONY: help setup lint test format check check-docs check-config-generated coverage clean docker-process-mode docker-process-up docker-process-down docker-process-logs docker-process-ps docker-process-restart compose-validate-tilt tilt-up tilt-compose-rebuild docker-process-rebuild-tilt docker-db-build-openai docker-db-build-local docker-db-build docker-build-db-openai docker-build-db-local docker-orchestrator-build-openai docker-orchestrator-build-hf-endpoint docker-orchestrator-build-hf-local docker-orchestrator-build-llama-cpp docker-orchestrator-build-llama-cpp-cuda docker-orchestrator-build

# Default target when just running 'make'
help:
	@echo "Aurora Development Commands:"
	@echo "------------------------"
	@echo "make setup       - Set up development environment"
	@echo "make lint        - Run linting on all files (ruff)"
	@echo "make format      - Run auto-formatting (ruff)"
	@echo "make check       - Run all checks (lint + format + docs hygiene)"
	@echo "make check-config-generated - Verify generated config artifacts are current"
	@echo "make check-docs   - Validate documentation links and hygiene"
	@echo "make test        - Run all tests"
	@echo "make unit        - Run unit tests only"
	@echo "make integration - Run integration tests only"
	@echo "make coverage    - Generate test coverage report"
	@echo "make clean       - Remove temporary files"
	@echo ""
	@echo "Docker Process Mode Commands:"
	@echo "------------------------------"
	@echo "make docker-process-mode  - Setup and start Aurora in process mode"
	@echo "make docker-process-up    - Start all Aurora services"
	@echo "make docker-process-down  - Stop all Aurora services"
	@echo "make docker-process-logs  - View logs from all services"
	@echo "make docker-process-ps    - Show status of all services"
	@echo "make docker-process-restart - Restart all services"
	@echo "make compose-validate-tilt - Validate process + Tilt compose merge (needs Docker Compose)"
	@echo "make tilt-up              - Start Tilt UI (requires tilt CLI)"
	@echo "make tilt-compose-rebuild - Build image(s) + tilt trigger (stack stays up; pass SERVICES=...)"
	@echo "make docker-process-rebuild-tilt - Rebuild all Compose images for Tilt project"
	@echo ""
	@echo "DB Service Build Commands:"
	@echo "-------------------------"
	@echo "make docker-db-build-openai - Build DB service with OpenAI embeddings (~500MB)"
	@echo "make docker-db-build-local   - Build DB service with local embeddings (~8GB)"
	@echo "make docker-db-build        - Build DB service from config.json services.db.embeddings.use_local"
	@echo ""
	@echo "Orchestrator Service Build Commands:"
	@echo "-----------------------------------"
	@echo "make docker-orchestrator-build-openai      - Build orchestrator with OpenAI (~200MB)"
	@echo "make docker-orchestrator-build-hf-endpoint - Build orchestrator with HuggingFace endpoint (~250MB)"
	@echo "make docker-orchestrator-build-hf-local    - Build orchestrator with HuggingFace local (~7GB)"
	@echo "make docker-orchestrator-build-llama-cpp  - Build orchestrator with llama.cpp CPU (~700MB)"
	@echo "make docker-orchestrator-build-llama-cpp-cuda - Build orchestrator with llama.cpp CUDA (~700MB)"
	@echo "make docker-orchestrator-build            - Build orchestrator from config.json services.orchestrator.llm"

# Setup development environment
setup:
	@echo "Setting up development environment..."
	./setup.sh

# Run linting checks
lint:
	@echo "Running linting checks..."
	ruff check app tests scripts

# Run auto-formatting
format:
	@echo "Running auto-formatting..."
	ruff check --fix app tests scripts
	ruff format app tests scripts

# Run type checking
typing:
	@echo "Running type checking..."
	mypy --explicit-package-bases app tests

# Run all checks
check:
	@echo "Running all code quality checks..."
	ruff check app tests scripts
	ruff format --check app tests scripts
	$(MAKE) check-docs
	# mypy --explicit-package-bases app tests scripts

check-docs:
	@echo "Checking documentation links and hygiene..."
	@uv run python scripts/check_docs.py

# Run all tests
test:
	@echo "Running all tests..."
	pytest

# Run unit tests only
unit:
	@echo "Running unit tests..."
	pytest tests/unit

# Run integration tests only
integration:
	@echo "Running integration tests..."
	pytest tests/integration

# Run tests with coverage
coverage:
	@echo "Running tests with coverage report..."
	pytest --cov=app --cov-report=term --cov-report=html

# Clean temporary files
clean:
	@echo "Cleaning temporary files..."
	rm -rf .pytest_cache
	rm -rf .coverage
	rm -rf htmlcov
	rm -rf .mypy_cache
	rm -rf build
	rm -rf dist
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete

# Config codegen: regenerate Pydantic models, ConfigKeys, and defaults from config_schema.json
generate-config:
	uv run --extra dev python scripts/generate_config_artifacts.py

check-config-generated:
	@echo "Checking generated config artifacts are current..."
	@uv run --extra dev python scripts/generate_config_artifacts.py --check
	@echo "Generated config artifacts are current."


# Docker Process Mode Commands
docker-process-mode:
	@echo "Setting up and starting Aurora in process mode..."
	@bash scripts/docker-process-mode.sh

docker-process-up:
	@echo "Starting Aurora services in process mode..."
	
	@eval "$$(python scripts/config_to_docker_env.py --format shell)" && \
		$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml up -d

docker-process-down:
	@echo "Stopping Aurora services in process mode..."
	@$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml down

docker-process-logs:
	@echo "Viewing logs from all Aurora services..."
	@$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml logs -f

docker-process-ps:
	@echo "Status of Aurora services:"
	@$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml ps

docker-process-restart:
	@echo "Restarting Aurora services..."
	@$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml restart

compose-validate-tilt:
	@echo "Validating docker-compose.process.yml + docker-compose.tilt.yml..."
	
	@eval "$$(python scripts/config_to_docker_env.py --format shell)" && \
	if $(DOCKER_COMPOSE) version >/dev/null 2>&1; then \
		$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml -f docker-compose.tilt.yml config --quiet; \
	else \
		bash scripts/compose-docker.sh -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml -f docker-compose.tilt.yml config --quiet; \
	fi
	@echo "OK"

tilt-up:
	@command -v tilt >/dev/null 2>&1 || (echo "Install Tilt: https://docs.tilt.dev/install.html"; exit 1)
	tilt up

# Rebuild one or more services and tell a running `tilt up` to pick up new images (no `tilt down`).
# Examples: make tilt-compose-rebuild
#           make tilt-compose-rebuild SERVICES="db-service auth-service"
tilt-compose-rebuild:
	@bash scripts/tilt-compose-rebuild.sh $(SERVICES)

# Rebuild images used by Tilt (project aurora-process) after dependency/Dockerfile changes
docker-process-rebuild-tilt:
	
	@eval "$$(python scripts/config_to_docker_env.py --format shell)" && \
		$(DOCKER_COMPOSE) -p $(AURORA_COMPOSE_PROJECT) -f docker-compose.process.yml -f docker-compose.tilt.yml build

# DB Service Build Commands
docker-db-build-openai:
	@echo "Building DB service with OpenAI embeddings (smaller - ~500MB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg DB_EMBEDDINGS_MODE=openai db-service

docker-db-build-local:
	@echo "Building DB service with local embeddings (larger - ~8GB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg DB_EMBEDDINGS_MODE=local db-service

docker-db-build:
	@echo "Building DB service from config.json services.db.embeddings.use_local..."
	@eval "$$(python scripts/config_to_docker_env.py --format shell)" && \
		$(DOCKER_COMPOSE) -f docker-compose.process.yml build db-service

# Orchestrator Service Build Commands
docker-orchestrator-build-openai:
	@echo "Building orchestrator service with OpenAI (smaller - ~200MB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg ORCHESTRATOR_LLM_MODE=openai orchestrator-service

docker-orchestrator-build-hf-endpoint:
	@echo "Building orchestrator service with HuggingFace endpoint (small - ~250MB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg ORCHESTRATOR_LLM_MODE=huggingface-endpoint orchestrator-service

docker-orchestrator-build-hf-local:
	@echo "Building orchestrator service with HuggingFace local pipeline (larger - ~7GB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg ORCHESTRATOR_LLM_MODE=huggingface-local orchestrator-service

docker-orchestrator-build-llama-cpp:
	@echo "Building orchestrator service with llama.cpp CPU (medium - ~700MB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp orchestrator-service

docker-orchestrator-build-llama-cpp-cuda:
	@echo "Building orchestrator service with llama.cpp CUDA (medium - ~700MB)..."
	@$(DOCKER_COMPOSE) -f docker-compose.process.yml build \
		--build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=cuda \
		orchestrator-service

docker-orchestrator-build:
	@echo "Building orchestrator service from config.json services.orchestrator.llm..."
	@eval "$$(python scripts/config_to_docker_env.py --format shell)" && \
		$(DOCKER_COMPOSE) -f docker-compose.process.yml build orchestrator-service

# Dependency Analysis Commands
analyze-deps:
	@echo "Analyzing dependencies across all services..."
	@mkdir -p $(DEP_ANALYSIS_DIR)
	@python scripts/analyze-dependencies.py --all --output $(DEP_ANALYSIS_DIR)/service-dependencies.json

analyze-deps-service:
	@echo "Usage: make analyze-deps-service SERVICE=<service-name>"
	@if [ -z "$(SERVICE)" ]; then \
		echo "Error: SERVICE parameter required"; \
		echo "Example: make analyze-deps-service SERVICE=config"; \
		exit 1; \
	fi
	@python scripts/analyze-dependencies.py --service $(SERVICE)

analyze-deps-compare:
	@echo "Comparing actual usage with pyproject.toml..."
	@mkdir -p $(DEP_ANALYSIS_DIR)
	@python scripts/analyze-dependencies.py --all --compare pyproject.toml --output $(DEP_ANALYSIS_DIR)/comparison.json

install-analysis-tools:
	@echo "Installing dependency analysis tools..."
	@pip install pipdeptree pipreqs pip-audit pip-tools

generate-dependency-tree:
	@echo "Generating dependency tree..."
	@mkdir -p $(DEP_ANALYSIS_DIR)
	@pipdeptree --all > $(DEP_ANALYSIS_DIR)/dependency-tree.txt
	@pipdeptree --json > $(DEP_ANALYSIS_DIR)/dependency-tree.json
	@echo "Dependency tree saved to $(DEP_ANALYSIS_DIR)/"

audit-dependencies:
	@echo "Auditing dependencies for security issues..."
	@mkdir -p $(DEP_ANALYSIS_DIR)
	@pip-audit --format json --output $(DEP_ANALYSIS_DIR)/security-audit.json || true
	@pip-audit --format text > $(DEP_ANALYSIS_DIR)/security-audit.txt || true

# Docker Hub configuration
DOCKER_REGISTRY ?= docker.io
DOCKER_NAMESPACE ?= aurora-ai
VERSION ?= $(shell python -c "import tomllib; f=open('pyproject.toml','rb'); print(tomllib.load(f)['project']['version'])")

# Docker Hub Login
docker-login:
	@echo "Logging in to $(DOCKER_REGISTRY)..."
	@docker login $(DOCKER_REGISTRY) -u $(DOCKER_USERNAME) -p $(DOCKER_PASSWORD)

# Build all service images
docker-build-all:
	@echo "Building all service images..."
	$(MAKE) docker-build-config
	$(MAKE) docker-build-db-openai
	$(MAKE) docker-build-db-local
	$(MAKE) docker-build-orchestrator-openai
	$(MAKE) docker-build-orchestrator-hf-endpoint
	$(MAKE) docker-build-orchestrator-hf-local
	$(MAKE) docker-build-orchestrator-llama-cpu
	$(MAKE) docker-build-orchestrator-llama-cuda
	$(MAKE) docker-build-orchestrator-llama-rocm
	$(MAKE) docker-build-orchestrator-llama-metal
	$(MAKE) docker-build-tts-cpu
	$(MAKE) docker-build-tts-cuda
	$(MAKE) docker-build-tts-rocm
	$(MAKE) docker-build-tts-metal
	$(MAKE) docker-build-stt-transcription-cpu
	$(MAKE) docker-build-stt-transcription-cuda
	$(MAKE) docker-build-stt-wakeword-cpu
	$(MAKE) docker-build-stt-wakeword-cuda
	$(MAKE) docker-build-scheduler
	$(MAKE) docker-build-tooling
	$(MAKE) docker-build-stt-audio-input
	$(MAKE) docker-build-stt-coordinator

# Config Service builds
docker-build-config:
	docker build -f docker/services/Dockerfile.config \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-config:$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-config:latest \
		.

# DB Service builds
docker-build-db-openai:
	docker build --build-arg DB_EMBEDDINGS_MODE=openai \
		-f docker/services/Dockerfile.db \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-latest \
		.

docker-build-db-local:
	docker build --build-arg DB_EMBEDDINGS_MODE=local \
		-f docker/services/Dockerfile.db \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-latest \
		.

# Orchestrator Service builds
docker-build-orchestrator-openai:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=openai \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-latest \
		.

docker-build-orchestrator-hf-endpoint:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=huggingface-endpoint \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-endpoint-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-endpoint-latest \
		.

docker-build-orchestrator-hf-local:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=huggingface-local \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-local-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-local-latest \
		.

docker-build-orchestrator-llama-cpu:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=cpu \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cpu-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cpu-latest \
		.

docker-build-orchestrator-llama-cuda:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=cuda \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-latest \
		.

docker-build-orchestrator-llama-rocm:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=rocm \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-rocm-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-rocm-latest \
		.

docker-build-orchestrator-llama-metal:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=metal \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-metal-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-metal-latest \
		.

# TTS Service builds
docker-build-tts-cpu:
	docker build --build-arg TTS_HARDWARE=cpu \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-latest \
		.

docker-build-tts-cuda:
	docker build --build-arg TTS_HARDWARE=cuda \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-latest \
		.

docker-build-tts-rocm:
	docker build --build-arg TTS_HARDWARE=rocm \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:rocm-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:rocm-latest \
		.

docker-build-tts-metal:
	docker build --build-arg TTS_HARDWARE=metal \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:metal-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:metal-latest \
		.

# STT Transcription Service builds
docker-build-stt-transcription-cpu:
	docker build --build-arg STT_TRANSCRIPTION_HARDWARE=cpu \
		-f docker/services/Dockerfile.transcription \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cpu-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cpu-latest \
		.

docker-build-stt-transcription-cuda:
	docker build --build-arg STT_TRANSCRIPTION_HARDWARE=cuda \
		-f docker/services/Dockerfile.transcription \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cuda-latest \
		.

# STT Wakeword Service builds
docker-build-stt-wakeword-cpu:
	docker build --build-arg STT_WAKEWORD_HARDWARE=cpu \
		-f docker/services/Dockerfile.wakeword \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cpu-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cpu-latest \
		.

docker-build-stt-wakeword-cuda:
	docker build --build-arg STT_WAKEWORD_HARDWARE=cuda \
		-f docker/services/Dockerfile.wakeword \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cuda-latest \
		.

# Other Service builds
docker-build-scheduler:
	docker build -f docker/services/Dockerfile.scheduler \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-scheduler:$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-scheduler:latest \
		.

docker-build-tooling:
	docker build -f docker/services/Dockerfile.tooling \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tooling:$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tooling:latest \
		.

docker-build-stt-audio-input:
	docker build -f docker/services/Dockerfile.audio-input \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-audio-input:$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-audio-input:latest \
		.

docker-build-stt-coordinator:
	docker build -f docker/services/Dockerfile.stt-coordinator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-coordinator:$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-coordinator:latest \
		.

# Push commands
docker-push-all:
	@echo "Pushing all service images to $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)..."
	$(MAKE) docker-push-config
	$(MAKE) docker-push-db-openai
	$(MAKE) docker-push-db-local
	$(MAKE) docker-push-orchestrator-openai
	$(MAKE) docker-push-orchestrator-hf-endpoint
	$(MAKE) docker-push-orchestrator-hf-local
	$(MAKE) docker-push-orchestrator-llama-cpu
	$(MAKE) docker-push-orchestrator-llama-cuda
	$(MAKE) docker-push-orchestrator-llama-rocm
	$(MAKE) docker-push-orchestrator-llama-metal
	$(MAKE) docker-push-tts-cpu
	$(MAKE) docker-push-tts-cuda
	$(MAKE) docker-push-tts-rocm
	$(MAKE) docker-push-tts-metal
	$(MAKE) docker-push-stt-transcription-cpu
	$(MAKE) docker-push-stt-transcription-cuda
	$(MAKE) docker-push-stt-wakeword-cpu
	$(MAKE) docker-push-stt-wakeword-cuda
	$(MAKE) docker-push-scheduler
	$(MAKE) docker-push-tooling
	$(MAKE) docker-push-stt-audio-input
	$(MAKE) docker-push-stt-coordinator

docker-push-config:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-config:$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-config:latest

docker-push-db-openai:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-latest

docker-push-db-local:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-latest

docker-push-orchestrator-openai:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-latest

docker-push-orchestrator-hf-endpoint:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-endpoint-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-endpoint-latest

docker-push-orchestrator-hf-local:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-local-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:huggingface-local-latest

docker-push-orchestrator-llama-cpu:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cpu-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cpu-latest

docker-push-orchestrator-llama-cuda:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-latest

docker-push-orchestrator-llama-rocm:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-rocm-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-rocm-latest

docker-push-orchestrator-llama-metal:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-metal-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-metal-latest

docker-push-tts-cpu:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-latest

docker-push-tts-cuda:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-latest

docker-push-tts-rocm:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:rocm-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:rocm-latest

docker-push-tts-metal:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:metal-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:metal-latest

docker-push-stt-transcription-cpu:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cpu-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cpu-latest

docker-push-stt-transcription-cuda:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cuda-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-transcription:cuda-latest

docker-push-stt-wakeword-cpu:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cpu-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cpu-latest

docker-push-stt-wakeword-cuda:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cuda-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-wakeword:cuda-latest

docker-push-scheduler:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-scheduler:$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-scheduler:latest

docker-push-tooling:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tooling:$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tooling:latest

docker-push-stt-audio-input:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-audio-input:$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-audio-input:latest

docker-push-stt-coordinator:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-coordinator:$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-stt-coordinator:latest
