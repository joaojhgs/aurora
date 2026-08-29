"""Bounded tar extraction that rejects traversal, links, and devices."""

from __future__ import annotations

import tarfile
from pathlib import Path


class UnsafeTarError(ValueError):
    """Raised when an archive member is outside the destination or is a link/device."""


def safe_extract_tar(archive: Path, dest: Path, *, mode: str = "r:*") -> None:
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    with tarfile.open(archive, mode) as tar:
        for member in tar.getmembers():
            _reject_unsafe_member(member, dest_resolved)
        if hasattr(tarfile, "data_filter"):
            tar.extractall(dest, filter="data")
            return
        tar.extractall(dest)


def _reject_unsafe_member(member: tarfile.TarInfo, dest_resolved: Path) -> None:
    name = Path(member.name)
    if name.is_absolute() or ".." in name.parts:
        raise UnsafeTarError(f"unsafe tar member path: {member.name}")
    if member.issym() or member.islnk():
        raise UnsafeTarError(f"refusing link member: {member.name}")
    if member.isdev() or member.isfifo() or member.ischr() or member.isblk():
        raise UnsafeTarError(f"refusing device member: {member.name}")
    target = (dest_resolved / member.name).resolve()
    if dest_resolved not in target.parents and target != dest_resolved:
        raise UnsafeTarError(f"unsafe tar member path: {member.name}")
