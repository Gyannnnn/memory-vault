"""Small local HTTP API. Paths are only read, and only under the read-only mounts in ALLOWED_ROOTS."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .junk import JunkClassifier

ALLOWED_ROOTS = [Path(root).resolve() for root in os.environ.get("ALLOWED_ROOTS", "/mnt/sources").split(":")]
MAX_BATCH = 64


def _allowed(path: Path) -> bool:
    resolved = path.resolve()
    return any(resolved.is_relative_to(root) for root in ALLOWED_ROOTS)


class Handler(BaseHTTPRequestHandler):
    classifier: JunkClassifier

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/junk":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(min(length, 2_000_000)) or b"{}")
        paths = request.get("paths")
        if not isinstance(paths, list) or len(paths) > MAX_BATCH or not all(isinstance(p, str) for p in paths):
            self._send(400, {"error": f"expected up to {MAX_BATCH} paths"})
            return
        candidates = [Path(p) for p in paths]
        allowed = [p if _allowed(p) else None for p in candidates]
        readable = [p for p in allowed if p is not None]
        scores = iter(self.classifier.score(readable))
        results = []
        for path, original in zip(allowed, paths, strict=True):
            score = next(scores) if path is not None else None
            results.append(
                {"path": original, "junk": score.junk, "label": score.label} if score else {"path": original}
            )
        self._send(200, {"results": results})

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def main() -> None:
    Handler.classifier = JunkClassifier(
        os.environ.get("CLIP_REPO", "Xenova/clip-vit-base-patch32"),
        os.environ.get("CLIP_REVISION", "6b7c523703ae26e39be4b03774966f8571c7f523"),
        os.environ.get("MODEL_DIR", "/models"),
    )
    port = int(os.environ.get("PORT", "8090"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
