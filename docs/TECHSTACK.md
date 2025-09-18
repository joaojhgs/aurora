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
