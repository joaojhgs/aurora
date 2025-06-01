#!/usr/bin/env python3
"""
Aurora Setup Script
====================

Multi-platform setup script that handles different installation approaches.
Supports development, user, and production setups.
"""

import os
import sys
import platform
import subprocess
import venv
from pathlib import Path
import click

# Get project root directory
PROJECT_ROOT = Path(__file__).parent.parent

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

def install_system_dependencies(sys_info):
    """Install system-level dependencies"""
    if not sys_info["audio_deps"]:
        return True
    
    click.echo("🔧 Installing system dependencies...")
    
    try:
        if sys_info["name"] == "macOS":
            # Check if homebrew is available
            subprocess.run(["brew", "--version"], 
                         capture_output=True, check=True)
            for dep in sys_info["audio_deps"]:
                subprocess.run(["brew", "install", dep], check=True)
                
        elif sys_info["name"] == "Linux":
            # Try apt-get (Debian/Ubuntu)
            for dep in sys_info["audio_deps"]:
                subprocess.run(["sudo", "apt-get", "install", "-y", dep], 
                             check=True)
        
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

def install_python_dependencies(sys_info, mode):
    """Install Python dependencies based on mode with smart wheel handling"""
    click.echo(f"📦 Installing Python dependencies for {mode} mode...")
    
    # Import wheel installer
    import sys
    from pathlib import Path
    sys.path.append(str(Path(__file__).parent))
    from wheel_installer import WheelInstaller
    
    # Determine hardware type and advanced features
    hardware = "cpu"
    advanced = False
    
    if "cuda" in mode:
        hardware = "cuda"
        if "advanced" in mode or "dev" in mode:
            advanced = True
    elif "rocm" in mode:
        hardware = "rocm"
    
    # Determine base installation command (without llama-cpp-python)
    if mode == "minimal":
        install_cmd = ["pip", "install", "-e", ".[runtime]"]
    elif mode == "minimal-cuda":
        install_cmd = ["pip", "install", "-e", ".[runtime,cuda]"]
    elif mode == "minimal-rocm":
        install_cmd = ["pip", "install", "-e", ".[runtime,rocm]"]
    elif mode == "all-cpu":
        install_cmd = ["pip", "install", "-e", ".[runtime,openai,embeddings-local,ui,google,jira,github,slack,brave-search,openrecall]"]
    elif mode == "all-cuda":
        install_cmd = ["pip", "install", "-e", ".[runtime,cuda,openai,embeddings-local,ui,google,jira,github,slack,brave-search,openrecall]"]
    elif mode == "all-rocm":
        install_cmd = ["pip", "install", "-e", ".[runtime,rocm,openai,embeddings-local,ui,google,jira,github,slack,brave-search,openrecall]"]
    elif mode == "dev-cpu":
        install_cmd = ["pip", "install", "-e", ".[runtime,dev,test,build,container]"]
    elif mode == "dev-cuda":
        install_cmd = ["pip", "install", "-e", ".[runtime,cuda,dev,test,build,container]"]
    elif mode == "dev-rocm":
        install_cmd = ["pip", "install", "-e", ".[runtime,rocm,dev,test,build,container]"]
    elif mode == "server-cpu":
        install_cmd = ["pip", "install", "-e", ".[runtime,openai,container]"]
    elif mode == "server-cuda":
        install_cmd = ["pip", "install", "-e", ".[runtime,cuda,openai,container]"]
    else:
        install_cmd = ["pip", "install", "-e", ".[runtime]"]
    
    try:
        # Upgrade pip first
        click.echo("🔄 Upgrading pip...")
        subprocess.run(["pip", "install", "--upgrade", "pip"], 
                      cwd=PROJECT_ROOT, check=True)
        
        # Install base Aurora dependencies (without llama-cpp-python)
        click.echo("📦 Installing base Aurora dependencies...")
        subprocess.run(install_cmd, cwd=PROJECT_ROOT, check=True)
        
        # Install llama-cpp-python with smart wheels if mode includes LLM
        if any(x in mode for x in ["minimal", "all", "dev", "server"]):
            click.echo(f"🦙 Installing llama-cpp-python with pre-built wheels ({hardware})...")
            installer = WheelInstaller()
            
            if not installer.install_llama_cpp_python(hardware, advanced):
                click.echo("⚠️  llama-cpp-python installation failed, but continuing...")
                click.echo("💡 You can install it manually later with:")
                if hardware == "cuda":
                    click.echo("   python scripts/wheel_installer.py --hardware cuda")
                elif hardware == "rocm":
                    click.echo("   python scripts/wheel_installer.py --hardware rocm")
                else:
                    click.echo("   python scripts/wheel_installer.py --hardware cpu")
        
        click.echo("✅ Python dependencies installed")
        return True
        
    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Failed to install Python dependencies: {e}")
        return False

