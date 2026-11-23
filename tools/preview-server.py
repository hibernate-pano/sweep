#!/usr/bin/env python3
"""本地预览服务器。

Chrome 扩展页面依赖 chrome.* API，无法直接在浏览器里打开；
这个脚本把项目目录静态伺服出去，并在 HTML 里注入一份 chrome.* 的假实现，
这样就能在浏览器里预览面板和设置页的真实渲染效果。

用法：python3 tools/preview-server.py [端口]
"""

from __future__ import annotations

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK = "/tools/preview/chrome-mock.js"
INJECT = f'<script src="{MOCK}"></script>'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path_only = self.path.split("?")[0]
        if path_only.endswith(".html"):
            full = os.path.join(ROOT, path_only.lstrip("/"))
            if os.path.isfile(full):
                with open(full, "r", encoding="utf-8") as fh:
                    body = fh.read()
                body = body.replace("</head>", f"{INJECT}\n</head>", 1)
                data = body.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"preview → http://127.0.0.1:{port}/src/popup.html")
    print(f"preview → http://127.0.0.1:{port}/options/options.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
