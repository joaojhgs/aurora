"""Regenerate all config artifacts from config_schema.json.

This is Aurora-specific: paths, base class, codegen options are all
hardcoded business logic.  Run via ``make generate-config``.
"""

from __future__ import annotations

import json
import keyword
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "app/services/config/config_schema.json"
MODELS_OUT = ROOT / "app/shared/config/models.py"
KEYS_OUT = ROOT / "app/shared/config/keys.py"
DEFAULTS_OUT = ROOT / "app/services/config/config_defaults.json"


def generate_models() -> None:
    """Schema -> Pydantic models via datamodel-code-generator."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(SCHEMA),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(MODELS_OUT),
            "--use-default",
            "--field-constraints",
            "--use-field-description",
            "--enum-field-as-literal",
            "all",
            "--disable-timestamp",
            "--base-class",
            "app.shared.config.models_base.BaseConfigModel",
        ],
        check=True,
    )


def generate_keys() -> None:
    """Schema -> nested ConfigKeys object (every dot-path in the schema tree)."""
    with open(SCHEMA) as f:
        schema = json.load(f)

    defs = schema.get("$defs", {})

    def _resolve(node: dict) -> dict:
        if "$ref" in node:
            ref_name = node["$ref"].rsplit("/", 1)[-1]
            return defs.get(ref_name, {})
        return node

    def _walk(node: dict, prefix: str = ""):
        for key, sub in node.get("properties", {}).items():
            path = f"{prefix}.{key}" if prefix else key
            yield path
            resolved = _resolve(sub)
            if resolved.get("type") == "object":
                yield from _walk(resolved, path)

    paths = sorted(_walk(schema))
    tree: dict[str, dict] = {}
    for path in paths:
        cursor = tree
        for part in path.split("."):
            cursor = cursor.setdefault(part, {})

    def _node_at_path(root: dict[str, dict], path: str) -> dict[str, dict]:
        cursor = root
        for part in path.split("."):
            cursor = cursor[part]
        return cursor

    def _identifier(name: str) -> str:
        candidate = name.replace("-", "_")
        if not candidate.isidentifier() or keyword.iskeyword(candidate):
            msg = f"Config key component {name!r} cannot be represented as an attribute"
            raise ValueError(msg)
        return candidate

    def _class_name(path: str) -> str:
        parts = [
            "".join(piece.capitalize() for piece in component.replace("-", "_").split("_"))
            for component in path.split(".")
        ]
        return f"_{''.join(parts)}ConfigPath"

    object_paths = sorted(
        (path for path in paths if _node_at_path(tree, path)),
        key=lambda value: value.count("."),
        reverse=True,
    )
    lines = [
        "from __future__ import annotations",
        "",
        "",
        "class ConfigPath(str):",
        '    """String-compatible typed config path."""',
        "",
        "    def __new__(cls, path: str) -> ConfigPath:",
        "        return str.__new__(cls, path)",
        "",
        "    @property",
        "    def path(self) -> str:",
        '        """Return the dot-delimited config path."""',
        "        return str(self)",
        "",
    ]

    for path in object_paths:
        children = _node_at_path(tree, path)
        class_name = _class_name(path)
        lines.extend(["", "", f"class {class_name}(ConfigPath):"])
        for child_name, grand_children in children.items():
            child_path = f"{path}.{child_name}"
            annotation = _class_name(child_path) if grand_children else "ConfigPath"
            lines.append(f"    {_identifier(child_name)}: {annotation}")
        lines.extend(
            [
                "",
                f"    def __new__(cls) -> {class_name}:",
                f'        self = super().__new__(cls, "{path}")',
            ]
        )
        for child_name, grand_children in children.items():
            child_path = f"{path}.{child_name}"
            value = (
                f"{_class_name(child_path)}()" if grand_children else f'ConfigPath("{child_path}")'
            )
            lines.append(f"        self.{_identifier(child_name)} = {value}")
        lines.append("        return self")

    lines.extend(
        [
            "",
            "",
            "class _ConfigKeys:",
            '    """Auto-generated from config_schema.json. Do not edit; run `make generate-config`."""',
            "",
        ]
    )
    for child_name, grand_children in tree.items():
        annotation = _class_name(child_name) if grand_children else "ConfigPath"
        lines.append(f"    {_identifier(child_name)}: {annotation}")
    lines.extend(["", "    def __init__(self) -> None:"])
    for child_name, grand_children in tree.items():
        value = f"{_class_name(child_name)}()" if grand_children else f'ConfigPath("{child_name}")'
        lines.append(f"        self.{_identifier(child_name)} = {value}")
    lines.extend(["", "", "ConfigKeys = _ConfigKeys()"])

    KEYS_OUT.write_text("\n".join(lines) + "\n")


def generate_defaults() -> None:
    """Schema -> config_defaults.json by walking the schema and collecting all defaults."""
    with open(SCHEMA) as f:
        schema = json.load(f)

    defs = schema.get("$defs", {})

    def _resolve(node: dict) -> dict:
        """Resolve $ref pointers."""
        if "$ref" in node:
            ref_path = node["$ref"]  # e.g. "#/$defs/mesh_sharing"
            ref_name = ref_path.rsplit("/", 1)[-1]
            return defs.get(ref_name, {})
        return node

    def _extract(node: dict):
        """Recursively extract defaults from a JSON Schema node."""
        node = _resolve(node)
        if node.get("type") == "object":
            obj = {}
            for key, prop in node.get("properties", {}).items():
                prop = _resolve(prop)
                if prop.get("type") == "object":
                    obj[key] = _extract(prop)
                elif "default" in prop:
                    obj[key] = prop["default"]
            return obj
        return node.get("default")

    defaults = _extract(schema)
    with open(DEFAULTS_OUT, "w") as f:
        json.dump(defaults, f, indent=2)
        f.write("\n")


def postprocess_models() -> None:
    """Remove codegen artifacts that conflict with Aurora conventions.

    - ``additionalProperties: false`` in JSON Schema causes codegen to emit
      ``model_config = ConfigDict(extra='forbid')`` on every class.  We want
      the base class's ``extra='ignore'`` to apply instead (forward-compat in
      distributed systems), so strip those overrides.
    - Remove unused imports that result from stripping ConfigDict usage.
    """
    import re

    text = MODELS_OUT.read_text()
    # Remove model_config = ConfigDict(extra='forbid'|'allow',) blocks
    text = re.sub(
        r"    model_config = ConfigDict\(\s*extra='(?:forbid|allow)',\s*\)\n",
        "",
        text,
    )
    # Remove ConfigDict from imports if no longer used
    if "ConfigDict" not in text.split("class ")[0].split("ConfigDict")[-1:][0]:
        text = text.replace(", ConfigDict,", ",")
        text = text.replace("from pydantic import ConfigDict, ", "from pydantic import ")
        text = text.replace(", ConfigDict", "")
    MODELS_OUT.write_text(text)


def format_generated() -> None:
    """Run ruff on generated files."""
    targets = [str(MODELS_OUT), str(KEYS_OUT)]
    subprocess.run([sys.executable, "-m", "ruff", "format", *targets], check=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "ruff",
            "check",
            "--fix",
            "--ignore",
            "UP042",  # str+Enum → StrEnum; StrEnum needs Python 3.11+, we support 3.10
            *targets,
        ],
        check=True,
    )


GENERATED_FILES = [MODELS_OUT, KEYS_OUT, DEFAULTS_OUT]


def main() -> None:
    parser = ArgumentParser(description="Regenerate Aurora config artifacts from schema.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if regeneration changes any generated config artifact.",
    )
    args = parser.parse_args()

    before = {path: path.read_text() if path.exists() else None for path in GENERATED_FILES}

    print("1/5  Generating Pydantic models from schema...")
    generate_models()
    print("2/5  Post-processing models (strip extra='forbid' overrides)...")
    postprocess_models()
    print("3/5  Generating nested ConfigKeys object from schema...")
    generate_keys()
    print("4/5  Formatting generated files...")
    format_generated()
    print("5/5  Generating config_defaults.json from models...")
    generate_defaults()
    print("\n✓ All config artifacts regenerated from config_schema.json")

    if args.check:
        changed = [path for path in GENERATED_FILES if before[path] != path.read_text()]
        if changed:
            print(
                "\nGenerated config files are out of sync with config_schema.json. "
                "Run 'make generate-config' and commit."
            )
            for path in changed:
                print(f" - {path.relative_to(ROOT)}")
            raise SystemExit(1)


if __name__ == "__main__":
    main()
