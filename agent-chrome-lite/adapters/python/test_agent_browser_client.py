import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_browser_client as client


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class AgentBrowserClientTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        runtime = self.root / "runtime"
        runtime.mkdir()
        (runtime / "tokens.env").write_text(
            "ABL_NOVAGE_TOKEN=abl_novage_test_token_123456789\n"
            "ABL_NOVADE_TOKEN=abl_novade_test_token_123456789\n",
            encoding="utf-8",
        )
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.environment = patch.dict(
            os.environ,
            {
                "ABL_RUNTIME_DIR": str(runtime),
                "ABL_SERVER_URL": "http://127.0.0.1:3767",
            },
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def test_fixed_principal_status(self):
        with patch.object(
            client,
            "urlopen",
            return_value=_Response({"ok": True, "result": {"url": "about:blank"}}),
        ) as mocked:
            result = json.loads(
                client.call_agent_browser("novage", self.workspace, "status")
            )
        self.assertEqual(result["url"], "about:blank")
        self.assertEqual(
            mocked.call_args.args[0].headers["Authorization"],
            "Bearer abl_novage_test_token_123456789",
        )

    def test_upload_is_confined_to_workspace(self):
        inside = self.workspace / "audio.mp3"
        inside.write_bytes(b"test")
        payload = client._payload(
            "upload",
            self.workspace,
            {"ref": "fresh:1", "files": ["audio.mp3"]},
        )
        self.assertEqual(payload["files"], [str(inside.resolve())])
        outside = self.root / "outside.mp3"
        outside.write_bytes(b"test")
        with self.assertRaisesRegex(RuntimeError, "must come from its workspace"):
            client._payload(
                "upload",
                self.workspace,
                {"ref": "fresh:1", "files": [str(outside)]},
            )

    def test_rejects_non_loopback_and_unknown_actions(self):
        with patch.dict(os.environ, {"ABL_SERVER_URL": "https://example.com"}):
            with self.assertRaisesRegex(RuntimeError, "loopback HTTP"):
                client._server_url()
        with self.assertRaisesRegex(RuntimeError, "Unsupported"):
            client.call_agent_browser("novade", self.workspace, "evaluate")


if __name__ == "__main__":
    unittest.main()
