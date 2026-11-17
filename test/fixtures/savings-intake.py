"""Offline transport for the ccc/Polychat contract test. Run in the Polychat checkout."""
import asyncio
import json
import sys
from contextlib import asynccontextmanager, nullcontext
from functools import partial
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from polychat import savings_store
from polychat.routes import ccc_diagnostics as route


async def main() -> None:
    db = savings_store._SavingsFakeDB()
    refuse_commit = True

    @asynccontextmanager
    async def transaction():
        rows, writes = db.rows.copy(), db.writes.copy()
        yield
        if refuse_commit:
            db.rows, db.writes = rows, writes
            raise RuntimeError("simulated commit failure")

    db.begin = transaction
    app = FastAPI()
    app.include_router(route.ccc_diagnostics_router)
    ingest = partial(route.ingest_batch, lookup=AsyncMock(return_value={"id": "owner"}),
                     note_signed_in=lambda *_: None, record=lambda *_: None)
    wire = json.load(sys.stdin)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://offline") as client:
        with patch.object(route, "ingest_batch", ingest), \
             patch.object(savings_store, "async_session_factory", lambda: nullcontext(db)):
            failed = await client.post(wire["path"], json=wire["body"], headers=wire["headers"])
            assert failed.status_code == 202 and failed.json()["savings_stored"] is None
            refuse_commit = False
            # Replay after loss of the first successful response.
            for _ in range(2):
                response = await client.post(wire["path"], json=wire["body"], headers=wire["headers"])
    assert len(db.writes) == 1
    print(json.dumps({"status": response.status_code, "response": response.json()}))


asyncio.run(main())
