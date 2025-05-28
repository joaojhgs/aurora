# Aurora: Intelligent Voice Assistant for Local Automation and Productivity

Aurora is an intelligent voice assistant designed to enhance productivity through local, privacy-focused automation. It leverages real-time speech-to-text, a large language model (LLM), and open-source tools to provide a seamless and intuitive user experience. Aurora integrates with tools like **OpenRecall** for semantic search of daily activities and **browser-use** for browser automation, enabling users to interact with their computer in a hands-free, voice-driven manner.

---

## Features

1. **Wakeword Detection**:
   - Activate the assistant with a custom wakeword (e.g., "Jarvis").
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

---

## Libraries and Tools

- **Wakeword Detection**: [Openwakeword](https://github.com/dscripka/openWakeWord)
- **Speech-to-Text**: [RealtimeTTS](https://github.com/KoljaB/RealtimeTTS) (Uses whisper under the hood)
- **Large Language Model**: [Llama 3](https://ai.meta.com/llama/) or [Mistral 7B](https://mistral.ai/)
- **Tool Orchestration**: [LangChain](https://www.langchain.com/) and [Langgraph](https://langchain-ai.github.io/langgraph/)
- **Semantic Timeline Search**: [OpenRecall](https://github.com/open-recall/open-recall)
- **Browser Automation**: [browser-use](https://github.com/browser-use/browser-use) (Coming soon)
- **Text-to-Speech**: [Piper](https://github.com/rhasspy/piper)
- **Audio Processing**: [PyAudio](https://pypi.org/project/PyAudio/)

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

#### 1. Clone the repository:
   ```bash
   git clone https://github.com/joaojhgs/aurora.git
   cd aurora
   ```

#### 2. Install dependencies:

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

**CUDA 11.8**
```bash
sudo apt-get install libcudnn9-cuda-11
pip install torch==2.6.0+cu118 torchaudio==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu118
# Install lib for PiperTTS with CUDA
pip install onnxruntime-gpu
```

**CUDA 12.4 (Recommended)**
```bash
sudo apt-get install libcudnn9-cuda-12
pip install torch==2.6.0+cu124 torchaudio==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
# Install lib for PiperTTS with CUDA
pip install onnxruntime-gpu
```

#### 3. Initial Configuration

Aurora uses a hybrid configuration system with both `config.json` and `.env` files:

##### 3.1 Configuration Files Setup

**Main Configuration (`config.json`)**:
- Most settings are now managed through the `config.json` file
- Includes UI settings, LLM models, speech settings, CUDA options, and plugin configurations
- Validated with JSON schema to prevent configuration errors
- Falls back to safe defaults if validation fails

**Environment Variables (`.env`)**:
- Clone the `.env.file` and rename it to `.env` in the root directory
- Contains development settings and configuration for third party software that works with envs such as:
  - `OPENAI_API_KEY` - Your OpenAI API key for embeddings and chat models (if you decide to use any)
  - Langsmith logging and tracing for development

**This will eventually be improved and consolidated** 

##### 3.2 Configuration Overview

* Most configurations come with defaults that work out of the box for English language
* CUDA is turned off by default, fine control is available in `config.json`
* Currently supports OpenAI and LLAMA-CPP for the main LLM
* Embeddings support both local (HuggingFace) and OpenAI options
* Set only one LLM model: either `openai_chat_model` or `llama_cpp_model_path` in `config.json`

**Key Configuration Sections in `config.json`:**
- `ui`: Interface settings (activation, dark mode, debug mode)
- `llm`: Language model configuration (local or OpenAI models)
- `embeddings`: Choose between local or OpenAI embeddings
- `speech_to_text`: STT language, detection settings, noise reduction
- `text_to_speech`: Voice model paths, sample rates, Piper configuration
- `cuda`: Fine-grained CUDA acceleration control for different components
- `plugins`: Enable/disable and configure various productivity integrations
- `google`: Google services credentials configuration

**Environment Variables (`.env`) contain:**
- `OPENAI_API_KEY`: Required for OpenAI models and embeddings
- Plugin API keys: `JIRA_API_TOKEN`, `BRAVE_API_KEY`, `SLACK_USER_TOKEN`, etc.
- GitHub app credentials: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
- Service account files: `GOOGLE_CREDENTIALS_FILE`

##### 3.3 Running Local Models
If you want to run local models with LLAMA-CPP, you'll have to install some aditional dependencies as follows:

Below are some common backends, their build commands and any additional environment variables required.

<details open>
<summary>OpenBLAS (CPU)</summary>

To install with OpenBLAS, set the `GGML_BLAS` and `GGML_BLAS_VENDOR` environment variables before installing:

```bash
CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS" pip install llama-cpp-python
```
</details>

<details>
<summary>CUDA (GPU)</summary>

**CUDA 12.4 (Recommended)**

Official support for pre-built wheels (up to version 3.4, supports gemma2)
```bash
python -m pip install llama-cpp-python --no-cache-dir --prefer-binary --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cu124/
```
Model option: [Gemma-2-2B-Q6](https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/blob/main/gemma-2-2b-it-Q6_K_L.gguf)

Unnoficial support for pre-built wheels (up to version 3.8, supports gemma3 non-multi-modal)
```bash
python -m pip install https://github.com/oobabooga/llama-cpp-python-cuBLAS-wheels/releases/download/textgen-webui/llama_cpp_python_cuda-0.3.8+cu124-cp311-cp311-linux_x86_64.whl
```
Model options:

[Gemma-3-4B-IT-Q8](https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q8_K.gguf?download=true)
**CUDA 11.8**
```bash
python -m pip install llama-cpp-python --prefer-binary --extra-index-url=https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu118
```
(Doesn't support recent models like gemma due to version support limitation)
Model option: [LLAMA2-7B-Q4](https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/blob/main/llama-2-7b-chat.Q4_K_M.gguf)

</details>

You can find more backend instalations to run your models at the original `llama-cpp-python` [repository](https://github.com/abetlen/llama-cpp-python?tab=readme-ov-file#supported-backends).

#### 4. Configuration Validation

Aurora automatically validates your `config.json` file against a JSON schema when starting up:
- Invalid configurations automatically fall back to safe defaults
- Configuration errors are logged for easy debugging
- Runtime validation prevents invalid configuration changes
- You can validate your current config anytime using the config manager

#### 5. Run the assistant:

```bash
python main.py
```

## UI Usage

Aurora provides both voice and text interaction:

1. **Voice Input**:
   - Say the wake word "Jarvis" to activate voice recognition
   - Speak your command or query
   - The UI status will update to show "Listening", "Processing", and "Speaking" states

2. **Text Input**:
   - Type your message in the text box
   - Press Enter to send (or use Shift+Enter for a new line)
   - Click the "Send" button

3. **UI Controls**:
   - Use the "Stop Speaking" button to stop the assistant's voice output
   - Use the "Toggle Dark Mode" button to switch between light and dark themes

All interactions and responses are displayed in the message history with timestamps.

## Why Aurora?
Aurora redefines how users interact with their computers by combining voice-based interfaces with powerful local automation tools. It enhances productivity without compromising privacy, offering a seamless blend of natural language processing, semantic search, and browser automation. By leveraging open-source tools, Aurora ensures transparency and customization, making it a versatile assistant for both personal and professional use.

Contributing
Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.