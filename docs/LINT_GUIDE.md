# Aurora Linting Guide

This guide documents the linting and code formatting standards for the Aurora project.

## Code Style Tools

Aurora uses the following tools to enforce code quality and consistency:

1. **Black** - Code formatter that enforces a consistent style
2. **Flake8** - Linter that checks for syntax and style errors 
3. **isort** - Import sorter that organizes imports consistently
4. **MyPy** - Static type checker that validates type hints
5. **pre-commit** - Framework for managing git hooks to run these tools automatically

## Pre-commit Setup

We use pre-commit hooks to automatically check code before committing. This ensures that all code follows our style guidelines and passes basic quality checks.

### Installation

Pre-commit hooks are automatically installed when you run the setup script with the development feature level:

```bash
# Run the setup script and choose "Development" feature level (option 3)
./setup.sh
```

You can also install pre-commit hooks manually:

```bash
# Install pre-commit
pip install pre-commit

# Install the git hooks
pre-commit install

# Update to the latest versions
pre-commit autoupdate
```

Once installed, pre-commit will automatically run whenever you commit code.

### Manual Usage

You can also run the checks manually:

```bash
# Check all files
pre-commit run --all-files

# Check staged files only
pre-commit run

# Run a specific hook
pre-commit run black --all-files
```

## Code Style Guidelines

### General

- Maximum line length: 100 characters
- Use 4 spaces for indentation (no tabs)
- Follow PEP 8 style guidelines with modifications as specified in our tools

### Imports

- Group imports in the following order:
  1. Standard library imports
  2. Related third-party imports
  3. Local application/library specific imports
- Use absolute imports whenever possible

### Type Annotations

- All new code should include proper type annotations
- Use `Optional[T]` instead of `T | None` for backward compatibility
- Use appropriate collection types (e.g., `List[str]` instead of just `list`)

### Docstrings

- Use docstrings for all public modules, functions, classes, and methods
- Follow the Google style for docstrings
- Include type information in docstrings when the function signature lacks annotations

## CI/CD Integration

The linting tools are also run as part of the CI/CD pipeline. The workflow file `.github/workflows/lint.yml` handles this integration.

## Editor Integration

For a smoother development experience, consider integrating these tools with your editor:

### VS Code

Install the following extensions:
- Python (Microsoft)
- Black Formatter
- Flake8
- isort
- mypy Type Checker

### PyCharm

Configure the following tools in Settings → Tools:
- External Tools → Black
- External Tools → isort
- Python Integrated Tools → Flake8
- Python Integrated Tools → mypy
