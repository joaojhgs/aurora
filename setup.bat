@echo off
REM Aurora Voice Assistant - Windows Setup Script
REM 
REM This script provides a simplified, guided installation experience
REM for Aurora Voice Assistant with clear choices and configuration

setlocal enabledelayedexpansion

echo 🌟 Aurora Voice Assistant Setup
echo ================================
echo This script will help you install Aurora with the right
echo configuration for your needs and hardware.
echo.

REM Detect Windows
echo 🪟 Detected: Windows
echo.

REM Check Python installation and version
echo 🔧 Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python not found. Please install Python 3.11 or earlier from https://python.org
    pause
    exit /b 1
)

for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i
echo 🐍 Python found: %PYTHON_VERSION%

REM Check if Python version is compatible (3.11 or earlier)
echo.
echo 🔍 Checking Python version compatibility...
for /f "tokens=1,2 delims=." %%a in ("%PYTHON_VERSION%") do (
    set PYTHON_MAJOR=%%a
    set PYTHON_MINOR=%%b
)

REM Convert to numbers for comparison
set /a PYTHON_MAJOR_NUM=%PYTHON_MAJOR%
set /a PYTHON_MINOR_NUM=%PYTHON_MINOR%

if %PYTHON_MAJOR_NUM% gtr 3 (
    goto version_error
)
if %PYTHON_MAJOR_NUM% equ 3 if %PYTHON_MINOR_NUM% gtr 11 (
    goto version_error
)

echo ✅ Python version %PYTHON_VERSION% is compatible
goto create_venv

:version_error
echo ❌ ERROR: Python %PYTHON_VERSION% detected
echo    Aurora requires Python 3.11 or earlier due to dependency compatibility.
echo    Python 3.12+ causes issues with some audio and ML dependencies.
echo.
echo 🔧 Please install Python 3.11 or use a version manager:
echo    # Download Python 3.11 from: https://www.python.org/downloads/
echo    # Or use pyenv-win for Windows:
echo    # https://github.com/pyenv-win/pyenv-win
echo.
pause
exit /b 1

:create_venv

REM Create virtual environment
echo.
echo 🐍 Setting up Python environment...
if not exist "venv" (
    python -m venv venv
    echo ✅ Virtual environment created
) else (
    echo 📁 Virtual environment already exists
)

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Upgrade pip
echo 📦 Upgrading pip...
pip install --upgrade pip

echo.
echo ==================================================================
echo 🤖 LLM PROVIDER SETUP
echo ==================================================================
echo.
echo Aurora can use different AI providers. Choose what works best for you:
echo.
echo 🔴 THIRD-PARTY PROVIDERS ^(Recommended for beginners^)
echo    ✅ Easy setup with just API keys
echo    ✅ High-quality models ^(GPT-4, Claude, etc.^)
echo    ✅ No hardware requirements
echo    ❌ Requires internet connection
echo    ❌ Costs per API call
echo.
echo 🟢 LOCAL MODELS ^(Privacy-focused^)
echo    ✅ Complete privacy - runs offline
echo    ✅ No ongoing costs
echo    ✅ Works without internet
echo    ❌ Requires decent hardware
echo    ❌ More complex setup
echo.

:provider_choice
set /p provider_choice="Choose provider type (third-party/local): "
if /i "%provider_choice%"=="third-party" (
    set PROVIDER_TYPE=third-party
    goto feature_level
)
if /i "%provider_choice%"=="t" (
    set PROVIDER_TYPE=third-party
    goto feature_level
)
if /i "%provider_choice%"=="local" (
    set PROVIDER_TYPE=local
    goto feature_level
)
if /i "%provider_choice%"=="l" (
    set PROVIDER_TYPE=local
    goto feature_level
)
if "%provider_choice%"=="" (
    echo Please enter 'third-party' or 'local'
    goto provider_choice
)
echo Please enter 'third-party' or 'local'
goto provider_choice

:feature_level
echo.
echo ==================================================================
echo 📦 FEATURE LEVEL SETUP
echo ==================================================================
echo.
echo Choose what features you want:
echo 1^) Core - Essential features only ^(voice assistant, basic commands^)
echo 2^) Full - All features ^(UI, integrations, productivity tools^)
echo 3^) Development - All features + development tools
echo.

