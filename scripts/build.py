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
from dataclasses import dataclass
from pathlib import Path

import click

# Get project root directory
PROJECT_ROOT = Path(__file__).parent.parent
DIST_DIR = PROJECT_ROOT / "dist"
BUILD_DIR = PROJECT_ROOT / "build"


@dataclass(frozen=True)
class SidecarProfile:
    """Dependency/build policy for a Tauri desktop sidecar variant."""

    name: str
    extras: tuple[str, ...]
    description: str
    hardware: str | None = None
    wheel_package: str = "both"
    include_modules_data: bool = False
    max_artifact_mb: int | None = None
    excludes: tuple[str, ...] = ()


HEAVY_LOCAL_AI_EXCLUDES = (
    "app.services.tts",
    "app.services.stt_transcription",
    "app.services.stt_wakeword",
    "app.services.stt_coordinator",
    "faster_whisper",
    "RealtimeSTT",
    "openwakeword",
    "piper",
    "piper_phonemize",
    "realtimetts",
    "sentence_transformers",
    "transformers",
    "torch",
    "torchaudio",
    "torchvision",
    "nvidia",
    "triton",
    "tensorflow",
    "tflite_runtime",
)

SIDE_CAR_CORE_EXTRAS = (
    "build",
    "sidecar-thin",
)

LOCAL_AUDIO_EXTRAS = (
    "build",
    "sidecar-local-audio",
)

SIDECAR_PROFILES: dict[str, SidecarProfile] = {
    "thin": SidecarProfile(
        name="thin",
        extras=SIDE_CAR_CORE_EXTRAS,
        description="Lean Desktop Local shell sidecar: gateway/config/auth/db/tooling/orchestrator only; no STT/TTS/local model runtime.",
        hardware=None,
        include_modules_data=False,
        max_artifact_mb=350,
        excludes=HEAVY_LOCAL_AI_EXCLUDES,
    ),
    "local-cpu": SidecarProfile(
        name="local-cpu",
        extras=(*LOCAL_AUDIO_EXTRAS, "torch-cpu"),
        description="Local assistant CPU sidecar with STT/TTS/audio and CPU ML wheels.",
        hardware="cpu",
        include_modules_data=False,
        max_artifact_mb=1800,
    ),
    "local-cuda": SidecarProfile(
        name="local-cuda",
        extras=(*LOCAL_AUDIO_EXTRAS, "cuda"),
        description="Local assistant NVIDIA CUDA sidecar; GPU wheels are installed by the wheel installer.",
        hardware="cuda",
        include_modules_data=False,
        max_artifact_mb=6500,
    ),
    "local-rocm": SidecarProfile(
        name="local-rocm",
        extras=(*LOCAL_AUDIO_EXTRAS, "rocm"),
        description="Local assistant AMD ROCm sidecar; GPU wheels are installed by the wheel installer.",
        hardware="rocm",
        include_modules_data=False,
        max_artifact_mb=6500,
    ),
    "local-metal": SidecarProfile(
        name="local-metal",
        extras=(*LOCAL_AUDIO_EXTRAS, "metal"),
        description="Local assistant macOS Metal sidecar.",
        hardware="metal",
        include_modules_data=False,
        max_artifact_mb=2500,
    ),
    "local-vulkan": SidecarProfile(
        name="local-vulkan",
        extras=(*LOCAL_AUDIO_EXTRAS, "vulkan"),
        description="Local assistant Vulkan sidecar.",
        hardware="vulkan",
        include_modules_data=False,
        max_artifact_mb=2500,
    ),
    "local-sycl": SidecarProfile(
        name="local-sycl",
        extras=(*LOCAL_AUDIO_EXTRAS, "sycl"),
        description="Local assistant Intel SYCL sidecar.",
        hardware="sycl",
        include_modules_data=False,
        max_artifact_mb=2500,
    ),
    "local-rpc": SidecarProfile(
        name="local-rpc",
        extras=(*LOCAL_AUDIO_EXTRAS, "rpc"),
        description="Local assistant RPC/distributed acceleration sidecar.",
        hardware="rpc",
        include_modules_data=False,
        max_artifact_mb=2500,
    ),
    "full": SidecarProfile(
        name="full",
        extras=("build", "runtime", "torch-cpu"),
        description="Legacy all-in-one sidecar profile; intentionally large and only for explicit diagnostics.",
        hardware="cpu",
        include_modules_data=False,
        max_artifact_mb=6500,
    ),
}

DEFAULT_SIDECAR_PROFILE = "thin"


