#!/usr/bin/env python3
"""Analyze transitive dependencies for Aurora packages.

This script uses pipdeptree to identify which "unused" dependencies
are actually transitive dependencies of packages that ARE used.
"""

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# Direct dependencies that are actually used
USED_PACKAGES = {
    "faster-whisper",
    "RealtimeSTT",
    "PyAudio",
    "openwakeword",
    "webrtcvad-wheels",
    "piper-tts",
    "piper-phonemize",
    "realtimetts",
    "numpy",
    "scipy",
    "onnxruntime",
    "torch",
    "torchaudio",
    "torchvision",
    "langchain",
    "langchain-core",
    "langchain-community",
    "langchain-huggingface",
    "langchain-openai",
    "langchain-google-community",
    "langchain-mcp-adapters",
    "langgraph",
    "sentence-transformers",
    "transformers",
    "huggingface-hub",
    "aiosqlite",
    "sqlite-vec",
    "SQLAlchemy",
    "croniter",
    "aiohttp",
    "requests",
    "httpx",
    "urllib3",
    "duckduckgo-search",
    "pydantic",
    "pydantic-settings",
    "jsonschema",
    "python-dotenv",
    "coloredlogs",
    "click",
    "colorama",
    "psutil",
    "tenacity",
    "bullmq",
    "Jinja2",
    "MarkupSafe",
    "pvporcupine",
    "ctranslate2",
    "tokenizers",
    "tiktoken",
    "Pillow",
    "tqdm",
    "emoji",
    "regex",
}


def get_transitive_deps(package: str) -> set[str]:
    """Get transitive dependencies for a package."""
    try:
        result = subprocess.run(
            ["pipdeptree", "-p", package, "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return set()

        data = json.loads(result.stdout)
        deps = set()

        def extract_deps(node):
            if isinstance(node, dict):
                package_name = node.get("package", {}).get("key", "").lower()
                if package_name:
                    deps.add(package_name)
                for dep in node.get("dependencies", []):
                    extract_deps(dep)

        for item in data:
            extract_deps(item)

        return deps
    except Exception as e:
        print(f"Error getting transitive deps for {package}: {e}", file=sys.stderr)
        return set()


def main():
    """Main entry point."""
    # Get all transitive dependencies
    all_transitive = set()
    transitive_map = {}

    print("Analyzing transitive dependencies...", file=sys.stderr)
    for package in USED_PACKAGES:
        print(f"  Checking {package}...", file=sys.stderr)
        deps = get_transitive_deps(package)
        transitive_map[package] = deps
        all_transitive.update(deps)

    # Read declared dependencies from pyproject.toml
    pyproject_file = Path("pyproject.toml")
    declared = set()
    if pyproject_file.exists():
        try:
            # Try tomllib (Python 3.11+)
            try:
                import tomllib

                with open(pyproject_file, "rb") as f:
                    data = tomllib.load(f)
            except ImportError:
                # Fallback to toml package
                try:
                    import toml

                    with open(pyproject_file) as f:
                        data = toml.load(f)
                except ImportError:
                    print(
                        "Error: Need tomllib (Python 3.11+) or toml package to read pyproject.toml",
                        file=sys.stderr,
                    )
                    sys.exit(1)

            # Get core dependencies
            project = data.get("project", {})
            for dep in project.get("dependencies", []):
                # Extract package name (before ==, >=, etc.)
                pkg = dep.split(">=")[0].split("<=")[0].split("==")[0].split("[")[0].strip().lower()
                declared.add(pkg)

            # Get all optional dependencies
            optional_deps = project.get("optional-dependencies", {})
            for _group_name, deps in optional_deps.items():
                for dep in deps:
                    # Handle nested extras (e.g., "aurora[extra1,extra2]")
                    if isinstance(dep, str):
                        # Extract package name (before ==, >=, etc., and before [)
                        pkg = (
                            dep.split(">=")[0]
                            .split("<=")[0]
                            .split("==")[0]
                            .split("[")[0]
                            .strip()
                            .lower()
                        )
                        if pkg and not pkg.startswith("aurora"):
                            declared.add(pkg)
        except Exception as e:
            print(f"Error reading pyproject.toml: {e}", file=sys.stderr)
            sys.exit(1)

    # Categorize dependencies
    actually_unused = declared - USED_PACKAGES - all_transitive
    transitive = declared & all_transitive
    direct = declared & USED_PACKAGES

    # Output results
    output = {
        "direct_dependencies": sorted(direct),
        "transitive_dependencies": sorted(transitive),
        "actually_unused": sorted(actually_unused),
        "transitive_map": {k: sorted(v) for k, v in transitive_map.items()},
    }

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
