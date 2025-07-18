# Aurora: Intelligent Voice Assistant for Local Automation and Productivity

[![Unit and Integration Tests](https://github.com/aurora-ai/aurora/actions/workflows/test-core.yml/badge.svg)](https://github.com/aurora-ai/aurora/actions/workflows/test-core.yml)
[![Code Coverage](https://codecov.io/gh/aurora-ai/aurora/branch/main/graph/badge.svg)](https://codecov.io/gh/aurora-ai/aurora)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Versions](https://img.shields.io/badge/python-3.9%20|%203.10%20|%203.11-blue)](https://github.com/aurora-ai/aurora)

Aurora is an intelligent voice assistant designed to enhance productivity through local, privacy-focused automation. It leverages real-time speech-to-text, a large language model (LLM), and open-source tools to provide a seamless and intuitive user experience.

**It's objective is to be the privacy-first swiss knife of assistants, allowing unprecedentedly easy extension and addition of tools for productivity, every day life and work life.**

---

## 📋 Table of Contents

- [Features](#features)
- [Installation and Usage](#installation-and-usage)
  - [🚀 Quick Start](#-quick-start)
  - [📚 Need More Details?](#-need-more-details)
  - [📦 Model Management](#-model-management)
- [Libraries and Tools](#libraries-and-tools)
- [Architecture](#architecture)
- [TODO LIST](#todo-list)
- [Long Term Vision](#long-term-vision)
- [Why Aurora?](#why-aurora)
- [Contributing](#contributing)

---

## Features

1. **Wakeword Detection**:
   - Activate the assistant with a custom wakeword (e.g., "Jarvis").
   - Offline and low-latency detection using **OpenWakeWord**.

2. **Real-Time Speech-to-Text (STT)**:
   - Convert user speech into text using **Whisper** (OpenAI's lightweight model for local processing).
   - **Ambient Transcription**: Continuous background audio transcription for day summaries with priority queue system.

3. **Large Language Model (LLM) Integration**:
   - **Multi-Provider Support**: Choose from OpenAI, HuggingFace Pipeline (local), HuggingFace Endpoint (remote), or Llama.cpp
   - **Local Models**: Use **Llama 3**, **Mistral 7B**, **Gemma 2 and 3** (quantized for efficiency) or any HuggingFace model locally
   - **Remote Models**: Access HuggingFace Inference Endpoints for cloud-based inference
   - **Structured Configuration**: Organized LLM settings with provider-specific parameter control
   - Orchestrate tool calls (e.g., OpenRecall, browser-use) using **LangChain** and **Langgraph**.

4. **Semantic Search with OpenRecall**:
   - Index and retrieve information from periodic screenshots and activities using **OpenRecall**.
   - Enable queries like, "What did I research about interfaces at 2 PM?"
   - Enrich the assistant context by adding past activities when necessary

5.~~Browser Automation:~~
   - ~~Control web browsers (e.g., open tabs, fill forms, click elements) using the **browser-use** framework.~~
   - ~~The assistant will interpret your request, deem wether it should call the browser-use or not, and finally re-structure your request so that it's carried out correctly.~~

6. **Text-to-Speech (TTS)**:
   - Generate natural-sounding audio responses using **Piper** (offline TTS).

7. **Modern User Interface**:
   - Graphical user interface with both text and voice input options
   - Dark mode and light mode support
   - Real-time status indicators for listening, processing, and speaking states
   - Message history with timestamps

7. **Local and Privacy-Focused**:
   - All processing happens locally, ensuring data privacy and security.
   - No cloud dependencies or data sharing.
   - Kinda, using OpenAI while development, but local LLMs are nativelly supported with langchain

8. **Modular Tooling and Integrations**:
   - All integrations and tools are available through *plugins* which you can activate through the envs
   - Only install dependencies for the plugins you'll want to use, keeping the sizes low
   - Easy setup, just need to activate it and fill the correct env credentials if necessary

9. **MCP (Model Context Protocol) Support**:
   - Connect to external MCP servers to extend Aurora's capabilities
   - Support for both local (stdio) and remote (HTTP) MCP servers
   - Dynamic tool loading from MCP servers with authentication support
   - Full integration with Aurora's semantic tool selection system

---

## Installation and Usage

### 🚀 Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/joaojhgs/aurora.git
   cd aurora
   ```

2. **Run the guided setup:**
   ```bash
   # Linux/macOS
   ./setup.sh
   
   # Windows  
   setup.bat
   ```
   
   The setup script will:
   - ✅ Check Python version compatibility (requires Python 3.9-3.11)
   - ✅ Detect your hardware and install optimal packages
   - ✅ Install all dependencies automatically
   - ✅ Guide you through configuration

3. **Configure your environment:**
   - Copy `.env.file` to `.env` and add any API keys you want to use
   - Modify `config.json` if needed (defaults work for most users)

4. **Run Aurora:**
   ```bash
   python main.py
   ```

### 📚 Need More Details?

- **Complete Installation Guide**: See [docs/INSTALL.md](docs/INSTALL.md) for:
  - Manual installation options
  - Advanced hardware acceleration setup
  - Troubleshooting and configuration details
  - Platform-specific instructions
  
- **Python Version Requirements**: Aurora requires Python 3.9-3.11 (Python 3.12+ causes dependency conflicts)

- **Model Management**: Aurora includes models for offline operation - see [Model Management](#-model-management) below

### 📦 Model Management

Aurora stores model files in dedicated directories at the project root:

**Chat Models** (`chat_models/`):
- Large language models in GGUF format (2-4GB each)
- Configure in `config.json`: `"llama_cpp_model_path": "chat_models/model-name.gguf"`
- Included: Gemma 2B/3B, Llama 2 7B models
- Download more from [Hugging Face GGUF models](https://huggingface.co/models?library=gguf)

**Voice Models** (`voice_models/`):
- Text-to-speech (Piper) and wake word models
- Configure in `config.json`: `"model_file_path": "/voice_models/voice-name.onnx"`
- Included: English, Portuguese voices + Jarvis wake word
- Download more from [Piper Voices](https://github.com/rhasspy/piper/blob/master/VOICES.md)

**Model Directory Features**:
- ✅ **Excluded from builds**: Large files don't bloat packages
- ✅ **Git ignored**: Models managed separately from code
- ✅ **User controlled**: Choose models based on your hardware
- ✅ **Privacy focused**: All models run locally

*See `chat_models/README.md` and `voice_models/README.md` for detailed model information.*

---

## Libraries and Tools

Aurora leverages a comprehensive stack of open-source technologies, organized by functionality to provide a complete voice assistant experience while maintaining privacy and local processing capabilities.

### 🎤 Audio Processing & Voice Recognition

- **Wake Word Detection**: [OpenWakeWord](https://github.com/dscripka/openWakeWord) - Local, offline wake word detection with low latency
- **Speech-to-Text**: [RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) - Real-time speech recognition with Whisper integration
- **STT Engine**: [faster-whisper](https://github.com/guillaumekln/faster-whisper) - Optimized Whisper implementation using CTranslate2
- **Audio Capture**: [PyAudio](https://pypi.org/project/PyAudio/) - Cross-platform audio I/O library

### 🗣️ Text-to-Speech

- **TTS Engine**: [Piper TTS](https://github.com/rhasspy/piper) - Fast, local neural text-to-speech
- **Real-time TTS**: [RealtimeTTS](https://github.com/KoljaB/RealtimeTTS) - Streaming text-to-speech output

### 🧠 Language Models & AI

- **LLM Integration**: [LangChain](https://www.langchain.com/) - Framework for LLM application development
- **Workflow Orchestration**: [LangGraph](https://langchain-ai.github.io/langgraph/) - Graph-based agent workflow management
- **Local LLM Support**: Custom `ChatLlamaCpp` implementation for local model inference
- **OpenAI Integration**: [openai](https://github.com/openai/openai-python) - OpenAI API client for cloud models
- **Model Serving**: [Ollama](https://ollama.ai/) - Local LLM serving platform
- **Embeddings**: [sentence-transformers](https://www.sbert.net/) - Local semantic embeddings generation

### 💾 Data Storage & Memory

- **Database**: [SQLite](https://www.sqlite.org/) with [aiosqlite](https://aiosqlite.omnilib.dev/) - Async local database
- **Vector Storage**: [sqlite-vec](https://github.com/asg017/sqlite-vec) - Vector similarity search in SQLite

### 🖥️ User Interface

- **GUI Framework**: [PyQt6](https://www.riverbankcomputing.com/software/pyqt/) - Modern cross-platform GUI
- **Real-time Updates**: Threaded UI with live status indicators and message history
- **Dark/Light Themes**: Adaptive UI theming support
- **Input Methods**: Both text and voice input with visual feedback

### 🔍 Semantic Search & Screen Analysis

- **OpenRecall Integration**: [OpenRecall](https://github.com/open-recall/open-recall) - Screenshot indexing and semantic search
- **OCR Engine**: [python-doctr](https://github.com/mindee/doctr) - Document text recognition
- **Screen Capture**: [mss](https://github.com/BoboTiG/python-mss) - Multi-monitor screenshot capture
- **Computer Vision**: [Pillow](https://python-pillow.org/) - Image processing and manipulation
- **Text Similarity**: [rapidfuzz](https://github.com/maxbachmann/RapidFuzz) - Fast string matching

### 🌐 Web & API Integration

- **Search Engines**: 
  - [duckduckgo-search](https://github.com/deedy5/duckduckgo_search) - Privacy-focused search (default)
  - [Brave Search API](https://brave.com/search/api/) - Brave Search integration (optional)

### 🛠️ Productivity & Business Tools

**Atlassian Integration**:
- **Jira**: [atlassian-python-api](https://github.com/atlassian-api/atlassian-python-api) - Issue tracking and project management

**Google Workspace**:
- **Gmail**: [langchain-google-community](https://github.com/langchain-ai/langchain-google) - Email management
- **Calendar**: Google Calendar API integration for scheduling and event management

**Developer Tools**:
- **GitHub**: [pygithub](https://github.com/PyGithub/PyGithub) - Repository management and automation
- **Slack**: [slack-sdk](https://github.com/slackapi/python-slack-sdk) - Team communication and notifications

### ⚙️ System & Configuration

- **Environment Management**: [python-dotenv](https://github.com/theskumar/python-dotenv) - Environment variable handling
- **Configuration**: Hybrid JSON + environment variable system with validation
- **Plugin Architecture**: Conditional dependency loading based on configuration
- **Cross-Platform**: Windows, macOS, and Linux support with platform-specific optimizations
- **CUDA Support**: Optional GPU acceleration for TTS, STT, and OCR components

### 📦 Development & Build Tools

- **Package Management**: Standard pip with `requirements.txt`
- **Code Quality**: Type hints with [typing-extensions](https://github.com/python/typing_extensions)
- **Progress Tracking**: [tqdm](https://github.com/tqdm/tqdm) - Progress bars for long operations
- **Logging**: [coloredlogs](https://coloredlogs.readthedocs.io/) - Enhanced logging with colors
- **Terminal UI**: [halo](https://github.com/manrajgrover/halo) - Elegant terminal spinners

### 🔒 Privacy & Security

- **Local Processing**: All core functionality runs locally without cloud dependencies
- **Optional Cloud**: OpenAI integration available but not required
- **Credential Management**: Secure environment variable storage for API keys
- **Data Privacy**: No telemetry or data collection; all processing remains on-device
- **Modular Plugins**: Only load and install dependencies for features you actually use

This comprehensive technology stack ensures Aurora provides enterprise-grade functionality while maintaining user privacy and system performance through intelligent local processing and selective cloud integration.

---

## Architecture

Aurora is built with a modular, plugin-based architecture that prioritizes privacy, extensibility, and local processing. The system follows a clear data flow from voice input to intelligent response generation, with each component designed to be independently configurable and replaceable.

### System Overview

```mermaid
graph TB
    %% Entry Points
    Start([Main Entry Point<br/>main.py]) --> UI_Check{UI Mode?}
    UI_Check -->|Yes| UI[PyQt6 UI<br/>aurora_ui.py]
    UI_Check -->|No| STT_Direct[Direct STT Processing]
    
    %% Configuration System
    Config[Configuration Manager<br/>config_manager.py] --> Schema[JSON Schema<br/>Validation]
    Config --> EnvVars[Environment Variables<br/>.env file]
    Config --> ConfigJSON[Configuration File<br/>config.json]
    
    %% Audio Processing Chain
    UI --> AudioInput[Audio Input]
    STT_Direct --> AudioInput
    AudioInput --> WakeWord[Wake Word Detection<br/>OpenWakeWord]
    WakeWord --> STT[Speech-to-Text<br/>audio_recorder.py<br/>Whisper/RealtimeSTT]
    
    %% Core LLM Processing
    STT --> Graph[LangGraph Orchestrator<br/>graph.py]
    Graph --> LLM[Large Language Model<br/>Llama 3 / Mistral 7B]
    
    %% Plugin System & Tools
    Graph --> ToolLoader[Dynamic Tool Loader<br/>tools.py]
    ToolLoader --> PluginCheck{Plugin<br/>Enabled?}
    
    %% Available Tools/Plugins
    PluginCheck -->|OpenRecall| OpenRecall[Screenshot Indexing<br/>& Semantic Search]
    PluginCheck -->|Browser| Browser[Browser Automation<br/>browser-use]
    PluginCheck -->|Productivity| Productivity[Jira, Slack, Gmail<br/>Calendar, GitHub]
    PluginCheck -->|Custom| CustomTools[Custom Tools<br/>& Integrations]
    
    %% Memory & Storage Systems
    Graph --> Memory[Memory Store<br/>memory_store.py<br/>Vector Embeddings]
    Graph --> Database[Database Manager<br/>database_manager.py<br/>Message History]
    
    %% Response Generation
    LLM --> ResponseGen[Response Generation]
    OpenRecall --> ResponseGen
    Browser --> ResponseGen
    Productivity --> ResponseGen
    CustomTools --> ResponseGen
    Memory --> ResponseGen
    
    %% Output Systems
    ResponseGen --> TTS[Text-to-Speech<br/>tts.py<br/>Piper Engine]
    ResponseGen --> UIUpdate[UI Response Display]
    
    TTS --> AudioOut[Audio Output]
    UIUpdate --> UI
    
    %% Data Persistence
    Database --> MessageStore[(SQLite Database<br/>Conversation History)]
    Memory --> VectorStore[(Vector Database<br/>Embeddings & Context)]
    
    %% Configuration Flow
    Config -.-> Graph
    Config -.-> STT
    Config -.-> TTS
    Config -.-> ToolLoader
    Config -.-> UI
    
    %% Styling
    classDef entryPoint fill:#e1f5fe
    classDef processing fill:#f3e5f5
    classDef storage fill:#e8f5e8
    classDef plugin fill:#fff3e0
    classDef output fill:#fce4ec
    
    class Start,UI_Check entryPoint
    class STT,Graph,LLM,ResponseGen processing
    class Database,Memory,MessageStore,VectorStore storage
    class OpenRecall,Browser,Productivity,CustomTools,ToolLoader plugin
    class TTS,AudioOut,UIUpdate output
```

### Key Architectural Components

#### 1. **Configuration Management**
- **Centralized Configuration**: The `config_manager.py` handles all system settings through JSON schema validation
- **Hybrid Configuration**: Combines `config.json` for structured settings and `.env` for sensitive credentials
- **Plugin Activation**: Configuration-driven plugin system that loads only required dependencies

#### 2. **Audio Processing Pipeline**
- **Wake Word Detection**: Always-listening background service using OpenWakeWord
- **Speech-to-Text**: Real-time transcription with Whisper through RealtimeTTS
- **Threaded Architecture**: Non-blocking audio processing to maintain UI responsiveness

#### 3. **LangGraph Orchestration**
- **Intelligent Routing**: LangGraph coordinates between LLM reasoning and tool execution
- **Dynamic Tool Selection**: RAG-based tool matching using vector embeddings of tool descriptions
- **Context Management**: Maintains conversation context and integrates historical data

![Aurora System Architecture](graph.png)

#### 4. **Plugin System**
- **Modular Design**: Each integration is a separate plugin with independent dependencies
- **Conditional Loading**: Plugins are loaded only when enabled in configuration
- **Extensible Architecture**: New tools can be added without modifying core system

#### 5. **Memory & Storage**
- **Vector Storage**: Embeddings-based memory for semantic search and context retrieval
- **Message Persistence**: SQLite database for conversation history and system state
- **Efficient Retrieval**: Optimized queries for both recent context and long-term memory

#### 6. **User Interface**
- **Dual Mode Operation**: Supports both GUI (PyQt6) and headless command-line operation
- **Real-time Feedback**: Visual indicators for system state (listening, processing, speaking)
- **Flexible Input**: Both voice and text input methods supported

### Data Flow

1. **Input Processing**: Voice input → Wake word detection → Speech-to-text transcription
2. **Intent Understanding**: Text → LangGraph → LLM analysis → Tool selection
3. **Action Execution**: Selected tools execute with context from memory and database
4. **Response Generation**: Tool results → LLM synthesis → Natural language response
5. **Output Delivery**: Response → Text-to-speech → Audio output + UI display
6. **Persistence**: Conversation and context saved to database and vector store

This architecture ensures Aurora remains privacy-focused (all processing local), extensible (plugin system), and efficient (threaded processing with intelligent caching).

---

## TODO LIST
- [ ] Update all current tools to improve it further from MVP
   - [ ] Add OmniParserV2 and Magma using llama.cpp server to allow local usage and better interactions with the screenshots and openrecall
   - [ ] Improve openrecall search feature
      - [] Add to the embbedings a simple AI generated description of the screenshot besides the OCR (using Magma)
      - [ ] Potentially replace openrecall doctr OCR with OmniParserV2
      - [ ] Upgrade openrecall tool to be able to filter by date as well "Jarvis, what have I done today?"
   - [ ] Update openrecall code to be able to detect active window titles on linux as well
   - [ ] Create custom tool using OmniParser and Magma for UI interaction (Self-Operating-Computer has been removed since it's not reliable)
- [x] Add productivity tools
   - [x] Jira
   - [x] Slack (Setup requires creating an app, interaction requires specifying channel ids, potentially too cumbersome)
   - [x] Github (Setup is a bit too cumbersome, needs creating a new app and specifying only one repo that you want to interact with)
   - [x] Calendar
   - [x] Gmail
- [x] Upgrade logic that defines which tools are available to the coordinator agent
   - [x] Use tool descriptions to RAG match what are the possible best tools for the user request
      (This will allow for an ever increasing number of tools without compromising the context length, specially for local LLMs)
- [ ] Turn all available langchain tools into an [MCP Server](https://github.com/langchain-ai/langchain-mcp-adapters) to allow usage in other interfaces (such as cursor)
- [x] **MCP (Model Context Protocol) Integration**
   - [x] Add support for connecting to external MCP servers
   - [x] Support both local (stdio) and remote (HTTP) MCP servers
   - [x] Dynamic tool loading from MCP servers into Aurora's tool system
   - [x] Authentication support for remote MCP servers
   - [x] Example MCP servers (math, weather) with documentation
   - [x] Full integration with Aurora's RAG-based tool selection

# Long term vision:

- [ ] Turn Aurora into a server-client architecture
   - [ ] Allow server to receive and process audio using the RealtimeSTT and stream back the TTS audio to the client
   - [ ] Allow clients to have it's own local tools that can be called by the server (either custom framework or using MCP)
   - [ ] Create code for low-cost physical clients such as ESP32

The Idea here is to allow for low-cost and easily built interfaces that you can interact with your Jarvis across your home and private network.

Also by allowing client side tools aside from the ones we can use on the Desktop, we allow the assistant to potentially control real world appliances, or even multiple devices/desktops.

- [ ] Integrations with Home Assistant
   - [ ] Allow for tool calling with smart home appliances

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

## Why Aurora?
Aurora redefines how users interact with their computers by combining voice-based interfaces with powerful local automation tools. It enhances productivity without compromising privacy, offering a seamless blend of natural language processing, semantic search, and browser automation. By leveraging open-source tools, Aurora ensures transparency and customization, making it a versatile assistant for both personal and professional use.

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

### Need Help?

If you have questions or need help, feel free to:
- Open an issue with your question
- Join our community discussions
- Check the existing documentation in the `/docs` directory