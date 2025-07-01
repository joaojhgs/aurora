# Aurora Voice Assistant - Makefile
# Simple commands for common development tasks

.PHONY: help setup lint test format check coverage clean

# Default target when just running 'make'
help:
	@echo "Aurora Development Commands:"
	@echo "------------------------"
	@echo "make setup       - Set up development environment"
	@echo "make lint        - Run linting on all files (flake8)"
	@echo "make format      - Run auto-formatting (black + isort)"
	@echo "make check       - Run all checks (lint + typing)"
	@echo "make test        - Run all tests"
	@echo "make unit        - Run unit tests only"
	@echo "make integration - Run integration tests only"
	@echo "make coverage    - Generate test coverage report"
	@echo "make clean       - Remove temporary files"

# Setup development environment
setup:
	@echo "Setting up development environment..."
	./setup.sh

# Run linting checks
lint:
	@echo "Running linting checks..."
	black --check app tests
	flake8 app tests scripts

# Run auto-formatting
format:
	@echo "Running auto-formatting..."
	black app tests scripts --line-length=150
	isort app tests scripts
	autopep8 --in-place --aggressive --aggressive --max-line-length=150 --recursive .

# Run type checking
typing:
	@echo "Running type checking..."
	mypy --explicit-package-bases app tests

# Run all checks
check:
	@echo "Running all code quality checks..."
	black --check app tests
	flake8 app tests scripts
	# mypy --explicit-package-bases app tests scripts

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
