"""Typed durable provider exposure ledger operations for Tooling projections."""

from __future__ import annotations

import time

import aiosqlite

from app.services.db.sqlite_connection import database_connection
from app.shared.contracts.models.db import (
    DBGetToolingExposureLedgerRequest,
    DBGetToolingExposureLedgerResponse,
    DBRecordToolingExposuresRequest,
    DBRecordToolingExposuresResponse,
    DBToolingExposureLedgerEntry,
)


async def get_tooling_exposure_ledger(
    db_path: str, request: DBGetToolingExposureLedgerRequest
) -> DBGetToolingExposureLedgerResponse:
    async with database_connection(db_path, row_factory=aiosqlite.Row) as db:
        rows = await (
            await db.execute(
                """SELECT global_tool_id, last_schema_hash
                   FROM tooling_tool_exposure_ledger
                   WHERE recipient_peer_id=? AND provider_id=?
                   ORDER BY global_tool_id""",
                (request.recipient_peer_id, request.provider_id),
            )
        ).fetchall()
    return DBGetToolingExposureLedgerResponse(
        entries=[
            DBToolingExposureLedgerEntry(
                global_tool_id=str(row["global_tool_id"]),
                last_schema_hash=row["last_schema_hash"],
            )
            for row in rows
        ]
    )


async def record_tooling_exposures(
    db_path: str, request: DBRecordToolingExposuresRequest
) -> DBRecordToolingExposuresResponse:
    now = time.time()
    async with database_connection(db_path) as db:
        await db.execute("BEGIN IMMEDIATE")
        await db.executemany(
            """INSERT INTO tooling_tool_exposure_ledger (
                   recipient_peer_id, provider_id, global_tool_id,
                   first_exposed_at, last_exposed_at, last_schema_hash
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(recipient_peer_id, provider_id, global_tool_id) DO UPDATE SET
                   last_exposed_at=excluded.last_exposed_at,
                   last_schema_hash=excluded.last_schema_hash""",
            [
                (
                    request.recipient_peer_id,
                    request.provider_id,
                    entry.global_tool_id,
                    now,
                    now,
                    entry.last_schema_hash,
                )
                for entry in request.entries
            ],
        )
        await db.commit()
    return DBRecordToolingExposuresResponse(recorded_count=len(request.entries))