:feature_choice
set /p feature_choice="Choose feature level [1-3]: "
if "%feature_choice%"=="1" (
    set FEATURE_LEVEL=core
    goto provider_setup
)
if "%feature_choice%"=="2" (
    set FEATURE_LEVEL=full
    goto provider_setup
)
if "%feature_choice%"=="3" (
    set FEATURE_LEVEL=dev
    goto provider_setup
)
if "%feature_choice%"=="" (
    echo Please enter 1, 2, or 3
    goto feature_choice
)
echo Please enter 1, 2, or 3
goto feature_choice

:provider_setup
REM Handle third-party provider setup
if "%PROVIDER_TYPE%"=="third-party" goto third_party_setup

REM Handle local model setup
echo.
echo ==================================================================
echo 🏠 LOCAL MODEL CONFIGURATION
echo ==================================================================
echo.
echo Local models can use different backends:
echo.
echo 1^) HuggingFace Transformers - Automatic device handling, wide model support
echo 2^) Llama.cpp - Optimized C++ inference, better performance, more hardware options
echo.

:backend_choice
set /p backend_choice="Choose local backend [1-2]: "
if "%backend_choice%"=="1" (
    set LLM_BACKEND=huggingface
    goto gpu_setup
)
if "%backend_choice%"=="2" (
    set LLM_BACKEND=llama-cpp
    goto gpu_setup
)
if "%backend_choice%"=="" (
    echo Please enter 1 or 2
    goto backend_choice
)
echo Please enter 1 or 2
goto backend_choice

:gpu_setup
echo.
echo 🚀 Hardware Acceleration Setup
echo ==============================
echo.
echo Do you want to use GPU acceleration?
echo ^(This can significantly speed up model inference^)
echo.

:gpu_choice
set /p gpu_choice="Enable GPU acceleration? (y/n): "
if /i "%gpu_choice%"=="y" (
    set USE_GPU=yes
    goto gpu_backend_setup
)
if /i "%gpu_choice%"=="yes" (
    set USE_GPU=yes
    goto gpu_backend_setup
)
if /i "%gpu_choice%"=="n" (
    set USE_GPU=no
    set GPU_BACKEND=
    goto local_install
)
if /i "%gpu_choice%"=="no" (
    set USE_GPU=no
    set GPU_BACKEND=
    goto local_install
)
if "%gpu_choice%"=="" (
    echo Please enter 'y' or 'n'
    goto gpu_choice
)
echo Please enter 'y' or 'n'
goto gpu_choice

:gpu_backend_setup
if "%LLM_BACKEND%"=="llama-cpp" goto llama_gpu_setup

REM For HuggingFace, just use CUDA as default
set GPU_BACKEND=cuda
goto local_install

:llama_gpu_setup
echo.
echo Choose GPU backend for llama-cpp:
echo 1^) CUDA ^(NVIDIA GPUs^)
echo 2^) ROCm ^(AMD GPUs^)
echo 3^) Auto-detect
echo.

:gpu_backend_choice
set /p gpu_backend_choice="Choose GPU backend [1-3]: "
if "%gpu_backend_choice%"=="1" (
    set GPU_BACKEND=cuda
    goto local_install
)
if "%gpu_backend_choice%"=="2" (
    set GPU_BACKEND=rocm
    goto local_install
)
if "%gpu_backend_choice%"=="3" (
    set GPU_BACKEND=auto
    goto local_install
)
if "%gpu_backend_choice%"=="" (
    echo Please enter 1, 2, or 3
    goto gpu_backend_choice
)
echo Please enter 1, 2, or 3
goto gpu_backend_choice

:third_party_setup
echo.
echo ==================================================================
echo 🔑 THIRD-PARTY PROVIDER CONFIGURATION
echo ==================================================================

