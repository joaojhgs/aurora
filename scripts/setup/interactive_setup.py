#!/usr/bin/env python3
"""
Aurora Voice Assistant - Interactive Setup System
=================================================

This script provides a comprehensive installation experience that guides users
through choosing the best setup method for their needs. It combines the 
functionality of both installation guidance and automated setup.
"""

import os
import sys
import subprocess
import platform
import venv
from pathlib import Path
import click
import json

# Get project root directory
PROJECT_ROOT = Path(__file__).parent.parent.parent

def print_header():
    """Print the Aurora header"""
    click.echo("🌟 Aurora Voice Assistant - Interactive Setup")
    click.echo("=" * 50)
    click.echo()

def detect_system():
    """Detect the operating system and return setup info"""
    system = platform.system().lower()
    arch = platform.machine().lower()
    
    if system == "windows":
        return {
            "name": "Windows",
            "python": "python",
            "pip": "pip",
            "venv_activate": "venv\\Scripts\\activate.bat",
            "shell_ext": ".bat",
            "audio_deps": []  # PyAudio wheel should work
        }
    elif system == "darwin":  # macOS
        return {
            "name": "macOS", 
            "python": "python3",
            "pip": "pip3",
            "venv_activate": "venv/bin/activate",
            "shell_ext": ".sh",
            "audio_deps": ["portaudio"]  # via homebrew
        }
    else:  # Linux
        return {
            "name": "Linux",
            "python": "python3", 
            "pip": "pip3",
            "venv_activate": "venv/bin/activate",
            "shell_ext": ".sh",
            "audio_deps": ["portaudio19-dev", "python3-dev", "gcc"]
        }

def check_python_version():
    """Check if Python version is supported"""
    version = sys.version_info
    if version.major < 3 or (version.major == 3 and version.minor < 11):
        return False, f"Python {version.major}.{version.minor}"
    return True, f"Python {version.major}.{version.minor}.{version.micro}"

def detect_gpu():
    """Detect available GPU hardware"""
    gpu_info = []
    
    try:
        # Try nvidia-smi for NVIDIA GPUs
        result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], 
                              capture_output=True, text=True)
        if result.returncode == 0:
            gpus = [gpu.strip() for gpu in result.stdout.strip().split('\n') if gpu.strip()]
            gpu_info.extend([f"NVIDIA {gpu}" for gpu in gpus])
    except FileNotFoundError:
        pass
    
    try:
        # Try rocm-smi for AMD GPUs
        result = subprocess.run(["rocm-smi", "--showproductname"], 
                              capture_output=True, text=True)
        if result.returncode == 0:
            gpu_info.append("AMD GPU (ROCm compatible)")
    except FileNotFoundError:
        pass
    
    # Check for Apple Silicon
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        gpu_info.append("Apple Silicon (Metal compatible)")
    
    return gpu_info

def check_requirements():
    """Check system requirements"""
    issues = []
    
    # Check Python version
    python_ok, python_version = check_python_version()
    if not python_ok:
        issues.append(f"Python 3.11+ required, found {python_version}")
    
    # Check if we're in the right directory
    if not (PROJECT_ROOT / "main.py").exists():
        issues.append("Not in Aurora project directory")
    
    # Check if pyproject.toml exists
    if not (PROJECT_ROOT / "pyproject.toml").exists():
        issues.append("pyproject.toml not found")
    
    return issues