def create_run_scripts(sys_info):
    """Create convenient run scripts"""
    click.echo("📜 Creating run scripts...")
    
    if sys_info["name"] == "Windows":
        # Create run.bat
        run_script = f"""@echo off
call {sys_info["venv_activate"]}
python main.py %*
"""
        script_path = PROJECT_ROOT / "run.bat"
        
    else:
        # Create run.sh
        run_script = f"""#!/bin/bash
source {sys_info["venv_activate"]}
cd "{PROJECT_ROOT}"
python main.py "$@"
"""
        script_path = PROJECT_ROOT / "run.sh"
    
    try:
        with open(script_path, "w") as f:
            f.write(run_script)
        
        # Make executable on Unix systems
        if sys_info["name"] != "Windows":
            os.chmod(script_path, 0o755)
        
        click.echo(f"✅ Created {script_path.name}")
        return True
        
    except Exception as e:
        click.echo(f"❌ Failed to create run script: {e}")
        return False

def setup_development_tools():
    """Setup development tools like pre-commit hooks"""
    click.echo("🛠️  Setting up development tools...")
    
    try:
        subprocess.run(["pre-commit", "install"], 
                      cwd=PROJECT_ROOT, check=True)
        click.echo("✅ Pre-commit hooks installed")
        return True
    except subprocess.CalledProcessError:
        click.echo("⚠️  Pre-commit setup failed (optional)")
        return True
    except FileNotFoundError:
        click.echo("⚠️  Pre-commit not found (optional)")
        return True

@click.command()
@click.option('--mode', '-m',
              type=click.Choice([
                  'minimal', 'minimal-cuda', 'minimal-rocm',
                  'all-cpu', 'all-cuda', 'all-rocm', 
                  'dev-cpu', 'dev-cuda', 'dev-rocm',
                  'server-cpu', 'server-cuda'
              ]),
              default='minimal',
              help='Setup mode: minimal (basic), all (full features), dev (development), server (production)')
@click.option('--skip-system', '-s', is_flag=True, 
              help='Skip system dependency installation')
@click.option('--force', '-f', is_flag=True,
              help='Force reinstallation')
def main(mode, skip_system, force):
    """Setup Aurora for different use cases"""
    click.echo("🌟 Aurora Setup System")
    click.echo("=" * 50)
    
    # Detect system
    sys_info = detect_system()
    click.echo(f"🖥️  Detected: {sys_info['name']} ({platform.machine()})")
    
    success = True
    
    # Install system dependencies
    if not skip_system:
        success &= install_system_dependencies(sys_info)
    
    # Create virtual environment
    success &= create_virtual_environment(sys_info)
    
    # Install Python dependencies
    success &= install_python_dependencies(sys_info, mode)
    
    # Create run scripts
    success &= create_run_scripts(sys_info)
    
    # Setup development tools (for dev modes)
    if mode.startswith("dev"):
        success &= setup_development_tools()
    
    # Final status
    if success:
        click.echo("\n🎉 Setup completed successfully!")
        click.echo(f"🚀 Run Aurora with: ./run{sys_info['shell_ext']}")
        
        if mode.startswith("dev"):
            click.echo("🔨 Development mode enabled with:")
            click.echo("   - Testing tools (pytest)")
            click.echo("   - Code formatting (black)")
            click.echo("   - Linting (flake8, mypy)")
            click.echo("   - Pre-commit hooks")
            
        if "cuda" in mode:
            click.echo("🚀 GPU acceleration enabled")
            click.echo("   - CUDA support for PyTorch")
            click.echo("   - GPU-accelerated LLMs")
        elif "rocm" in mode:
            click.echo("🚀 AMD GPU acceleration enabled") 
            click.echo("   - ROCm support for PyTorch")
        else:
            click.echo("🖥️  CPU-only mode (no GPU acceleration)")
            
    else:
        click.echo("\n💥 Setup failed!")
        click.echo("📋 Manual setup instructions:")
        click.echo(f"1. Install system dependencies: {', '.join(sys_info['audio_deps'])}")
        click.echo("2. Create virtual environment: python -m venv venv")
        click.echo(f"3. Activate environment: {sys_info['venv_activate']}")
        click.echo(f"4. Install Aurora: pip install -e .[{mode}]")
        sys.exit(1)

if __name__ == "__main__":
    main()
