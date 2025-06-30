#!/bin/bash
# Aurora Voice Assistant - User-Friendly Setup Script
# 
# This script provides a simplified, guided installation experience
# for Aurora Voice Assistant with clear choices and configuration

set -e

echo "🌟 Aurora Voice Assistant Setup"
echo "================================"
echo "This script will help you install Aurora with the right"
echo "configuration for your needs and hardware."
echo ""

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
    echo "🐧 Detected: Linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
    echo "🍎 Detected: macOS"
else
    echo "❌ Unsupported OS: $OSTYPE"
    exit 1
fi

# Install system dependencies
echo ""
echo "🔧 Installing system dependencies..."
if [[ "$OS" == "linux" ]]; then
    sudo apt update
    sudo apt install -y portaudio19-dev python3-pip python3-venv python3-dev gcc
elif [[ "$OS" == "macos" ]]; then
    if ! command -v brew &> /dev/null; then
        echo "❌ Homebrew not found. Please install: https://brew.sh/"
        exit 1
    fi
    brew install portaudio
fi

# Check Python version
echo ""
echo "🐍 Checking Python version..."
PYTHON_VERSION=$(python3 -c "import sys; print('.'.join(map(str, sys.version_info[:2])))")
PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)

echo "🔍 Detected Python $PYTHON_VERSION"

# Check if Python version is <= 3.11
if [ "$PYTHON_MAJOR" -gt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -gt 11 ]); then
    echo "❌ ERROR: Python $PYTHON_VERSION detected"
    echo "   Aurora requires Python 3.11 or earlier due to dependency compatibility."
    echo "   Python 3.12+ causes issues with some audio and ML dependencies."
    echo ""
    echo "🔧 Please install Python 3.11 or use a version manager like pyenv:"
    echo "   # Using pyenv (recommended):"
    echo "   pyenv install 3.11.9"
    echo "   pyenv local 3.11.9"
    echo ""
    echo "   # Or using apt (Ubuntu/Debian):"
    echo "   sudo apt install python3.11 python3.11-venv python3.11-dev"
    echo "   # Then run this script with: python3.11 setup.sh"
    echo ""
    exit 1
fi

echo "✅ Python version $PYTHON_VERSION is compatible"

# Create virtual environment
echo ""
echo "🐍 Setting up Python environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "✅ Virtual environment created"
else
    echo "📁 Virtual environment already exists"
fi

# Activate virtual environment
source venv/bin/activate

# Upgrade pip
echo "📦 Upgrading pip..."
pip install --upgrade pip

echo ""
echo "=================================================================="
echo "🤖 LLM PROVIDER SETUP"
echo "=================================================================="
echo ""
echo "Aurora can use different AI providers. Choose what works best for you:"
echo ""
echo "🔴 THIRD-PARTY PROVIDERS (Recommended for beginners)"
echo "   ✅ Easy setup with just API keys"
echo "   ✅ High-quality models (GPT-4, Claude, etc.)"
echo "   ✅ No hardware requirements"
echo "   ❌ Requires internet connection"
echo "   ❌ Costs per API call"
echo ""
echo "🟢 LOCAL MODELS (Privacy-focused)"
echo "   ✅ Complete privacy - runs offline"
echo "   ✅ No ongoing costs"
echo "   ✅ Works without internet"
echo "   ❌ Requires decent hardware"
echo "   ❌ More complex setup"
echo ""

while true; do
    read -p "Choose provider type (third-party/local): " provider_choice || provider_choice=""
    case $provider_choice in
        [Tt]hird-party|[Tt]|1|third-party)
            PROVIDER_TYPE="third-party"
            break
            ;;
        [Ll]ocal|[Ll]|2|local)
            PROVIDER_TYPE="local"
            break
            ;;
        "")
            echo "Please enter 'third-party' or 'local'"
            ;;
        *)
            echo "Please enter 'third-party' or 'local'"
            ;;
    esac
done

echo ""
echo "=================================================================="
echo "📦 FEATURE LEVEL SETUP"
echo "=================================================================="
echo ""
echo "Choose what features you want:"
echo "1) Core - Essential features only (voice assistant, basic commands)"
echo "2) Full - All features (UI, integrations, productivity tools)"
echo "3) Development - All features + development tools"
echo ""