REM Install dependencies
if "%FEATURE_LEVEL%"=="core" (
    echo 📦 Installing core third-party dependencies...
    pip install -e .[third-party]
) else if "%FEATURE_LEVEL%"=="full" (
    echo 📦 Installing full third-party dependencies...
    pip install -e .[third-party-full]
) else (
    echo 📦 Installing development third-party dependencies...
    pip install -e .[dev-third-party]
)

echo.
echo 🔑 API Key Setup
echo ==================
echo.
echo You'll need API keys from AI providers. You can set these up now
echo or configure them later in the config.json file.
echo.

REM OpenAI API key
set /p openai_key="Enter OpenAI API key (press Enter to skip): "

REM Anthropic API key (optional)
set /p anthropic_key="Enter Anthropic API key (press Enter to skip): "

REM Create initial config
set PROVIDER_CONFIG=third-party
set LLM_BACKEND=
set GPU_BACKEND=

goto config_setup

:local_install
REM Install dependencies based on choices
echo.
echo 📦 Installing local model dependencies...

if "%LLM_BACKEND%"=="huggingface" goto huggingface_install

REM llama-cpp backend - install llama-cpp-python FIRST to avoid conflicts
echo 🦙 Installing llama-cpp-python...
if "%USE_GPU%"=="yes" (
    if "%GPU_BACKEND%"=="auto" (
        REM Auto-detect best GPU backend
        nvidia-smi >nul 2>&1
        if !errorlevel! equ 0 (
            python scripts/wheel_installer.py --hardware cuda --package both
            set GPU_BACKEND=cuda
        ) else (
            echo ⚠️  No NVIDIA GPU detected, trying AMD...
            rocm-smi >nul 2>&1
            if !errorlevel! equ 0 (
                python scripts/wheel_installer.py --hardware rocm --package both
                set GPU_BACKEND=rocm
            ) else (
                echo ⚠️  No GPU detected, falling back to CPU
                python scripts/wheel_installer.py --hardware cpu --package both
                set GPU_BACKEND=
            )
        )
    ) else (
        python scripts/wheel_installer.py --hardware %GPU_BACKEND% --package both
    )
) else (
    python scripts/wheel_installer.py --hardware cpu --package both
)

REM Now install main packages (without torch conflicts since llama-cpp-python is already installed)
echo 📦 Installing main dependencies...
if "%USE_GPU%"=="yes" (
    if "%FEATURE_LEVEL%"=="core" (
        pip install -e .[local-llama-gpu]
    ) else if "%FEATURE_LEVEL%"=="full" (
        pip install -e .[full-local-llama-gpu]
    ) else (
        pip install -e .[dev-local-gpu]
    )
) else (
    if "%FEATURE_LEVEL%"=="core" (
        pip install -e .[local-llama-cpu]
    ) else if "%FEATURE_LEVEL%"=="full" (
        pip install -e .[full-local-llama-cpu]
    ) else (
        pip install -e .[dev-local-cpu]
    )
)

goto model_config

:huggingface_install
REM HuggingFace backend - install PyTorch first, then main dependencies
if "%USE_GPU%"=="yes" (
    echo 🔥 Installing PyTorch with GPU support...
    python scripts/wheel_installer.py --package pytorch --hardware %GPU_BACKEND%
    
    echo 📦 Installing HuggingFace dependencies...
    if "%FEATURE_LEVEL%"=="core" (
        pip install -e .[local-huggingface-gpu]
    ) else if "%FEATURE_LEVEL%"=="full" (
        pip install -e .[full-local-huggingface-gpu]
    ) else (
        pip install -e .[dev-local-gpu]
    )
) else (
    echo 📦 Installing HuggingFace dependencies ^(CPU^)...
    if "%FEATURE_LEVEL%"=="core" (
        pip install -e .[local-huggingface]
    ) else if "%FEATURE_LEVEL%"=="full" (
        pip install -e .[full-local-huggingface]
    ) else (
        pip install -e .[dev-local-cpu]
    )
)

:model_config
REM Local model configuration
echo.
echo 🤖 Model Configuration
echo =====================
echo.