def get_system_info():
    """Get comprehensive system information"""
    gpu_info = detect_gpu()
    return {
        "system": platform.system(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "gpu_info": gpu_info
    }

def install_system_dependencies(sys_info):
    """Install system-level dependencies"""
    if not sys_info["audio_deps"]:
        return True
    
    click.echo("🔧 Installing system dependencies...")
    
    try:
        if sys_info["name"] == "macOS":
            # Check if homebrew is available
            subprocess.run(["brew", "--version"], capture_output=True, check=True)
            for dep in sys_info["audio_deps"]:
                subprocess.run(["brew", "install", dep], check=True)
                
        elif sys_info["name"] == "Linux":
            # Try apt-get (Debian/Ubuntu)
            subprocess.run(["sudo", "apt", "update"], check=True)
            for dep in sys_info["audio_deps"]:
                subprocess.run(["sudo", "apt", "install", "-y", dep], check=True)
        
        click.echo("✅ System dependencies installed")
        return True
        
    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Failed to install system dependencies: {e}")
        click.echo("📋 Please install manually:")
        for dep in sys_info["audio_deps"]:
            click.echo(f"   - {dep}")
        return False
    except FileNotFoundError:
        click.echo("❌ Package manager not found")
        if sys_info["name"] == "macOS":
            click.echo("📋 Please install Homebrew: https://brew.sh/")
        return False

def create_virtual_environment(sys_info):
    """Create Python virtual environment"""
    venv_path = PROJECT_ROOT / "venv"
    
    if venv_path.exists():
        click.echo("📁 Virtual environment already exists")
        return True
    
    click.echo("🐍 Creating virtual environment...")
    
    try:
        venv.create(venv_path, with_pip=True)
        click.echo("✅ Virtual environment created")
        return True
    except Exception as e:
        click.echo(f"❌ Failed to create virtual environment: {e}")
        return False

def recommend_installation(system_info):
    """Provide installation recommendations based on system"""
    click.echo("🔍 System Analysis & Recommendations:")
    click.echo("=" * 40)
    click.echo(f"System: {system_info['system']} ({system_info['machine']})")
    
    if system_info['gpu_info']:
        click.echo(f"GPU: {', '.join(system_info['gpu_info'])}")
        click.echo()
        click.echo("💡 RECOMMENDED: Local models with GPU acceleration")
        click.echo("   - Better performance with your GPU")
        click.echo("   - Complete privacy (offline)")
        click.echo("   - No API costs")
        click.echo("   📄 Guided setup will configure GPU automatically")
    else:
        click.echo("GPU: None detected")
        click.echo()
        click.echo("💡 RECOMMENDED: Third-party providers")
        click.echo("   - Easy setup without GPU requirements")
        click.echo("   - High-quality models (GPT-4, Claude)")
        click.echo("   - Faster initial setup")
        click.echo("   📄 Only requires API keys")
    
    click.echo()

def show_installation_options():
    """Show available installation methods"""
    click.echo("📦 Installation Methods Available:")
    click.echo()
    click.echo("1️⃣  GUIDED SETUP (Recommended)")
    click.echo("   ✅ Interactive setup wizard")
    click.echo("   ✅ Automatic configuration")
    click.echo("   ✅ Hardware detection")
    click.echo("   ✅ Provider selection (Third-party vs Local)")
    click.echo()
    click.echo("2️⃣  PACKAGE INSTALLATION (Advanced users)")
    click.echo("   ✅ Direct pip installation")
    click.echo("   ✅ Choose specific feature sets")
    click.echo("   ❌ Manual configuration required")
    click.echo("   📄 Examples:")
    click.echo("      pip install -e .[third-party]        # Third-party providers")
    click.echo("      pip install -e .[local-llama-gpu]    # Local models with GPU")
    click.echo("      pip install -e .[full-third-party]   # All features + API")
    click.echo()
    click.echo("3️⃣  CONTAINER DEPLOYMENT (Production)")
    click.echo("   ✅ Docker containerization")
    click.echo("   ✅ Consistent environment")
    click.echo("   ✅ Easy scaling")
    click.echo("   📄 Command: docker-compose up")
    click.echo()

def run_guided_setup(sys_info):
    """Run the guided setup script"""
    click.echo()
    click.echo("🚀 Starting guided setup...")
    
    if sys_info["name"] == "Windows":
        script_name = "setup.bat"
    else:
        script_name = "setup.sh"
        # Make executable
        os.chmod(PROJECT_ROOT / script_name, 0o755)
    
    click.echo(f"This will run: {script_name}")
    click.echo()
    
    try:
        if sys_info["name"] == "Windows":
            subprocess.run([str(PROJECT_ROOT / script_name)], check=True, shell=True)
        else:
            subprocess.run([f"./{script_name}"], cwd=PROJECT_ROOT, check=True)
        return True
    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Setup failed with code {e.returncode}")
        return False

def show_package_guide():
    """Show package installation guide"""
    click.echo()
    click.echo("📚 Package Installation Guide:")
    click.echo("=" * 30)
    click.echo()
    click.echo("Current available installation packages:")
    click.echo()
    click.echo("🎯 SIMPLE SETUPS:")
    click.echo("• aurora[core]                 - Bare minimum")
    click.echo("• aurora[third-party]          - API providers")
    click.echo("• aurora[third-party-full]     - API + all features")
    click.echo()
    click.echo("🏠 LOCAL MODELS:")
    click.echo("• aurora[local-huggingface]    - Local HF models (CPU)")
    click.echo("• aurora[local-huggingface-gpu] - Local HF + GPU")
    click.echo("• aurora[local-llama-cpu]      - Llama.cpp CPU")
    click.echo("• aurora[local-llama-gpu]      - Llama.cpp GPU")
    click.echo()
    click.echo("🌟 COMPLETE SETUPS:")
    click.echo("• aurora[full-third-party]     - All features + API")
    click.echo("• aurora[full-local-huggingface] - All features + HF")
    click.echo("• aurora[full-local-llama-cpu] - All features + Llama CPU")
    click.echo("• aurora[full-local-llama-gpu] - All features + Llama GPU")
    click.echo()
    click.echo("🛠️ DEVELOPMENT:")
    click.echo("• aurora[dev-third-party]      - Dev tools + API")
    click.echo("• aurora[dev-local-cpu]        - Dev tools + local CPU")
    click.echo("• aurora[dev-local-gpu]        - Dev tools + local GPU")
    click.echo()
    click.echo("Example installation commands:")
    click.echo("  pip install -e .[third-party]")
    click.echo("  pip install -e .[local-llama-gpu]")
    click.echo("  pip install -e .[full-third-party]")
    click.echo()
    click.echo("⚠️ Note: You'll need to configure config.json manually after installation.")

def show_container_guide():
    """Show container deployment guide"""
    click.echo()
    click.echo("🐳 Container Deployment:")
    click.echo("=" * 25)
    click.echo()
    click.echo("For containerized deployment:")
    click.echo("1. Configure environment variables in .env file")
    click.echo("2. Run: docker-compose up")
    click.echo()
    click.echo("For more details, see docker-compose.yml")

def show_development_guide():
    """Show development setup guide"""
    click.echo()
    click.echo("🛠️  Development Setup:")
    click.echo("=" * 20)
    click.echo()
    click.echo("Recommended for contributors:")
    click.echo("1. pip install -e .[dev-local-gpu]")
    click.echo("2. pre-commit install")
    click.echo("3. pytest  # Run tests")
    click.echo()
    click.echo("Available dev tools:")
    click.echo("• pytest, black, flake8, mypy")
    click.echo("• pre-commit hooks")
    click.echo("• Jupyter notebooks")

@click.command()
@click.option('--skip-checks', '-s', is_flag=True, help='Skip system requirement checks')
@click.option('--auto-guided', '-a', is_flag=True, help='Automatically run guided setup')
def main(skip_checks, auto_guided):
    """Interactive setup system for Aurora Voice Assistant"""
    print_header()
    
    # Check requirements
    if not skip_checks:
        issues = check_requirements()
        if issues:
            click.echo("❌ Requirements Check Failed:")
            for issue in issues:
                click.echo(f"   • {issue}")
            click.echo()
            click.echo("Please fix these issues before proceeding.")
            return 1
        
        click.echo("✅ Requirements check passed!")
        click.echo()
    
    # Get system info and recommendations
    system_info = get_system_info()
    sys_info = detect_system()
    recommend_installation(system_info)
    
    # Auto-run guided setup if requested
    if auto_guided:
        return 0 if run_guided_setup(sys_info) else 1
    
    # Show installation options
    show_installation_options()
    
    # Get user choice
    click.echo("Choose your installation method:")
    click.echo()
    
    while True:
        choice = click.prompt("Enter your choice [1-3]", type=str).strip()
        
        if choice == "1":
            success = run_guided_setup(sys_info)
            return 0 if success else 1
            
        elif choice == "2":
            show_package_guide()
            break
            
        elif choice == "3":
            show_container_guide()
            break
            
        else:
            click.echo("Please enter 1, 2, or 3")
    
    click.echo()
    click.echo("✨ Installation helper completed!")
    return 0

if __name__ == "__main__":
    sys.exit(main())