while true; do
    read -p "Choose feature level [1-3]: " feature_choice || feature_choice=""
    case $feature_choice in
        1)
            FEATURE_LEVEL="core"
            break
            ;;
        2)
            FEATURE_LEVEL="full"
            break
            ;;
        3)
            FEATURE_LEVEL="dev"
            break
            ;;
        "")
            echo "Please enter 1, 2, or 3"
            ;;
        *)
            echo "Please enter 1, 2, or 3"
            ;;
    esac
done

# Handle third-party provider setup
if [[ "$PROVIDER_TYPE" == "third-party" ]]; then
    echo ""
    echo "=================================================================="
    echo "🔑 THIRD-PARTY PROVIDER CONFIGURATION"
    echo "=================================================================="
    
    # Install dependencies
    if [[ "$FEATURE_LEVEL" == "core" ]]; then
        echo "📦 Installing core third-party dependencies..."
        pip install -e .[third-party]
    elif [[ "$FEATURE_LEVEL" == "full" ]]; then
        echo "📦 Installing full third-party dependencies..."
        pip install -e .[third-party-full]
    else
        echo "📦 Installing development third-party dependencies..."
        pip install -e .[dev-third-party]
    fi
    
    echo ""
    echo "🔑 API Key Setup"
    echo "=================="
    echo ""
    echo "You'll need API keys from AI providers. You can set these up now"
    echo "or configure them later in the config.json file."
    echo ""
    
    # OpenAI API key
    read -p "Enter OpenAI API key (press Enter to skip): " openai_key || openai_key=""
    
    # Anthropic API key (optional)
    read -p "Enter Anthropic API key (press Enter to skip): " anthropic_key || anthropic_key=""
    
    # Create initial config
    PROVIDER_CONFIG="third-party"
    LLM_BACKEND=""
    GPU_BACKEND=""
    
