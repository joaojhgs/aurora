#!/usr/bin/env python3
"""
Aurora Build Script
====================

Builds Aurora executables for different platforms using PyInstaller.
Supports building for Windows, macOS, and Linux from any platform.
Integrates with Aurora's wheel installer for optimal dependency management.
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

import click

# Get project root directory
PROJECT_ROOT = Path(__file__).parent.parent
DIST_DIR = PROJECT_ROOT / "dist"
BUILD_DIR = PROJECT_ROOT / "build"


def check_python_version():
    """Check Python version compatibility"""
    version = sys.version_info
    if version < (3, 9) or version >= (3, 12):
        click.echo(f"❌ Python {version.major}.{version.minor}.{version.micro} is not supported")
        click.echo("🐍 Aurora requires Python 3.9, 3.10, or 3.11")
        click.echo("📋 Please install a compatible Python version:")

        system = platform.system().lower()
        if system == "windows":
            click.echo("   • Download from https://python.org/downloads/")
            click.echo("   • Or use pyenv-win: scoop install pyenv")
        elif system == "darwin":
            click.echo("   • Use pyenv: brew install pyenv")
            click.echo("   • Or download from https://python.org/downloads/")
        else:  # Linux
            click.echo("   • Use pyenv: curl https://pyenv.run | bash")
            click.echo("   • Or use your package manager (apt, yum, etc.)")

        sys.exit(1)

    click.echo(f"✅ Python {version.major}.{version.minor}.{version.micro} is compatible")


def ensure_dependencies():
    """Ensure all build dependencies are installed"""
    click.echo("🔍 Checking build dependencies...")

    # Check if wheel installer exists
    wheel_installer = PROJECT_ROOT / "scripts" / "wheel_installer.py"
    if not wheel_installer.exists():
        click.echo("❌ Wheel installer not found")
        sys.exit(1)

    # Install build dependencies using pyproject.toml optional groups
    click.echo("📦 Installing build dependencies...")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-e", ".[build,runtime,torch-cpu]"],
            check=True,
            cwd=PROJECT_ROOT,
        )
        click.echo("✅ Build dependencies installed")
    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Failed to install build dependencies: {e}")
        click.echo("📦 Trying fallback installation...")

        # Fallback: Install core build tools
        try:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "pyinstaller>=6.0.0",
                    "auto-py-to-exe>=2.4.0",
                ],
                check=True,
            )
            click.echo("✅ Core build tools installed")
        except subprocess.CalledProcessError as fallback_error:
            click.echo(f"❌ Fallback installation failed: {fallback_error}")
            sys.exit(1)

    # Verify PyInstaller installation
    try:
        import PyInstaller

        click.echo(f"✅ PyInstaller {PyInstaller.__version__} found")
    except ImportError:
        click.echo("❌ PyInstaller not available after installation")
        sys.exit(1)

    # Run wheel installer to ensure optimal packages (torch, llama-cpp-python)
    click.echo("🎡 Running wheel installer for optimal packages...")
    try:
        subprocess.run(
            [sys.executable, str(wheel_installer), "--hardware", "cpu", "--package", "both"],
            check=True,
            cwd=PROJECT_ROOT,
        )
        click.echo("✅ Dependencies optimized")
    except subprocess.CalledProcessError as e:
        click.echo(f"⚠️  Wheel installer warning: {e}")
        click.echo("📦 Continuing with CPU-only torch...")
        # Don't use requirements.txt fallback - rely on pyproject.toml


def clean_build_dirs():
    """Clean previous build artifacts"""
    for dir_path in [DIST_DIR, BUILD_DIR]:
        if dir_path.exists():
            shutil.rmtree(dir_path)
            click.echo(f"🧹 Cleaned {dir_path}")


def get_platform_args():
    """Get platform-specific PyInstaller arguments"""
    system = platform.system().lower()

    common_args = [
        str(PROJECT_ROOT / "main.py"),
        "--name=Aurora",
        f"--distpath={DIST_DIR}",
        f"--workpath={BUILD_DIR}",
        f"--specpath={BUILD_DIR}",
        # Add data files
        f"--add-data={PROJECT_ROOT / 'app'}:app",
        f"--add-data={PROJECT_ROOT / 'modules'}:modules",
        f"--add-data={PROJECT_ROOT / 'config.json'}:.",
        # Optimize
        "--optimize=2",
        "--strip",
    ]

    if system == "windows":
        return common_args + [
            "--icon=assets/aurora.ico",
            "--version-file=version.txt",
            "--noconsole",  # Remove for debug version
        ]
    elif system == "darwin":  # macOS
        return common_args + [
            "--icon=assets/aurora.icns",
            "--osx-bundle-identifier=com.aurora.voice",
            "--target-arch=universal2",  # Universal binary
        ]
    else:  # Linux
        return common_args + [
            "--icon=assets/aurora.png",
        ]


def create_version_file():
    """Create version file for Windows builds"""
    if platform.system() == "Windows":
        version_content = """# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=(0, 1, 0, 0),
    prodvers=(0, 1, 0, 0),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        u'040904B0',
        [StringStruct(u'CompanyName', u'Aurora Team'),
        StringStruct(u'FileDescription', u'Aurora Voice Assistant'),
        StringStruct(u'FileVersion', u'0.1.0'),
        StringStruct(u'InternalName', u'Aurora'),
        StringStruct(u'LegalCopyright', u'© Aurora Team'),
        StringStruct(u'OriginalFilename', u'Aurora.exe'),
        StringStruct(u'ProductName', u'Aurora Voice Assistant'),
        StringStruct(u'ProductVersion', u'0.1.0')])
    ]),
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)"""
        with open(PROJECT_ROOT / "version.txt", "w") as f:
            f.write(version_content)


def handle_enum34_compatibility():
    """Handle enum34 compatibility issue with PyInstaller"""
    click.echo("🔧 Handling PyInstaller compatibility issues...")

    # The enum34 package is incompatible with PyInstaller on Python 3.4+
    # It's only needed for Python < 3.4, but some packages incorrectly list it as a dependency
    # enum34 creates an 'enum' directory that shadows Python's built-in enum module
    # We need to hide both the enum directory and the dist-info

    backup_paths = []
    try:
        # Check if enum34 is installed using pip
        result = subprocess.run([sys.executable, "-m", "pip", "show", "enum34"], capture_output=True, text=True)

        if result.returncode == 0:
            # enum34 is installed, find its location
            lines = result.stdout.split("\n")
            location = None
            for line in lines:
                if line.startswith("Location:"):
                    location = line.split(":", 1)[1].strip()
                    break

            if location:
                location_path = Path(location)
                timestamp = str(os.getpid())

                # Hide the enum directory
                enum_path = location_path / "enum"
                if enum_path.exists():
                    enum_backup_path = location_path / f"enum_backup_{timestamp}"
                    click.echo("⚠️  Found enum34 package - temporarily hiding for PyInstaller compatibility...")
                    click.echo(f"    Moving enum: {enum_path} -> {enum_backup_path}")
                    shutil.move(str(enum_path), str(enum_backup_path))
                    backup_paths.append(("enum", str(enum_backup_path)))

                # Hide the dist-info directory
                dist_info_pattern = location_path / "enum34-*.dist-info"
                import glob

                for dist_info_path in glob.glob(str(dist_info_pattern)):
                    dist_info_path = Path(dist_info_path)
                    if dist_info_path.exists():
                        dist_info_backup_path = location_path / f"{dist_info_path.name}_backup_{timestamp}"
                        click.echo(f"    Moving dist-info: {dist_info_path} -> {dist_info_backup_path}")
                        shutil.move(str(dist_info_path), str(dist_info_backup_path))
                        backup_paths.append(("dist-info", str(dist_info_backup_path)))

                if backup_paths:
                    click.echo("✅ enum34 temporarily hidden")

                    # Store backup paths for later restoration
                    with open(PROJECT_ROOT / ".enum34_backup", "w") as f:
                        for backup_type, backup_path in backup_paths:
                            f.write(f"{backup_type}:{backup_path}\n")

                    return backup_paths
                else:
                    click.echo(f"⚠️  enum34 installed but directories not found at {location}")
            else:
                click.echo("⚠️  enum34 installed but location not found in pip show output")

    except Exception as e:
        click.echo(f"⚠️  Could not handle enum34: {e}")
        click.echo("📋 Continuing with build - may encounter PyInstaller warnings")

    click.echo("✅ enum34 not found - good for PyInstaller compatibility")
    return None


def restore_enum34():
    """Restore enum34 after build if it was temporarily hidden"""
    backup_file = PROJECT_ROOT / ".enum34_backup"
    if backup_file.exists():
        try:
            with open(backup_file) as f:
                lines = f.read().strip().split("\n")

            for line in lines:
                if ":" in line:
                    backup_type, backup_path = line.split(":", 1)
                    backup_path = Path(backup_path)

                    if backup_path.exists():
                        if backup_type == "enum":
                            original_path = backup_path.parent / "enum"
                        elif backup_type == "dist-info":
                            # Remove the _backup_timestamp suffix
                            original_name = backup_path.name
                            if "_backup_" in original_name:
                                original_name = original_name.split("_backup_")[0]
                            original_path = backup_path.parent / original_name
                        else:
                            continue

                        click.echo(f"🔄 Restoring {backup_type}: {backup_path} -> {original_path}")
                        shutil.move(str(backup_path), str(original_path))

            backup_file.unlink()
            click.echo("✅ enum34 fully restored from backup")

        except Exception as e:
            click.echo(f"⚠️  Could not restore enum34: {e}")


def handle_webrtcvad_hook():
    """Temporarily disable problematic webrtcvad hook"""
    try:
        # Find webrtcvad hook file
        import site

        site_packages = site.getsitepackages()[0]
        hook_path = Path(site_packages) / "_pyinstaller_hooks_contrib" / "stdhooks" / "hook-webrtcvad.py"

        if hook_path.exists():
            backup_path = hook_path.with_suffix(".py.backup")
            click.echo(f"🔄 Temporarily disabling webrtcvad hook: {hook_path}")
            shutil.move(str(hook_path), str(backup_path))
            return backup_path
        else:
            click.echo("✅ webrtcvad hook not found - good for PyInstaller compatibility")
            return None

    except Exception as e:
        click.echo(f"⚠️  Could not handle webrtcvad hook: {e}")
        click.echo("📋 Continuing with build - may encounter hook warnings")
        return None


def restore_webrtcvad_hook(backup_path):
    """Restore webrtcvad hook after build"""
    if backup_path and backup_path.exists():
        try:
            original_path = backup_path.with_suffix(".py")
            click.echo(f"🔄 Restoring webrtcvad hook: {backup_path} -> {original_path}")
            shutil.move(str(backup_path), str(original_path))
            click.echo("✅ webrtcvad hook restored")
        except Exception as e:
            click.echo(f"⚠️  Could not restore webrtcvad hook: {e}")


def build_executable():
    """Build the executable using PyInstaller"""
    click.echo("🏗️  Building Aurora executable...")

    # Import PyInstaller (should be installed by ensure_dependencies)
    try:
        import PyInstaller.__main__
    except ImportError:
        click.echo("❌ PyInstaller not available. Run with dependencies first.")
        return False

    # Handle enum34 and webrtcvad compatibility issues
    enum34_backup = handle_enum34_compatibility()
    webrtcvad_backup = handle_webrtcvad_hook()

    try:
        # Clean previous builds
        clean_build_dirs()

        # Create version file for Windows
        create_version_file()

        # Get platform-specific arguments
        args = get_platform_args()

        # Run PyInstaller
        PyInstaller.__main__.run(args)

        # Success message
        executable_name = "Aurora.exe" if platform.system() == "Windows" else "Aurora"
        executable_path = DIST_DIR / executable_name

        if executable_path.exists():
            click.echo("✅ Build successful!")
            click.echo("📦 Executable: {executable_path}")
            click.echo(f"📊 Size: {executable_path.stat().st_size / (1024 * 1024):.1f} MB")
            success = True
        else:
            click.echo("❌ Build failed - executable not found")
            success = False

    except Exception as e:
        click.echo(f"❌ Build failed: {e}")
        success = False

    finally:
        # Always restore enum34 and webrtcvad if they were backed up
        if enum34_backup:
            restore_enum34()
        if webrtcvad_backup:
            restore_webrtcvad_hook(webrtcvad_backup)

    return success


def build_container():
    """Build Docker container"""
    click.echo("🐳 Building Docker container...")

    # Use Python 3.10 for better compatibility while staying within our version range
    dockerfile_content = """FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \\
    portaudio19-dev \\
    ffmpeg \\
    gcc \\
    g++ \\
    cmake \\
    build-essential \\
    git \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project files
