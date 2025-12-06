#!/usr/bin/env python3
"""Dependency Analysis Script for Aurora

This script analyzes Python imports across the codebase to identify:
- Which packages each service actually uses
- Shared dependencies across services
- Service-specific dependencies
- Potentially unused dependencies

Usage:
    python scripts/analyze-dependencies.py --service config
    python scripts/analyze-dependencies.py --all
    python scripts/analyze-dependencies.py --compare pyproject.toml
"""

import ast
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Set

# Mapping of import names to package names
# Some packages have different import names (e.g., PIL -> Pillow)
IMPORT_TO_PACKAGE = {
    "PIL": "Pillow",
    "yaml": "PyYAML",
    "dotenv": "python-dotenv",
    "cv2": "opencv-python",
    "sklearn": "scikit-learn",
    "bs4": "beautifulsoup4",
    "dateutil": "python-dateutil",
    "pkg_resources": "setuptools",
    "pkgutil": "setuptools",
    "distutils": "setuptools",
    "pydantic_settings": "pydantic-settings",
    "langchain_core": "langchain-core",
    "langchain_community": "langchain-community",
    "langchain_text_splitters": "langchain-text-splitters",
    "langchain_huggingface": "langchain-huggingface",
    "langchain_openai": "langchain-openai",
    "langchain_mcp_adapters": "langchain-mcp-adapters",
    "langgraph_checkpoint": "langgraph-checkpoint",
    "langgraph_sdk": "langgraph-sdk",
    "sqlite_vec": "sqlite-vec",
    "webrtcvad": "webrtcvad-wheels",
    "duckduckgo_search": "duckduckgo-search",
    "openwakeword": "openwakeword",
    "faster_whisper": "faster-whisper",
    "RealtimeSTT": "RealtimeSTT",
    "realtimetts": "realtimetts",
    "piper_tts": "piper-tts",
    "piper_phonemize": "piper-phonemize",
    "ctranslate2": "ctranslate2",
    "sentence_transformers": "sentence-transformers",
    "huggingface_hub": "huggingface-hub",
    "tiktoken": "tiktoken",
    "tokenizers": "tokenizers",
    "transformers": "transformers",
    "numpy": "numpy",
    "scipy": "scipy",
    "torch": "torch",
    "torchaudio": "torchaudio",
    "torchvision": "torchvision",
    "onnxruntime": "onnxruntime",
    "pyaudio": "PyAudio",
    "pydantic": "pydantic",
    "pydantic_settings": "pydantic-settings",
    "jsonschema": "jsonschema",
    "aiosqlite": "aiosqlite",
    "sqlalchemy": "SQLAlchemy",
    "croniter": "croniter",
    "requests": "requests",
    "aiohttp": "aiohttp",
    "httpx": "httpx",
    "urllib3": "urllib3",
    "langchain": "langchain",
    "langgraph": "langgraph",
    "langsmith": "langsmith",
    "bullmq": "bullmq",
    "janus": "janus",
    "halo": "halo",
    "tqdm": "tqdm",
    "emoji": "emoji",
    "regex": "regex",
    "jinja2": "Jinja2",
    "markupsafe": "MarkupSafe",
    "coloredlogs": "coloredlogs",
    "click": "click",
    "colorama": "colorama",
    "psutil": "psutil",
    "tenacity": "tenacity",
    "python_dotenv": "python-dotenv",
}


class ImportVisitor(ast.NodeVisitor):
    """AST visitor to extract import statements."""

    def __init__(self):
        self.imports: set[str] = set()
        self.from_imports: set[str] = set()

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.add(alias.name.split(".")[0])
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            self.from_imports.add(node.module.split(".")[0])
        self.generic_visit(node)


def analyze_file(file_path: Path) -> dict[str, set[str]]:
    """Analyze a Python file and extract imports."""
    try:
        with open(file_path, encoding="utf-8") as f:
            content = f.read()
        tree = ast.parse(content, filename=str(file_path))
        visitor = ImportVisitor()
        visitor.visit(tree)
        return {"imports": visitor.imports, "from_imports": visitor.from_imports}
    except Exception as e:
        print(f"Error analyzing {file_path}: {e}", file=sys.stderr)
        return {"imports": set(), "from_imports": set()}


