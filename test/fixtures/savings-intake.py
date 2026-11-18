"""Drive the companion ASGI route with a fake committed ledger, entirely offline."""
import asyncio
import json
import sys
from contextlib import asynccontextmanager
from functools import partial
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from polychat.routes import ccc_diagnostics as route
from polychat.savings_ingest import record_turns


async def main() -> None:
    wire = json.load(sys.stdin)
    turn = wire["body"]["turns"][0]
    rows = {}
    refuse_commit = True

    class Ledger:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @asynccontextmanager
        async def begin(self):
            self.pending = {}
            yield
            if refuse_commit:
                raise RuntimeError("simulated commit failure")
            rows.update(self.pending)

        async def execute(self, stmt, params):
            result = MagicMock()
            if "FROM usage_requests" in str(stmt):
                result.all.return_value = [(turn["session_id"], "owner")]
            else:
                assert "ON CONFLICT (user_id,turn_id) DO NOTHING" in str(stmt)
                assert params["owner"] == "owner"
                for value in json.loads(params["batch"]):
                    if value["turn_id"] not in rows:
                        self.pending[value["turn_id"]] = value
            return result

    app = FastAPI()
    app.include_router(route.ccc_diagnostics_router)
    store = partial(record_turns, session_factory=Ledger)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://offline") as http:
        with patch.object(route, "record_turns", store), patch.object(
            route, "lookup_webui_user_by_api_key", AsyncMock(return_value={"id": "owner"})
        ):
            failed = await http.post(wire["path"], json=wire["body"], headers=wire["headers"])
            assert failed.status_code == 503 and not rows
            refuse_commit = False
            for _ in range(2):
                response = await http.post(wire["path"], json=wire["body"], headers=wire["headers"])
                assert response.status_code == 200
    assert len(rows) == 1 and rows[turn["turn_id"]]["requested_at"].startswith("2026-11-16")
    for key in ("floor_read_possibly_uncached_tokens", "floor_read_max_gap_seconds"):
        assert rows[turn["turn_id"]][key] == turn[key]
    print(json.dumps({"status": response.status_code, "response": response.json()}))


asyncio.run(main())
