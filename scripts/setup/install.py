#!/usr/bin/env python3
"""
Aurora Voice Assistant - Interactive Installation Helper
==========================================================

This script helps users choose the best installation method for their needs
and provides guidance for getting started with Aurora.
"""

import os
import platform
import subprocess
import sys
from pathlib import Path


def print_header():
    print("🌟 Aurora Voice Assistant - Installation Helper")
    print("=" * 50)
    print()


def print_installation_options():
    print("📦 Installation Methods Available:")
    print()
    print("1️⃣  GUIDED SETUP (Recommended)")
    print("   ✅ Interactive setup wizard")
    print("   ✅ Automatic configuration")
    print("   ✅ Hardware detection")
    print("   ✅ Provider selection (Third-party vs Local)")
    print("   📄 Command: ./setup.sh")
    print()
    print("2️⃣  PACKAGE INSTALLATION (Advanced users)")
    print("   ✅ Direct pip installation")
    print("   ✅ Choose specific feature sets")
    print("   ❌ Manual configuration required")
    print("   📄 Examples:")
    print("      pip install -e .[third-party]        # Third-party providers")
    print("      pip install -e .[local-llama-gpu]    # Local models with GPU")
    print("      pip install -e .[full-third-party]   # All features + API")
    print()
    print("3️⃣  CONTAINER DEPLOYMENT (Production)")
    print("   ✅ Docker containerization")
    print("   ✅ Consistent environment")
    print("   ✅ Easy scaling")
    print("   📄 Command: docker-compose up")
    print()
    print("4️⃣  DEVELOPMENT SETUP (Contributors)")
    print("   ✅ Full development environment")
    print("   ✅ Testing and debugging tools")
    print("   ✅ Code formatting and linting")
    print("   📄 Command: pip install -e .[dev-local-gpu]")
    print()


def check_requirements():
    """Check if basic requirements are met"""
    issues = []

    # Check Python version

    # Check if we're in the right directory
    if not Path("pyproject.toml").exists():
        issues.append("Please run this script from the Aurora root directory")

    # Check for basic tools
    try:
        subprocess.run(["python3", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        issues.append("python3 command not found")

    return issues


def get_system_info():
    """Get basic system information"""
    system = platform.system()
    machine = platform.machine()

    gpu_info = []

    # Check for NVIDIA GPU
    try:
        subprocess.run(["nvidia-smi"], capture_output=True, check=True)
        gpu_info.append("NVIDIA GPU detected")
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    # Check for AMD GPU (ROCm)
    try:
        subprocess.run(["rocm-smi"], capture_output=True, check=True)
        gpu_info.append("AMD GPU (ROCm) detected")
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    # Check for Apple Silicon
    if system == "Darwin" and machine == "arm64":
        gpu_info.append("Apple Silicon detected")

    return {"system": system, "machine": machine, "gpu_info": gpu_info}


def recommend_installation(system_info):
    """Provide installation recommendations based on system"""
    print("🔍 System Analysis & Recommendations:")
    print("=" * 40)
    print(f"System: {system_info['system']} ({system_info['machine']})")

    if system_info["gpu_info"]:
        print(f"GPU: {', '.join(system_info['gpu_info'])}")
        print()
        print("💡 RECOMMENDED: Local models with GPU acceleration")
        print("   - Better performance with your GPU")
        print("   - Complete privacy (offline)")
        print("   - No API costs")
        print("   📄 Command: ./setup.sh (choose 'local' + GPU)")
    else:
        print("GPU: None detected")
        print()
        print("💡 RECOMMENDED: Third-party providers")
        print("   - Easy setup without GPU requirements")
        print("   - High-quality models (GPT-4, Claude)")
        print("   - Faster initial setup")
        print("   📄 Command: ./setup.sh (choose 'third-party')")

    print()


def main():
    print_header()

    # Check requirements
    issues = check_requirements()
    if issues:
        print("❌ Requirements Check Failed:")
        for issue in issues:
            print(f"   • {issue}")
        print()
        print("Please fix these issues before proceeding.")
        return 1

    print("✅ Requirements check passed!")
    print()

    # Get system info and recommendations
    system_info = get_system_info()
    recommend_installation(system_info)

    # Show installation options
    print_installation_options()

    # Get user choice
    print("Choose your installation method:")
    print()

    while True:
        choice = input("Enter your choice [1-4]: ").strip()

        if choice == "1":
            print()
            print("🚀 Starting guided setup...")
            print("This will run: ./setup.sh")
            print()

            # Make setup.sh executable and run it
            os.chmod("setup.sh", 0o755)
            try:
                subprocess.run(["./setup.sh"], check=True)
            except subprocess.CalledProcessError as e:
                print(f"❌ Setup failed with code {e.returncode}")
                return e.returncode
            break

        elif choice == "2":
            print()
            print("📚 Package Installation Guide:")
            print("=" * 30)
            print()
            print("Available installation packages:")
            print("• aurora[core]                 - Bare minimum")
            print("• aurora[third-party]          - API providers")
            print("• aurora[third-party-full]     - API + all features")
            print("• aurora[local-huggingface]    - Local HF models")
            print("• aurora[local-huggingface-gpu] - Local HF + GPU")
            print("• aurora[local-llama-cpu]      - Llama.cpp CPU")
            print("• aurora[local-llama-gpu]      - Llama.cpp GPU")
            print("• aurora[full-*]               - All features + backend")
            print("• aurora[dev-*]                - Development tools")
            print()
            print("Example commands:")
            print("  pip install -e .[third-party]")
            print("  pip install -e .[local-llama-gpu]")
            print("  pip install -e .[full-third-party]")
            print()
            print("Note: You'll need to configure config.json manually.")
            break

        elif choice == "3":
            print()
            print("🐳 Container Deployment:")
            print("=" * 25)
            print()
            print("1. Configure environment variables in .env file")
            print("2. Run: docker-compose up")
            print()
            print("For more details, see docker-compose.yml")
            break

        elif choice == "4":
            print()
            print("🛠️  Development Setup:")
            print("=" * 20)
            print()
            print("Recommended for contributors:")
            print("1. pip install -e .[dev-local-gpu]")
            print("2. pre-commit install")
            print("3. pytest  # Run tests")
            print()
            print("Available dev tools:")
            print("• pytest, black, flake8, mypy")
            print("• pre-commit hooks")
            print("• Jupyter notebooks")
            break

        else:
            print("Please enter 1, 2, 3, or 4")

    print()
    print("✨ Installation helper completed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
