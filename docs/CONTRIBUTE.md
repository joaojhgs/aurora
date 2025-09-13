## Testing & Development

### Test Categories

Aurora has a comprehensive testing suite divided into several categories:

1. **Unit Tests** - Test individual components in isolation
   - Location: `tests/unit/`

2. **Integration Tests** - Test interactions between components
   - Location: `tests/integration/`

3. **End-to-End Tests** - Test complete user workflows
   - Location: `tests/e2e/`

4. **Performance Tests** - Test system performance
   - Location: `tests/performance/`

### Running Tests

Install test dependencies:
```bash
pip install -r requirements-test.txt
```

Run all tests (except performance tests):
```bash
pytest
```

Generate a test coverage report:
```bash
pytest --cov=app --cov-report=html
```

For more details, see [Testing Guide](tests/README.md).

### CI/CD Pipeline

Aurora has several GitHub Actions workflows:

1. **Unit and Integration Tests** - Run on every push
2. **End-to-End Tests** - Run on pull requests
3. **Performance Tests** - Run on schedule and manually
4. **Full Test Suite** - Run on releases and manually
5. **Lint and Static Analysis** - Run on every push

[![Code Coverage](https://codecov.io/gh/aurora-ai/aurora/branch/main/graph/badge.svg)](https://codecov.io/gh/aurora-ai/aurora)

## Contributing

Contributions to Aurora are welcome! Here's how you can contribute:

### Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/aurora.git
   cd aurora
   ```
3. **Set up the development environment**:
   ```bash
   # Run the setup script and choose option 3 (Development)
   # Linux/macOS:
   ./setup.sh
   # Windows:
   setup.bat
   
   # Activate the virtual environment (if not using the run.sh/run.bat scripts)
   # Linux/macOS:
   source venv/bin/activate
   # Windows:
   venv\Scripts\activate
   ```

### Development Workflow

1. **Create a branch** for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Set up development environment** with pre-commit hooks:
   ```bash
   # Run the setup script and choose the "Development" feature level (option 3)
   # This will install all development dependencies and pre-commit hooks
   ./setup.sh
   # or on Windows
   setup.bat
   ```

3. **Make your changes** and ensure they follow the project's code style:
   ```bash
   # Run auto-formatting (black + isort)
   make format
   
   # Run all code quality checks (lint + typing)
   make check
   
   # Or run individual checks:
   make lint      # Run flake8 linting
   make typing    # Run mypy type checking
   ```

4. **Write tests** for your changes:
   - Unit tests for new functionality
   - Integration tests for component interactions
   - Update existing tests as needed

4. **Run tests** to verify your changes:
   ```bash
   # Run all tests (excluding performance tests)
   make test
   
   # Run specific test types
   make unit        # Run unit tests only
   make integration # Run integration tests only
   
   # Generate test coverage report
   make coverage
   ```

5. **Commit your changes** with a clear message:
   ```bash
   git commit -m "Add feature: your feature description"
   ```

6. **Push your branch** to GitHub:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Submit a pull request** from your fork to the main repository

### Pull Request Guidelines

- Ensure your code passes all tests and CI checks
- Include tests for any new functionality
- Update documentation as needed
- Follow the existing code style and conventions
- Keep changes focused on a single issue/feature

The CI pipeline will automatically run tests on your pull request, including unit tests, integration tests, and linting.