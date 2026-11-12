"""Vercel entry point: the same FastAPI app the local server runs, served as one serverless function.

Vercel serves the built front end from its CDN. The rewrite in vercel.json sends every /api/* request here.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.main import app  # noqa: E402,F401