if "%LLM_BACKEND%"=="huggingface" (
    echo For HuggingFace models, you can specify:
    set /p hf_model_id="Model ID (e.g., 'microsoft/DialoGPT-medium', press Enter for default): "
    if "!hf_model_id!"=="" set hf_model_id=microsoft/DialoGPT-medium
) else (
    echo For Llama.cpp models, you'll need to download model files.
    echo Popular options:
    echo - Llama 2 7B: Good balance of quality and speed
    echo - Code Llama: Better for programming tasks
    echo - Mistral 7B: Efficient and capable
    echo.
    echo You can download models later and configure them in config.json
)

set PROVIDER_CONFIG=local

:config_setup
echo.
echo ==================================================================
echo ⚙️  CONFIGURATION FILE SETUP
echo ==================================================================

REM Create or update config.json
if exist "config.json" (
    echo 📝 Backing up existing config.json...
    copy config.json config.json.backup >nul
)

echo 📝 Creating configuration file...

REM Generate config based on choices using config manager
echo.
echo ⚙️  Configuring Aurora...

REM Prepare config updater arguments
set CONFIG_ARGS=

if "%PROVIDER_TYPE%"=="third-party" (
    set CONFIG_ARGS=--provider openai
    if not "%openai_key%"=="" (
        set CONFIG_ARGS=!CONFIG_ARGS! --setup-keys
    )
) else (
    REM Local provider configuration
    if "%LLM_BACKEND%"=="huggingface" (
        set CONFIG_ARGS=--provider huggingface_pipeline
    ) else (
        set CONFIG_ARGS=--provider llama_cpp
    )
    
    REM Add GPU backend if specified
    if "%USE_GPU%"=="yes" (
        if not "%GPU_BACKEND%"=="" (
            set CONFIG_ARGS=!CONFIG_ARGS! --backend %GPU_BACKEND%
        )
    ) else (
        set CONFIG_ARGS=!CONFIG_ARGS! --backend cpu
    )
)

REM Add feature level
set CONFIG_ARGS=%CONFIG_ARGS% --feature-level %FEATURE_LEVEL%

REM Run config updater
echo 🔧 Updating configuration with: python scripts/config_updater.py %CONFIG_ARGS%
python scripts/config_updater.py %CONFIG_ARGS%

if %errorlevel% equ 0 (
    echo ✅ Configuration updated successfully
) else (
    echo ❌ Configuration update failed
    pause
    exit /b 1
)

REM Create run script
echo.
echo 📜 Creating run script...
(
echo @echo off
echo REM Aurora Run Script
echo call venv\Scripts\activate.bat
echo cd /d "%~dp0"
echo python main.py %%*
) > run.bat

echo.
echo 🎉 Setup Complete!
echo ==================
echo.
echo 📱 Configuration: %PROVIDER_TYPE% provider
if "%PROVIDER_TYPE%"=="local" (
    echo 🧠 LLM Backend: %LLM_BACKEND%
    if "%USE_GPU%"=="yes" (
        if not "%GPU_BACKEND%"=="" (
            echo 🚀 GPU Acceleration: %GPU_BACKEND%
        )
    )
)
echo 📦 Feature Level: %FEATURE_LEVEL%
echo.
echo 🚀 To start Aurora:
echo    run.bat
echo.
echo 🔧 To activate the environment manually:
echo    venv\Scripts\activate.bat
echo.
echo ⚙️  Configuration file: config.json
echo 📚 Help: run.bat --help
echo.

if "%PROVIDER_TYPE%"=="third-party" (
    if "%openai_key%"=="" (
        echo ⚠️  Don't forget to add your API keys to config.json before running Aurora!
        echo.
    )
)

if "%PROVIDER_TYPE%"=="local" (
    if "%LLM_BACKEND%"=="llama-cpp" (
        echo 📥 Next steps for local models:
        echo    1. Download a model file ^(e.g., from HuggingFace^)
        echo    2. Place it in .\chat_models\
        echo    3. Update the model_path in config.json
        echo.
    )
)

if "%FEATURE_LEVEL%"=="dev" (
    echo 🛠️  Development tools available:
    echo    pytest         # Run tests
    echo    black .        # Format code
    echo    flake8         # Lint code
    echo    mypy           # Type checking
    echo.
)

echo Happy voice assisting! 🎤✨
pause