def sidecar_profile_names() -> list[str]:
    """Return supported Tauri sidecar profile names."""

    return list(SIDECAR_PROFILES)


def get_sidecar_profile(name: str | None) -> SidecarProfile:
    """Resolve a sidecar profile from CLI/env input."""

    profile_name = (
        name or os.getenv("AURORA_TAURI_SIDECAR_PROFILE") or DEFAULT_SIDECAR_PROFILE
    ).strip()
    try:
        return SIDECAR_PROFILES[profile_name]
    except KeyError as err:
        valid = ", ".join(sidecar_profile_names())
        raise click.ClickException(
            f"Unknown sidecar profile '{profile_name}'. Valid profiles: {valid}"
        ) from err


def format_extras(extras: tuple[str, ...]) -> str:
    """Format pyproject extras for editable install."""

    return f".[{','.join(extras)}]"


def sidecar_dist_dir(profile: SidecarProfile) -> Path:
    """Return profile-specific sidecar output directory."""

    return DIST_DIR / "sidecars" / profile.name


def check_python_version():
    """Check Python version compatibility"""
    version = sys.version_info
    if version < (3, 10) or version >= (3, 12):
        click.echo(f"❌ Python {version.major}.{version.minor}.{version.micro} is not supported")
        click.echo("🐍 Aurora requires Python 3.10 or 3.11")
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


def install_python_packages(args: list[str]) -> None:
    """Install Python packages using uv when available, falling back to pip."""
    uv = shutil.which("uv")
    if uv:
        subprocess.run([uv, "pip", "install", *args], check=True, cwd=PROJECT_ROOT)
        return
    subprocess.run([sys.executable, "-m", "pip", "install", *args], check=True, cwd=PROJECT_ROOT)


def remove_enum34_backport() -> None:
    """Remove enum34 in modern Python envs because PyInstaller refuses it."""
    uv = shutil.which("uv")
    command = [uv, "pip", "uninstall", "enum34"] if uv else [sys.executable, "-m", "pip", "uninstall", "-y", "enum34"]
    result = subprocess.run(command, cwd=PROJECT_ROOT, capture_output=True, text=True)
    if result.returncode == 0:
        click.echo("✅ Removed obsolete enum34 backport for PyInstaller compatibility")
    elif "not installed" not in (result.stdout + result.stderr).lower():
        click.echo("⚠️  Could not uninstall enum34 automatically; PyInstaller may fail")
        if result.stderr:
            click.echo(result.stderr.strip())


def ensure_dependencies(sidecar_profile: SidecarProfile | None = None):
    """Ensure build dependencies are installed for the selected package profile."""
    click.echo("🔍 Checking build dependencies...")

    # Check if wheel installer exists
    wheel_installer = PROJECT_ROOT / "scripts" / "wheel_installer.py"
    if not wheel_installer.exists():
        click.echo("❌ Wheel installer not found")
        sys.exit(1)

    extras = sidecar_profile.extras if sidecar_profile else ("build", "runtime", "torch-cpu")
    click.echo(f"📦 Installing build dependencies: {format_extras(extras)}")
    try:
        install_python_packages(["-e", format_extras(extras)])
        remove_enum34_backport()
        click.echo("✅ Build dependencies installed")
    except subprocess.CalledProcessError as e:
        click.echo(f"❌ Failed to install build dependencies: {e}")
        click.echo("📦 Trying fallback installation...")

        # Fallback: Install core build tools only. Runtime imports may still fail if
        # the selected sidecar profile was not installed by the caller.
        try:
            install_python_packages(["pyinstaller>=6.0.0", "auto-py-to-exe>=2.4.0"])
            remove_enum34_backport()
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

    if not sidecar_profile or not sidecar_profile.hardware:
        click.echo("🎡 Wheel installer skipped for thin/no-hardware build profile")
        return

    # Run wheel installer only for profiles that actually need local ML wheels.
    click.echo(
        "🎡 Running wheel installer for "
        f"{sidecar_profile.hardware} packages ({sidecar_profile.wheel_package})..."
    )
    try:
        subprocess.run(
            [
                sys.executable,
                str(wheel_installer),
                "--hardware",
                sidecar_profile.hardware,
                "--package",
                sidecar_profile.wheel_package,
            ],
            check=True,
            cwd=PROJECT_ROOT,
        )
        click.echo("✅ Dependencies optimized")
    except subprocess.CalledProcessError as e:
        click.echo(f"⚠️  Wheel installer warning: {e}")
        click.echo("📦 Continuing with installed pyproject dependencies...")

