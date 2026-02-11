"""Script to update documentation references to new structure."""

import re
from pathlib import Path

# Mapping of old paths to new paths
PATH_MAPPINGS = {
    r"app\.config\.config_api": "app.shared.config.interface.ConfigAPI",
    r"app\.config\.config_manager": "app.services.config.config_manager.ConfigManager",
    r"from app\.config": "from app.shared.config",
    r"from app\.db\.": "from app.services.db.",
    r"from app\.orchestrator\.": "from app.services.orchestrator.",
    r"from app\.scheduler\.": "from app.services.scheduler.",
    r"from app\.tts\.": "from app.services.tts.",
    r"from app\.tooling\.": "from app.services.tooling.",
    r"from app\.stt_": "from app.services.stt_",
    r"app/db/": "app/services/db/",
    r"app/orchestrator/": "app/services/orchestrator/",
    r"app/scheduler/": "app/services/scheduler/",
    r"app/tts/": "app/services/tts/",
    r"app/tooling/": "app/services/tooling/",
    r"app/stt_": "app/services/stt_",
    r"app/config/": "app/services/config/",
    r"app/contracts/": "app/shared/contracts/",
}


def update_file(file_path: Path) -> bool:
    """Update a single documentation file.

    Args:
        file_path: Path to the file to update

    Returns:
        True if file was updated, False otherwise
    """
    try:
        content = file_path.read_text(encoding="utf-8")
        original = content

        for old_pattern, new_path in PATH_MAPPINGS.items():
            content = re.sub(old_pattern, new_path, content)

        if content != original:
            file_path.write_text(content, encoding="utf-8")
            print(f"Updated: {file_path}")
            return True
        return False
    except Exception as e:
        print(f"Error updating {file_path}: {e}")
        return False


def main():
    """Update all documentation files."""
    docs_dir = Path("docs")
    readme_files = [Path("README.md"), Path("README.process-mode.md")]

    updated_count = 0

    # Update docs directory
    if docs_dir.exists():
        for file_path in docs_dir.rglob("*.md"):
            if update_file(file_path):
                updated_count += 1

    # Update README files
    for file_path in readme_files:
        if file_path.exists() and update_file(file_path):
            updated_count += 1

    print(f"\nUpdated {updated_count} files")


if __name__ == "__main__":
    main()