else
    # Handle local model setup
    echo ""
    echo "=================================================================="
    echo "🏠 LOCAL MODEL CONFIGURATION"
    echo "=================================================================="
    echo ""
    echo "Local models can use different backends:"
    echo ""
    echo "1) HuggingFace Transformers - Automatic device handling, wide model support"
    echo "2) Llama.cpp - Optimized C++ inference, better performance, more hardware options"
    echo ""
    
    while true; do
        read -p "Choose local backend [1-2]: " backend_choice || backend_choice=""
        case $backend_choice in
            1)
                LLM_BACKEND="huggingface"
                break
                ;;
            2)
                LLM_BACKEND="llama-cpp"
                break
                ;;
            "")
                echo "Please enter 1 or 2"
                ;;
            *)
                echo "Please enter 1 or 2"
                ;;
        esac
    done
    
    # GPU acceleration setup (only for llama-cpp or if user wants GPU for HuggingFace)
    if [[ "$LLM_BACKEND" == "llama-cpp" ]] || [[ "$LLM_BACKEND" == "huggingface" ]]; then
        echo ""
        echo "🚀 Hardware Acceleration Setup"
        echo "=============================="
        echo ""
        echo "Do you want to use GPU acceleration?"
        echo "(This can significantly speed up model inference)"
        echo ""
        
        while true; do
            read -p "Enable GPU acceleration? (y/n): " gpu_choice || gpu_choice=""
            case $gpu_choice in
                [Yy]|[Yy]es|y|yes)
                    USE_GPU="yes"
                    break
                    ;;
                [Nn]|[Nn]o|n|no)
                    USE_GPU="no"
                    break
                    ;;
                "")
                    echo "Please enter 'y' or 'n'"
                    ;;
                *)
                    echo "Please enter 'y' or 'n'"
                    ;;
            esac
        done
        
        if [[ "$USE_GPU" == "yes" ]]; then
            if [[ "$LLM_BACKEND" == "llama-cpp" ]]; then
                echo ""
                echo "Choose GPU backend for llama-cpp:"
                echo "1) CUDA (NVIDIA GPUs)"
                echo "2) ROCm (AMD GPUs)" 
                echo "3) Metal (Apple Silicon)"
                echo "4) Auto-detect"
                echo ""
                
                while true; do
                    read -p "Choose GPU backend [1-4]: " gpu_backend_choice || gpu_backend_choice=""
                    case $gpu_backend_choice in
                        1)
                            GPU_BACKEND="cuda"
                            break
                            ;;
                        2)
                            GPU_BACKEND="rocm"
                            break
                            ;;
                        3)
                            if [[ "$OS" != "macos" ]]; then
                                echo "⚠️  Metal is only available on macOS. Falling back to auto-detect."
                                GPU_BACKEND="auto"
                            else
                                GPU_BACKEND="metal"
                            fi
                            break
                            ;;
                        4)
                            GPU_BACKEND="auto"
                            break
                            ;;
                        "")
                            echo "Please enter 1, 2, 3, or 4"
                            ;;
                        *)
                            echo "Please enter 1, 2, 3, or 4"
                            ;;
                    esac
                done
            else
                # For HuggingFace, just use CUDA as default
                GPU_BACKEND="cuda"
            fi
        else
            GPU_BACKEND=""
        fi
    fi
    
    # Install dependencies based on choices
    echo ""
    echo "📦 Installing local model dependencies..."
    
    if [[ "$LLM_BACKEND" == "huggingface" ]]; then
        # HuggingFace backend - install PyTorch first, then main dependencies
        if [[ "$USE_GPU" == "yes" ]]; then
            echo "🔥 Installing PyTorch with GPU support..."
            python scripts/wheel_installer.py --package pytorch --hardware $GPU_BACKEND
            
            echo "📦 Installing HuggingFace dependencies..."
            if [[ "$FEATURE_LEVEL" == "core" ]]; then
                pip install -e .[local-huggingface-gpu]
            elif [[ "$FEATURE_LEVEL" == "full" ]]; then
                pip install -e .[full-local-huggingface-gpu]
            else
                pip install -e .[dev-local-gpu]
            fi
        else
            echo "📦 Installing HuggingFace dependencies (CPU)..."
            if [[ "$FEATURE_LEVEL" == "core" ]]; then
                pip install -e .[local-huggingface]
            elif [[ "$FEATURE_LEVEL" == "full" ]]; then
                pip install -e .[full-local-huggingface]
            else
                pip install -e .[dev-local-cpu]
            fi
        fi
    else
        # llama-cpp backend - install llama-cpp-python FIRST to avoid conflicts
        echo "🦙 Installing llama-cpp-python..."
        if [[ "$USE_GPU" == "yes" ]]; then
            if [[ "$GPU_BACKEND" == "auto" ]]; then
                # Auto-detect best GPU backend
                if [[ "$OS" == "macos" ]]; then
                    python scripts/wheel_installer.py --hardware metal --package both
                    GPU_BACKEND="metal"
                elif command -v nvidia-smi &> /dev/null; then
                    python scripts/wheel_installer.py --hardware cuda --package both
                    GPU_BACKEND="cuda"
                elif command -v rocm-smi &> /dev/null; then
                    python scripts/wheel_installer.py --hardware rocm --package both
                    GPU_BACKEND="rocm"
                else
                    echo "⚠️  No GPU detected, falling back to CPU"
                    python scripts/wheel_installer.py --hardware cpu --package both
                    GPU_BACKEND=""
                fi
            else
                python scripts/wheel_installer.py --hardware $GPU_BACKEND --package both
            fi
        else
            python scripts/wheel_installer.py --hardware cpu --package both
        fi
        
        # Now install main packages (without torch conflicts since llama-cpp-python is already installed)
        echo "📦 Installing main dependencies..."
        if [[ "$USE_GPU" == "yes" ]]; then
            if [[ "$FEATURE_LEVEL" == "core" ]]; then
                pip install -e .[local-llama-gpu]
            elif [[ "$FEATURE_LEVEL" == "full" ]]; then
                pip install -e .[full-local-llama-gpu]
            else
                pip install -e .[dev-local-gpu]
            fi
        else
            if [[ "$FEATURE_LEVEL" == "core" ]]; then
                pip install -e .[local-llama-cpu]
            elif [[ "$FEATURE_LEVEL" == "full" ]]; then
                pip install -e .[full-local-llama-cpu]
            else
                pip install -e .[dev-local-cpu]
            fi
        fi
    fi
    
    # Local model configuration
    echo ""
    echo "🤖 Model Configuration"
    echo "====================="
    echo ""
    
    if [[ "$LLM_BACKEND" == "huggingface" ]]; then
        echo "For HuggingFace models, you can specify:"
        read -p "Model ID (e.g., 'microsoft/DialoGPT-medium', press Enter for default): " hf_model_id
        if [[ -z "$hf_model_id" ]]; then
            hf_model_id="microsoft/DialoGPT-medium"
        fi
    else
        echo "For Llama.cpp models, you'll need to download model files."
        echo "Popular options:"
        echo "- Llama 2 7B: Good balance of quality and speed"
        echo "- Code Llama: Better for programming tasks"
        echo "- Mistral 7B: Efficient and capable"
        echo ""
        echo "You can download models later and configure them in config.json"
    fi
    
    PROVIDER_CONFIG="local"