COPY pyproject.toml .
COPY scripts/ scripts/
COPY app/ app/
COPY modules/ modules/
COPY main.py .
COPY config.json .

# Install Python dependencies using pyproject.toml
# Use runtime dependencies with CPU torch for containers
RUN pip install --no-cache-dir -e .[runtime,torch-cpu] && \\
    python scripts/wheel_installer.py --auto-detect --cpu-only || true

# Create non-root user
RUN useradd -m -u 1000 aurora && \\
    chown -R aurora:aurora /app
USER aurora

# Create data directories
RUN mkdir -p /app/data /app/logs

EXPOSE 8000

CMD ["python", "main.py"]
"""

    # Write Dockerfile
    with open(PROJECT_ROOT / "Dockerfile", "w") as f:
        f.write(dockerfile_content)

    try:
        # Build Docker image
        subprocess.run(["docker", "build", "-t", "aurora:latest", str(PROJECT_ROOT)], check=True)

        click.echo("✅ Docker container built successfully!")
        click.echo("🚀 Run with: docker run -p 8000:8000 aurora:latest")

    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Docker build failed: {e}")
        return False
    except FileNotFoundError:
        click.echo("❌ Docker not found. Please install Docker first.")
        return False

    return True


@click.command()
@click.option(
    "--target",
    "-t",
    type=click.Choice(["exe", "container", "all"]),
    default="exe",
    help="Build target: exe (executable), container (Docker), or all",
)
@click.option("--clean", "-c", is_flag=True, help="Clean build directories first")
@click.option("--skip-deps", is_flag=True, help="Skip dependency installation check")
def main(target, clean, skip_deps):
    """Build Aurora for distribution"""
    click.echo("🌟 Aurora Build System")
    click.echo("=" * 50)

    # Check Python version compatibility
    check_python_version()

    if not skip_deps:
        # Ensure dependencies are properly installed
        ensure_dependencies()

    if clean:
        clean_build_dirs()

    success = True

    if target in ["exe", "all"]:
        success &= build_executable()

    if target in ["container", "all"]:
        success &= build_container()

    if success:
        click.echo("\n🎉 Build completed successfully!")
        if target == "exe":
            click.echo("📱 Distribute the executable to end users")
            executable_name = "Aurora.exe" if platform.system() == "Windows" else "Aurora"
            executable_path = DIST_DIR / executable_name
            if executable_path.exists():
                click.echo(f"📁 Location: {executable_path}")
        elif target == "container":
            click.echo("🚢 Deploy the container to servers")
            click.echo("🚀 Test with: docker run --rm -p 8000:8000 aurora:latest")
        else:
            click.echo("📦 Both executable and container ready!")
    else:
        click.echo("\n💥 Build failed!")
        sys.exit(1)


if __name__ == "__main__":
    main()
