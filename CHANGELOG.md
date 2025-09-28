# Changelog

All notable changes to Aurora Voice Assistant will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows [Conventional Commits](https://www.conventionalcommits.org/) for automated changelog generation.

## [Unreleased]

<!-- 
This changelog is automatically updated by python-semantic-release.
Manual edits will be preserved when new releases are added.
-->

## How to Contribute

Aurora follows [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

### Commit Types

- **feat**: New features and enhancements
- **fix**: Bug fixes and corrections  
- **docs**: Documentation improvements
- **style**: Code formatting changes
- **refactor**: Code improvements without feature changes
- **perf**: Performance improvements
- **test**: Test changes
- **build**: Build system or dependency changes
- **ci**: CI configuration changes
- **chore**: Other changes that don't modify src or test files

### Scopes (optional)

- **speech**: Speech recognition and processing
- **tts**: Text-to-speech functionality  
- **llm**: Language model integration
- **ui**: User interface
- **config**: Configuration management
- **database**: Database operations
- **scheduler**: Task scheduling
- **tools**: Tool integrations (Jira, Slack, etc.)

### Examples

```
feat(speech): add wake word detection
fix(llm): resolve memory leak in chat processing
docs: update installation guide
perf(tts): optimize voice model loading
```

### Breaking Changes

For breaking changes, add `!` after the type/scope or include `BREAKING CHANGE:` in the footer:

```
feat(api)!: change authentication method
```

or

```
feat(api): change authentication method

BREAKING CHANGE: API now requires OAuth2 instead of API keys
```
