# Backup service

**Status:** Current source of truth

BackupService provides admin backup/restore contract surfaces. The current implementation creates and verifies backup manifests and exposes dry-run restore/rollback impact plans. It does not yet perform destructive restore or rollback execution.

## Location

- Service: `app/services/backup/service.py`
- Process entrypoint: `app/services/backup/__main__.py`
- Contracts: `app/shared/contracts/models/backup.py`
- Default storage root: `.aurora/backups`
- Override: `AURORA_BACKUP_DIR`

## Contract methods

| Method | Exposure | Permission | Current behavior |
| --- | --- | --- | --- |
| `Backup.Create` | external | `Backup.manage` | Creates a backup manifest and component metadata. Component payloads remain service-owned. |
| `Backup.List` | external | `Backup.manage` | Lists known backup manifests. |
| `Backup.Verify` | external | `Backup.manage` | Verifies manifest digest and component metadata. |
| `Backup.Restore` | external | `Backup.manage` | Supports dry-run/impact planning. Non-dry-run restore returns `unsupported`. |
| `Backup.Rollback` | external | `Backup.manage` | Supports dry-run/impact planning. Non-dry-run rollback returns `unsupported`. |

## Component boundaries

Backup manifests may describe config, DB/RAG, model, and service-owned state. Payload ownership stays with the owning service; the backup service should not reach into another service directly. Future full restore support must coordinate quiesce/restart and service-owned import/export contracts through the bus.

## Restore and rollback limits

The current service intentionally refuses destructive restore/rollback because a safe executor must be able to:

1. quiesce affected services;
2. create rollback material;
3. restore each service-owned component through typed contracts;
4. restart or reload services in dependency order;
5. emit audit evidence and user-visible status.

Until that executor exists, use dry-run responses as an impact plan only.

## Security posture

- All external backup methods require `Backup.manage`.
- Backup metadata should redact secrets and sensitive paths where possible.
- Backup artifacts may contain personal data depending on requested components; callers must treat storage as sensitive.
- Restore/rollback must remain dry-run unless an explicit, tested service lifecycle executor is added.

## Validation

Useful checks:

```bash
uv run pytest tests/unit -k backup
uv run pytest tests/integration -k backup
```

If no targeted tests exist for a new backup behavior, add them before documenting it as supported.
