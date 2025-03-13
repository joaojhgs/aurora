# Aurora: Intelligent Voice Assistant for Local Automation and Productivity

Aurora is an intelligent voice assistant designed to enhance productivity through local, privacy-focused automation. It leverages real-time speech-to-text, a large language model (LLM), and open-source tools to provide a seamless and intuitive user experience. Aurora integrates with tools like **OpenRecall** for semantic search of daily activities and **browser-use** for browser automation, enabling users to interact with their computer in a hands-free, voice-driven manner.

---

## Planned Features

1. **Wakeword Detection**:
   - Activate the assistant with a custom wakeword (e.g., "Aurora").
   - Offline and low-latency detection using **OpenWakeWord**.

2. **Real-Time Speech-to-Text (STT)**:
   - Convert user speech into text using **Whisper** (OpenAI's lightweight model for local processing).

3. **Large Language Model (LLM) Integration**:
   - Use **Llama 3** or **Mistral 7B** (quantized for efficiency) to process user queries and generate responses.
   - Orchestrate tool calls (e.g., OpenRecall, browser-use) using **LangChain** and **Langgraph**.

4. **Semantic Search with OpenRecall**:
   - Index and retrieve information from periodic screenshots and activities using **OpenRecall**.
   - Enable queries like, "What did I research about interfaces at 2 PM?"
   - Enrich the assistant context by adding past activities when necessary

5. **Browser Automation**:
   - Control web browsers (e.g., open tabs, fill forms, click elements) using the **browser-use** framework.
   - The assistant will interpret your request, deem wether it should call the browser-use or not, and finally re-structure your request so that it's carried out correctly.

6. **Text-to-Speech (TTS)**:
   - Generate natural-sounding audio responses using **Piper** (offline TTS).

7. **Local and Privacy-Focused**:
   - All processing happens locally, ensuring data privacy and security.
   - No cloud dependencies or data sharing.
   - Kinda, using OpenAI while development, but local LLMs are nativelly supported with langchain

---

## Libraries and Tools

- **Wakeword Detection**: [Openwakeword](https://github.com/dscripka/openWakeWord)
- **Speech-to-Text**: [RealtimeTTS](https://github.com/KoljaB/RealtimeTTS) (Uses whisper under the hood)
- **Large Language Model**: [Llama 3](https://ai.meta.com/llama/) or [Mistral 7B](https://mistral.ai/)
- **Tool Orchestration**: [LangChain](https://www.langchain.com/) and [Langgraph](https://langchain-ai.github.io/langgraph/)
- **Semantic Search**: [OpenRecall](https://github.com/open-recall/open-recall)
- **Browser Automation**: [browser-use](https://github.com/browser-use/browser-use)
- **Text-to-Speech**: [Piper](https://github.com/rhasspy/piper)
- **Audio Processing**: [PyAudio](https://pypi.org/project/PyAudio/) or [SoundDevice](https://python-sounddevice.readthedocs.io/)

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
- [ ] Add productivity tools
   - [x] Jira
   - [ ] Slack
   - [x] Github
   - [x] Calendar
   - [x] Gmail
- [ ] Upgrade logic that defines which tools are available to the coordinator agent
   - [ ] Use tool descriptions to RAG match what are the possible best tools for the user request
      (This will allow for an ever increasing number of tools without compromising the context length, specially for local LLMs)
- [ ] Turn all available langchain tools into an [MCP Server](https://github.com/langchain-ai/langchain-mcp-adapters) to allow usage in other interfaces (such as cursor)

# Long term vision:

- [ ] Turn Aurora into a server-client architecture
   - [ ] Allow server to receive and process audio using the RealtimeSTT and stream back the TTS audio to the client
   - [ ] Allow clients to have it's own local tools that can be called by the server (either custom framework or using MCP)
   - [ ] Create code for low-cost physical clients such as ESP32

The Idea here is to allow for low-cost and easily built interfaces that you can interact with your Jarvis across your home and private network.

Also by allowing client side tools aside from the ones we can use on the Desktop, we allow the assistant to potentially control real world appliances, or even multiple devices/desktops.

- [ ] Integrations with Home Assistant
   - [ ] Allow for tool calling with smart home appliances

## Installation and Usage

1. Clone the repository:
   ```bash
   git clone https://github.com/joaojhgs/aurora.git
   cd aurora
   ```

Install dependencies:

Install PortAudio:

```bash
sudo apt install portaudio19-dev
```
Or

```bash
brew install portaudio
brew link portaudio
```

Install all Lib requirements:
```bash
pip install -r requirements.txt
```

Optionally install cuda libraries for faster inference:
```bash
sudo apt-get install libcudnn9-cuda-11
pip install torch==2.6.0+cu118 torchaudio==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu118
# Install lib for PiperTTS with CUDA
pip install onnxruntime-gpu
```

Run the assistant:

```bash
python aurora.py
```

Why Aurora?
Aurora redefines how users interact with their computers by combining voice-based interfaces with powerful local automation tools. It enhances productivity without compromising privacy, offering a seamless blend of natural language processing, semantic search, and browser automation. By leveraging open-source tools, Aurora ensures transparency and customization, making it a versatile assistant for both personal and professional use.

Contributing
Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.