def get_package_name(import_name: str) -> str:
    """Convert import name to package name."""
    # Skip internal app imports
    if import_name.startswith("app") or import_name.startswith("modules"):
        return None

    # Skip __future__ and other special imports
    if import_name.startswith("__") or import_name in ["future", "typing", "collections", "enum", "abc"]:
        return None

    # Check mapping first
    if import_name in IMPORT_TO_PACKAGE:
        return IMPORT_TO_PACKAGE[import_name]
    # Standard library modules (approximate check)
    stdlib_modules = {
        "sys",
        "os",
        "json",
        "asyncio",
        "threading",
        "datetime",
        "time",
        "pathlib",
        "typing",
        "collections",
        "enum",
        "abc",
        "logging",
        "functools",
        "itertools",
        "hashlib",
        "base64",
        "urllib",
        "http",
        "email",
        "html",
        "xml",
        "sqlite3",
        "multiprocessing",
        "subprocess",
        "signal",
        "socket",
        "ssl",
        "tempfile",
        "shutil",
        "glob",
        "re",
        "string",
        "math",
        "random",
        "decimal",
        "fractions",
        "statistics",
        "copy",
        "pickle",
        "io",
        "gzip",
        "zipfile",
        "tarfile",
        "csv",
        "configparser",
        "argparse",
        "getopt",
        "readline",
        "rlcompleter",
        "pdb",
        "profile",
        "pstats",
        "timeit",
        "trace",
        "tracemalloc",
        "gc",
        "inspect",
        "site",
        "sysconfig",
        "platform",
        "errno",
        "ctypes",
        "struct",
        "codecs",
        "unicodedata",
        "locale",
        "gettext",
        "keyword",
        "token",
        "tokenize",
        "ast",
        "symtable",
        "symbol",
        "parser",
        "dis",
        "pickletools",
        "tabnanny",
        "py_compile",
        "compileall",
        "pyclbr",
        "doctest",
        "unittest",
        "test",
        "lib2to3",
        "pydoc",
        "doctest",
        "unittest",
        "2to3",
        "pydoc",
        "distutils",
        "ensurepip",
        "venv",
        "zipapp",
        "faulthandler",
        "pdb",
        "profile",
        "pstats",
        "timeit",
        "trace",
        "tracemalloc",
        "gc",
        "inspect",
        "site",
        "sysconfig",
        "platform",
        "errno",
        "ctypes",
        "struct",
        "codecs",
        "unicodedata",
        "locale",
        "gettext",
    }
    if import_name in stdlib_modules:
        return None  # Standard library, not a package
    # Default: assume package name matches import name (lowercase, hyphens)
    return import_name.replace("_", "-").lower()


def analyze_service(service_path: Path) -> dict[str, any]:
    """Analyze all Python files in a service directory."""
    imports = set()
    from_imports = set()
    files_analyzed = 0

    for py_file in service_path.rglob("*.py"):
        if "__pycache__" in str(py_file) or ".pyc" in str(py_file):
            continue
        result = analyze_file(py_file)
        imports.update(result["imports"])
        from_imports.update(result["from_imports"])
        files_analyzed += 1

    # Convert to package names
    packages = set()
    for imp in imports.union(from_imports):
        pkg = get_package_name(imp)
        if pkg:
            packages.add(pkg)

    return {
        "packages": sorted(packages),
        "imports": sorted(imports),
        "from_imports": sorted(from_imports),
        "files_analyzed": files_analyzed,
    }


def analyze_all_services() -> dict[str, dict]:
    """Analyze all services."""
    project_root = Path(__file__).parent.parent
    services_dir = project_root / "app" / "services"

    results = {}
    for service_dir in services_dir.iterdir():
        if service_dir.is_dir() and service_dir.name != "__pycache__":
            service_name = service_dir.name
            print(f"Analyzing {service_name}...", file=sys.stderr)
            results[service_name] = analyze_service(service_dir)

    return results


def find_shared_dependencies(service_results: dict[str, dict]) -> dict[str, list[str]]:
    """Find dependencies shared across services."""
    all_packages = defaultdict(list)

    for service_name, result in service_results.items():
        for pkg in result["packages"]:
            all_packages[pkg].append(service_name)

    # Find packages used by multiple services
    shared = {pkg: services for pkg, services in all_packages.items() if len(services) > 1}
    service_specific = {pkg: services for pkg, services in all_packages.items() if len(services) == 1}

    return {
        "shared": shared,
        "service_specific": service_specific,
        "all": all_packages,
    }


