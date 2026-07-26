"""Atomic live mesh policy snapshots for Gateway mesh consumers."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.services.gateway.config import MeshConfig


@dataclass(frozen=True, slots=True)
class MeshPolicySnapshot:
    """Immutable mesh policy snapshot published as one whole reference."""

    revision: int
    source_revision: int | None
    mesh_config: MeshConfig


MeshPolicyProvider = Callable[[], MeshPolicySnapshot]


class MeshPolicyStore:
    """Thread-safe whole-reference store for live mesh policy snapshots."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._snapshot = MeshPolicySnapshot(
            revision=0,
            source_revision=None,
            mesh_config=MeshConfig(enabled=False),
        )

    def current(self) -> MeshPolicySnapshot:
        """Return the current immutable policy snapshot."""

        with self._lock:
            return self._snapshot

    def provider(self) -> MeshPolicyProvider:
        """Return a synchronous provider suitable for long-lived consumers."""

        return self.current

    def replace(
        self,
        mesh_config: MeshConfig | dict[str, Any],
        *,
        source_revision: int | None = None,
    ) -> MeshPolicySnapshot:
        """Atomically publish a new policy if its source revision is fresh.

        Duplicate policy content and duplicate/stale source revisions are no-ops.
        The public store revision advances only when enforcement material changes.
        """

        with self._lock:
            current = self._snapshot
            if (
                source_revision is not None
                and current.source_revision is not None
                and source_revision <= current.source_revision
            ):
                return current
            normalized = _normalize_mesh_config(mesh_config)
            if normalized == current.mesh_config:
                if source_revision is not None and source_revision > (
                    current.source_revision or -1
                ):
                    self._snapshot = MeshPolicySnapshot(
                        revision=current.revision,
                        source_revision=source_revision,
                        mesh_config=current.mesh_config,
                    )
                    return self._snapshot
                return current
            self._snapshot = MeshPolicySnapshot(
                revision=current.revision + 1,
                source_revision=(
                    source_revision if source_revision is not None else current.source_revision
                ),
                mesh_config=normalized,
            )
            return self._snapshot


def _normalize_mesh_config(mesh_config: MeshConfig | dict[str, Any]) -> MeshConfig:
    """Clone and normalize a candidate before it becomes the live policy pointer."""

    if isinstance(mesh_config, MeshConfig):
        return MeshConfig.model_validate(mesh_config.model_dump(mode="python"))
    return MeshConfig.model_validate(mesh_config)
