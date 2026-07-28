#!/usr/bin/env python3
"""Generate deterministic local-data SQLite migration manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

SQL_NAME_RE = re.compile(r"^(?P<version>\d{4})_(?P<name>[a-z0-9_]+)\.sql$")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MIGRATIONS_DIR = ROOT / "packages/aurora-sdk/src/local-data/migrations/sqlite"
DEFAULT_TS_OUTPUT = ROOT / "packages/aurora-sdk/src/local-data/migration-manifest.ts"
DEFAULT_SCHEMA_OUTPUT = ROOT / "packages/aurora-sdk/src/local-data/generated/local-data.schema.json"


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    file: str
    checksum: str
    min_app_version: str
    requires_pre_migration_export: bool
    ledger_sql: str


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--migrations-dir", type=Path, default=DEFAULT_MIGRATIONS_DIR)
    parser.add_argument("--manifest-output", type=Path, default=DEFAULT_MIGRATIONS_DIR / "manifest.json")
    parser.add_argument("--ts-output", type=Path, default=DEFAULT_TS_OUTPUT)
    parser.add_argument("--rust-output", type=Path, default=DEFAULT_MIGRATIONS_DIR / "manifest.rust.json")
    parser.add_argument("--schema-output", type=Path, default=DEFAULT_SCHEMA_OUTPUT)
    args = parser.parse_args()

    migrations = read_migrations(args.migrations_dir)
    manifest = {
        "formatVersion": 1,
        "databaseName": "aurora-lightweight.db",
        "latestVersion": migrations[-1].version if migrations else 0,
        "migrations": [migration.__dict__ for migration in migrations],
    }
    write_json(args.manifest_output, manifest)
    write_json(args.rust_output, rust_manifest(migrations))
    write_ts(args.ts_output, manifest)
    write_json(args.schema_output, build_zod_schema_artifact())


def read_migrations(directory: Path) -> list[Migration]:
    files = sorted(directory.glob("*.sql"))
    migrations: list[Migration] = []
    for expected, path in enumerate(files, start=1):
        match = SQL_NAME_RE.match(path.name)
        if match is None:
            raise SystemExit(f"invalid migration filename: {path.name}")
        version = int(match.group("version"))
        if version != expected:
            raise SystemExit(f"non-contiguous migration version: expected {expected:04d}, got {version:04d}")
        sql = path.read_text(encoding="utf-8")
        checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        name = match.group("name")
        migrations.append(
            Migration(
                version=version,
                name=name,
                file=path.name,
                checksum=checksum,
                min_app_version="0.1.0",
                requires_pre_migration_export=False,
                ledger_sql=ledger_sql(version, name, checksum),
            )
        )
    return migrations


def ledger_sql(version: int, name: str, checksum: str) -> str:
    return (
        "INSERT INTO aurora_schema_migrations (version, name, checksum, applied_at_ms) "
        f"VALUES ({version}, '{name}', '{checksum}', :applied_at_ms);\n"
        f"PRAGMA user_version = {version};"
    )


def rust_manifest(migrations: list[Migration]) -> dict[str, object]:
    return {
        "formatVersion": 1,
        "databaseName": "aurora-lightweight.db",
        "migrations": [
            {
                "version": migration.version,
                "name": migration.name,
                "file": migration.file,
                "checksum": migration.checksum,
                "includeStrPath": f"../../../../../packages/aurora-sdk/src/local-data/migrations/sqlite/{migration.file}",
                "ledgerSql": migration.ledger_sql,
            }
            for migration in migrations
        ],
    }


def write_ts(path: Path, manifest: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(manifest, indent=2, sort_keys=True)
    path.write_text(
        "import { validateLocalDataMigrationManifest } from './migration-manifest-runtime.js'\n\n"
        "export * from './migration-manifest-runtime.js'\n\n"
        f"export const LOCAL_DATA_MIGRATION_MANIFEST = {encoded} as const\n\n"
        "export const localDataMigrationManifest = validateLocalDataMigrationManifest(LOCAL_DATA_MIGRATION_MANIFEST)\n",
        encoding="utf-8",
    )


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_zod_schema_artifact() -> dict[str, object]:
    schema_source = ROOT / "packages/aurora-sdk/src/local-data/schema-artifact.ts"
    with tempfile.TemporaryDirectory(prefix="aurora-local-data-schema-") as tmp:
        tmp_path = Path(tmp)
        entry = tmp_path / "entry.ts"
        bundle = tmp_path / "entry.mjs"
        entry.write_text(
            "import { buildLocalDataJsonSchemaArtifact } from "
            f"{json.dumps(schema_source.as_posix())}\n"
            "console.log(JSON.stringify(buildLocalDataJsonSchemaArtifact()))\n",
            encoding="utf-8",
        )
        subprocess.run(
            [
                "pnpm",
                "exec",
                "esbuild",
                str(entry),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--log-level=silent",
                f"--outfile={bundle}",
            ],
            cwd=ROOT,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        completed = subprocess.run(
            ["node", str(bundle)],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        )
    return json.loads(completed.stdout)


if __name__ == "__main__":
    main()