def get_dependencies_from_pyproject(pyproject_file: Path) -> set[str]:
    """Extract all dependencies from pyproject.toml."""
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
                print("Error: Need tomllib (Python 3.11+) or toml package to read pyproject.toml", file=sys.stderr)
                return set()

        declared_packages = set()

        # Get core dependencies
        project = data.get("project", {})
        for dep in project.get("dependencies", []):
            # Extract package name (before ==, >=, etc.)
            pkg = re.split(r"[>=<!=]", dep)[0].strip().lower()
            declared_packages.add(pkg)

        # Get all optional dependencies
        optional_deps = project.get("optional-dependencies", {})
        for group_name, deps in optional_deps.items():
            for dep in deps:
                # Handle nested extras (e.g., "aurora[extra1,extra2]")
                if isinstance(dep, str):
                    # Extract package name (before ==, >=, etc., and before [)
                    pkg = re.split(r"[>=<!=\[\]]", dep)[0].strip().lower()
                    if pkg and not pkg.startswith("aurora"):
                        declared_packages.add(pkg)

        return declared_packages
    except Exception as e:
        print(f"Error reading pyproject.toml: {e}", file=sys.stderr)
        return set()


def compare_with_requirements(requirements_file: Path, service_results: dict[str, dict]) -> dict:
    """Compare actual usage with declared requirements."""
    declared_packages = set()

    # Check if it's pyproject.toml or requirements file
    if requirements_file.name == "pyproject.toml" or str(requirements_file).endswith("pyproject.toml"):
        declared_packages = get_dependencies_from_pyproject(requirements_file)
        if not declared_packages:
            return {"error": f"Failed to read dependencies from {requirements_file}"}
    else:
        # Legacy requirements file support
        if not requirements_file.exists():
            return {"error": f"Requirements file not found: {requirements_file}"}

        # Parse requirements file
        with open(requirements_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                # Extract package name (before ==, >=, etc.)
                pkg = re.split(r"[>=<!=]", line)[0].strip().lower()
                declared_packages.add(pkg)

    # Get all actually used packages
    used_packages = set()
    for result in service_results.values():
        used_packages.update(result["packages"])

    # Compare packages directly (normalization removed as unused)
    unused = declared_packages - used_packages
    missing = used_packages - declared_packages

    return {
        "declared": sorted(declared_packages),
        "used": sorted(used_packages),
        "unused": sorted(unused),
        "missing": sorted(missing),
    }


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Analyze Aurora dependencies")
    parser.add_argument("--service", help="Analyze specific service")
    parser.add_argument("--all", action="store_true", help="Analyze all services")
    parser.add_argument("--compare", help="Compare with requirements file")
    parser.add_argument("--output", help="Output file (JSON)")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="Output format")

    args = parser.parse_args()

    project_root = Path(__file__).parent.parent

    if args.service:
        service_path = project_root / "app" / "services" / args.service
        if not service_path.exists():
            print(f"Error: Service {args.service} not found", file=sys.stderr)
            sys.exit(1)
        result = analyze_service(service_path)
        results = {args.service: result}
    elif args.all:
        results = analyze_all_services()
    else:
        parser.print_help()
        sys.exit(1)

    # Find shared dependencies
    shared_analysis = find_shared_dependencies(results)

    # Compare with requirements if specified
    comparison = None
    if args.compare:
        req_file = Path(args.compare)
        if not req_file.is_absolute():
            req_file = project_root / req_file
        comparison = compare_with_requirements(req_file, results)

    # Prepare output
    output = {
        "services": results,
        "shared_dependencies": shared_analysis["shared"],
        "service_specific_dependencies": shared_analysis["service_specific"],
    }
    if comparison:
        output["comparison"] = comparison

    # Output results
    if args.format == "json":
        output_str = json.dumps(output, indent=2)
    else:
        # Text format
        output_str = "=== Service Dependencies ===\n\n"
        for service, data in results.items():
            output_str += f"{service}:\n"
            output_str += f"  Files analyzed: {data['files_analyzed']}\n"
            output_str += f"  Packages: {', '.join(data['packages'])}\n\n"
        output_str += "\n=== Shared Dependencies ===\n"
        for pkg, services in sorted(shared_analysis["shared"].items()):
            output_str += f"{pkg}: {', '.join(services)}\n"

    if args.output:
        with open(args.output, "w") as f:
            f.write(output_str)
    else:
        print(output_str)


if __name__ == "__main__":
    main()