def clean_build_dirs():
    """Clean previous build artifacts"""
    for dir_path in [DIST_DIR, BUILD_DIR]:
        if dir_path.exists():
            shutil.rmtree(dir_path)
            click.echo(f"🧹 Cleaned {dir_path}")


DEFAULT_CONFIG_SOURCE = PROJECT_ROOT / "app/services/config/config_defaults.json"


def prepare_bundle_config_json() -> Path:
    """Copy schema-valid defaults to build/config.json for PyInstaller bundle.

    ``config.json`` is not tracked in git; bundled apps ship the same defaults
    as :file:`app/services/config/config_defaults.json`.
    """
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    dest = BUILD_DIR / "config.json"
    shutil.copy2(DEFAULT_CONFIG_SOURCE, dest)
    return dest


def get_platform_args(
    executable_name="Aurora",
    onefile=False,
    sidecar_profile: SidecarProfile | None = None,
    dist_dir: Path | None = None,
):
    """Get platform-specific PyInstaller arguments"""
    system = platform.system().lower()

    common_args = [
        str(PROJECT_ROOT / "main.py"),
        f"--name={executable_name}",
        f"--distpath={dist_dir or DIST_DIR}",
        f"--workpath={BUILD_DIR}",
        f"--specpath={BUILD_DIR}",
        # Add data files
        f"--add-data={PROJECT_ROOT / 'app'}:app",
        f"--add-data={prepare_bundle_config_json()}:.",
        # Optimize
        "--optimize=2",
        "--strip",
    ]

    if sidecar_profile and sidecar_profile.include_modules_data:
        common_args.append(f"--add-data={PROJECT_ROOT / 'modules'}:modules")

    if sidecar_profile:
        for module in sidecar_profile.excludes:
            common_args.append(f"--exclude-module={module}")

    if onefile:
        common_args.append("--onefile")

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


def get_version():
    """Get current version from pyproject.toml"""
    try:
        # Try importing tomllib (Python 3.11+) or toml
        try:
            import tomllib

            with open(PROJECT_ROOT / "pyproject.toml", "rb") as f:
                data = tomllib.load(f)
        except ImportError:
            import toml

            with open(PROJECT_ROOT / "pyproject.toml") as f:
                data = toml.load(f)
        return data["project"]["version"]
    except Exception:
        return "0.1.0"


def create_version_file():
    """Create version file for Windows builds"""
    version = get_version()
    version_parts = version.split(".")
    major, minor, patch = int(version_parts[0]), int(version_parts[1]), int(version_parts[2])

    if platform.system() == "Windows":
        version_content = f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({major}, {minor}, {patch}, 0),
    prodvers=({major}, {minor}, {patch}, 0),
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
        StringStruct(u'FileDescription', u'Aurora Voice Assistant v{version}'),
        StringStruct(u'FileVersion', u'{version}'),
        StringStruct(u'InternalName', u'Aurora'),
        StringStruct(u'LegalCopyright', u'© Aurora Team'),
        StringStruct(u'OriginalFilename', u'Aurora.exe'),
        StringStruct(u'ProductName', u'Aurora Voice Assistant v{version}'),
        StringStruct(u'ProductVersion', u'{version}')])
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
        result = subprocess.run(
            [sys.executable, "-m", "pip", "show", "enum34"], capture_output=True, text=True
        )

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
                    click.echo(
                        "⚠️  Found enum34 package - temporarily hiding for PyInstaller compatibility..."
                    )
                    click.echo(f"    Moving enum: {enum_path} -> {enum_backup_path}")
                    shutil.move(str(enum_path), str(enum_backup_path))
                    backup_paths.append(("enum", str(enum_backup_path)))

                # Hide the dist-info directory
                dist_info_pattern = location_path / "enum34-*.dist-info"
                import glob

                for dist_info_path in glob.glob(str(dist_info_pattern)):
                    dist_info_path = Path(dist_info_path)
                    if dist_info_path.exists():
                        dist_info_backup_path = (
                            location_path / f"{dist_info_path.name}_backup_{timestamp}"
                        )
                        click.echo(
                            f"    Moving dist-info: {dist_info_path} -> {dist_info_backup_path}"
                        )
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
        hook_path = (
            Path(site_packages) / "_pyinstaller_hooks_contrib" / "stdhooks" / "hook-webrtcvad.py"
        )

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
            original_path = backup_path.with_suffix("")
            click.echo(f"🔄 Restoring webrtcvad hook: {backup_path} -> {original_path}")
            shutil.move(str(backup_path), str(original_path))
            click.echo("✅ webrtcvad hook restored")
        except Exception as e:
            click.echo(f"⚠️  Could not restore webrtcvad hook: {e}")


