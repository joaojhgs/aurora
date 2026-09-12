#!/usr/bin/env python3
"""Forward or reverse migrate mesh service policy config files."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import tempfile
from pathlib import Path

from app.services.config.mesh_policy_migration import (
    create_tooling_downgrade_receipt,
    migrate_mesh_service_policies,
    preflight_tooling_downgrade_start,
    reverse_migrate_service_policy,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--reverse", action="store_true")
    parser.add_argument("--in-place", action="store_true")
    parser.add_argument("--acknowledge-unsafe-downgrade", action="store_true")
    parser.add_argument("--fail-closed-required-provider-features", action="store_true")
    parser.add_argument("--preflight-downgrade-start", action="store_true")
    parser.add_argument(
        "--tooling-export-snapshot",
        type=Path,
        help="redacted durable Tooling export snapshot used for fail-closed reverse migration",
    )
    args = parser.parse_args()

    if args.reverse and args.tooling_export_snapshot is None:
        parser.error(
            "--reverse requires --tooling-export-snapshot with a durable redacted "
            "Tooling export policy snapshot"
        )

    output = args.input if args.in_place else args.output
    if output is None:
        parser.error("--output is required unless --in-place is used")
    try:
        destructive_reverse = args.reverse and args.input.resolve().samefile(output.resolve())
    except FileNotFoundError:
        destructive_reverse = args.reverse and args.input.resolve() == output.resolve()
    if destructive_reverse and not args.acknowledge_unsafe_downgrade:
        parser.error("reverse in-place overwrite requires --acknowledge-unsafe-downgrade")

    original = json.loads(args.input.read_text())
    if args.reverse:
        tooling_export_snapshot = json.loads(args.tooling_export_snapshot.read_text())
        result = reverse_migrate_service_policy(
            original,
            fail_closed_required_provider_features=args.fail_closed_required_provider_features,
            tooling_export_snapshot=tooling_export_snapshot,
        )
        if result.tooling_mesh_switches_must_disable:
            disabled = ", ".join(result.tooling_mesh_switches_must_disable)
            print(f"required downgrade action: disable {disabled}")
        for reason in result.tooling_export_reasons:
            print(f"Tooling export fail-closed: {reason}")
        if result.refused_reasons:
            for reason in result.refused_reasons:
                print(f"refused: {reason}")
            return 2
        migrated = result.config
    else:
        migrated = migrate_mesh_service_policies(original).config

    if args.reverse:
        try:
            receipt = create_tooling_downgrade_receipt(
                output_config=migrated,
                output_file=str(output),
                tooling_export_snapshot=tooling_export_snapshot,
            )
        except RuntimeError as exc:
            print(f"unsafe_downgrade_blocked: {exc}")
            return 3
        if args.preflight_downgrade_start:
            preflight = preflight_tooling_downgrade_start(
                output_config=migrated,
                output_file=str(output),
                tooling_export_snapshot=tooling_export_snapshot,
            )
            if not preflight.ok:
                print(preflight.reason)
                return 3
            print(f"downgrade receipt: {receipt}")
    _atomic_write(output, migrated)
    return 0


def _atomic_write(path: Path, payload: dict) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