fi

echo ""
echo "=================================================================="
echo "⚙️  CONFIGURATION FILE SETUP"
echo "=================================================================="

# Create or update config.json
if [[ -f "config.json" ]]; then
    echo "📝 Backing up existing config.json..."
    cp config.json config.json.backup
fi

echo "📝 Creating configuration file..."

# Generate config based on choices using config manager
echo ""
echo "⚙️  Configuring Aurora..."

# Prepare config updater arguments
CONFIG_ARGS=""

if [[ "$PROVIDER_TYPE" == "third-party" ]]; then
    CONFIG_ARGS="--provider openai"
    if [[ -n "$openai_key" ]]; then
        CONFIG_ARGS="$CONFIG_ARGS --setup-keys"
    fi
else
    # Local provider configuration
    if [[ "$LLM_BACKEND" == "huggingface" ]]; then
        CONFIG_ARGS="--provider huggingface_pipeline"
    else
        CONFIG_ARGS="--provider llama_cpp"
    fi
    
    # Add GPU backend if specified
    if [[ "$USE_GPU" == "yes" && -n "$GPU_BACKEND" ]]; then
        CONFIG_ARGS="$CONFIG_ARGS --backend $GPU_BACKEND"
    else
        CONFIG_ARGS="$CONFIG_ARGS --backend cpu"
    fi
fi

# Add feature level
CONFIG_ARGS="$CONFIG_ARGS --feature-level $FEATURE_LEVEL"

# Run config updater
echo "🔧 Updating configuration with: python scripts/config_updater.py $CONFIG_ARGS"
python scripts/config_updater.py $CONFIG_ARGS

if [[ $? -eq 0 ]]; then
    echo "✅ Configuration updated successfully"
else
    echo "❌ Configuration update failed"
    exit 1
fi

# Create run script
echo ""
echo "📜 Creating run script..."
cat > run.sh << 'EOF'
#!/bin/bash
# Aurora Run Script
source venv/bin/activate
cd "$(dirname "$0")"
python main.py "$@"
EOF
chmod +x run.sh

echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
echo "📱 Configuration: $PROVIDER_TYPE provider"
if [[ "$PROVIDER_TYPE" == "local" ]]; then
    echo "🧠 LLM Backend: $LLM_BACKEND"
    if [[ "$USE_GPU" == "yes" && -n "$GPU_BACKEND" ]]; then
        echo "🚀 GPU Acceleration: $GPU_BACKEND"
    fi
fi
echo "📦 Feature Level: $FEATURE_LEVEL"
echo ""
echo "🚀 To start Aurora:"
echo "   ./run.sh"
echo ""
echo "🔧 To activate the environment manually:"
echo "   source venv/bin/activate"
echo ""
echo "⚙️  Configuration file: config.json"
echo "📚 Help: ./run.sh --help"
echo ""

if [[ "$PROVIDER_TYPE" == "third-party" && -z "$openai_key" ]]; then
    echo "⚠️  Don't forget to add your API keys to config.json before running Aurora!"
    echo ""
fi

if [[ "$PROVIDER_TYPE" == "local" && "$LLM_BACKEND" == "llama-cpp" ]]; then
    echo "📥 Next steps for local models:"
    echo "   1. Download a model file (e.g., from HuggingFace)"
    echo "   2. Place it in ./chat_models/"
    echo "   3. Update the model_path in config.json"
    echo ""
fi

if [[ "$FEATURE_LEVEL" == "dev" ]]; then
    echo "🛠️  Development tools available:"
    echo "   pytest         # Run tests"
    echo "   black .        # Format code"
    echo "   flake8         # Lint code"
    echo "   mypy           # Type checking"
    echo ""
    
    # Set up pre-commit hooks for development
    echo "🪝 Setting up pre-commit hooks for code quality..."
    pip install pre-commit
    
    # Install the pre-commit hooks
    pre-commit install
    
    # Update hooks to the latest version
    
    
    
    echo "✅ Pre-commit hooks installed successfully!"
    echo "   Your code will be automatically linted when you commit changes."
    echo "   You can run pre-commit manually with: pre-commit run --all-files"
    echo ""
fi

echo "Happy voice assisting! 🎤✨"