def build_executable(
    executable_name="Aurora",
    onefile=False,
    sidecar_profile: SidecarProfile | None = None,
):
    """Build the executable using PyInstaller"""
    profile_label = f" ({sidecar_profile.name})" if sidecar_profile else ""
    click.echo(f"🏗️  Building {executable_name}{profile_label} executable...")

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
        dist_dir = sidecar_dist_dir(sidecar_profile) if sidecar_profile else DIST_DIR
        args = get_platform_args(
            executable_name=executable_name,
            onefile=onefile,
            sidecar_profile=sidecar_profile,
            dist_dir=dist_dir,
        )

        # Run PyInstaller
        PyInstaller.__main__.run(args)

        # Success message
        binary_name = f"{executable_name}.exe" if platform.system() == "Windows" else executable_name
        output_dist_dir = sidecar_dist_dir(sidecar_profile) if sidecar_profile else DIST_DIR
        executable_path = output_dist_dir / binary_name
        if not executable_path.is_file():
            nested_path = output_dist_dir / executable_name / binary_name
            if nested_path.is_file():
                executable_path = nested_path

        if executable_path.is_file():
            size_mb = executable_path.stat().st_size / (1024 * 1024)
            click.echo("✅ Build successful!")
            click.echo(f"📦 Executable: {executable_path}")
            click.echo(f"📊 Size: {size_mb:.1f} MB")
            if (
                sidecar_profile
                and sidecar_profile.max_artifact_mb
                and size_mb > sidecar_profile.max_artifact_mb
            ):
                click.echo(
                    "❌ Sidecar artifact exceeds profile guardrail: "
                    f"{size_mb:.1f} MB > {sidecar_profile.max_artifact_mb} MB for {sidecar_profile.name}"
                )
                success = False
            else:
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
COPY app/services/config/config_defaults.json ./config.json

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
@click.option(
    "--sidecar",
    is_flag=True,
    help="Build the Tauri desktop local sidecar executable as a one-file aurora-sidecar binary",
)
@click.option("--onefile", is_flag=True, help="Build a single-file PyInstaller executable")
@click.option(
    "--sidecar-profile",
    type=click.Choice(sidecar_profile_names()),
    default=None,
    help="Tauri sidecar dependency/build profile (defaults to AURORA_TAURI_SIDECAR_PROFILE or thin).",
)
@click.option(
    "--list-sidecar-profiles",
    is_flag=True,
    help="List supported Tauri sidecar profiles and exit",
)
def main(target, clean, skip_deps, sidecar, onefile, sidecar_profile, list_sidecar_profiles):
    """Build Aurora for distribution"""
    click.echo("🌟 Aurora Build System")
    click.echo("=" * 50)

    if list_sidecar_profiles:
        for profile in SIDECAR_PROFILES.values():
            click.echo(
                f"{profile.name}: extras={','.join(profile.extras)} "
                f"hardware={profile.hardware or 'none'} max={profile.max_artifact_mb or 'none'}MB - {profile.description}"
            )
        return

    resolved_sidecar_profile = get_sidecar_profile(sidecar_profile) if sidecar else None
    if resolved_sidecar_profile:
        click.echo(f"🧩 Sidecar profile: {resolved_sidecar_profile.name}")
        click.echo(f"   {resolved_sidecar_profile.description}")

    # Check Python version compatibility
    check_python_version()

    if not skip_deps:
        # Ensure dependencies are properly installed
        ensure_dependencies(resolved_sidecar_profile)

    if clean:
        clean_build_dirs()

    success = True

    if target in ["exe", "all"]:
        build_name = "aurora-sidecar" if sidecar else "Aurora"
        success &= build_executable(
            executable_name=build_name,
            onefile=onefile or sidecar,
            sidecar_profile=resolved_sidecar_profile,
        )

    if target in ["container", "all"]:
        success &= build_container()

    if success:
        click.echo("\n🎉 Build completed successfully!")
        if target == "exe":
            click.echo("📱 Distribute the executable to end users")
            build_name = "aurora-sidecar" if sidecar else "Aurora"
            binary_name = f"{build_name}.exe" if platform.system() == "Windows" else build_name
            output_dist_dir = (
                sidecar_dist_dir(resolved_sidecar_profile)
                if resolved_sidecar_profile
                else DIST_DIR
            )
            executable_path = output_dist_dir / binary_name
            if not executable_path.is_file():
                nested_path = output_dist_dir / build_name / binary_name
                if nested_path.is_file():
                    executable_path = nested_path
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
