# Changelog

All notable changes to Aurora Voice Assistant will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows [Conventional Commits](https://www.conventionalcommits.org/) for automated changelog generation.

<!-- 
This changelog is automatically updated by python-semantic-release.
Manual edits will be preserved when new releases are added.
-->

## [Unreleased]

## [1.0.0] - 2024-09-28

### 🚀 Features
- Initial Aurora Voice Assistant release with comprehensive functionality
- Real-time speech-to-text with wake word detection
- LangGraph-based AI agent orchestration with tool calling
- Text-to-speech with Piper TTS engine
- Memory system for persistent context
- Screen capture and OCR capabilities
- Brave search integration
- OpenRecall integration for screen activity tracking

### 🐛 Bug Fixes
- fix: use PAT for everything
- fix: use PAT for release permission  
- fix: versioning
- fix(ci): correct semantic-release configuration format and update action version
- fix: add pre commit hooks and commitzen to setup for devs
- fix: release build
- fix: make TTS work properly
- fix: create overriden piper engine class to fix lib bug
- fix: openrecall dependencies and make it work with jarvis
- fix: make open recall tool work, remove embeddings from tuple to not overflow with tokens
- fix: refactor the graph to separate graph building from agents

### 🏗️ Build System
- ci: replace manual semantic-release CLI with official GitHub Action
- Add comprehensive GitHub Actions workflows for testing and release
- Set up automated release workflow with AI-generated summaries
- Configure pre-commit hooks and development environment setup

### 📚 Documentation
- add: initial readme
- fix: aurora readme
- Add comprehensive setup and installation documentation
