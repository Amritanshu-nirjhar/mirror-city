import os

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

pool = ConnectionPool(os.environ.get("DATABASE_URL", "postgresql://unset"), min_size=1, max_size=8, open=False,
                      kwargs={"row_factory": dict_row, "autocommit": True, "prepare_threshold": None})  # pooled Neon URLs do not support prepared statements


def _ensure_open():
    # Serverless hosts (Vercel) do not run the ASGI lifespan, so the pool opens on first use.
    if "DATABASE_URL" not in os.environ:
        raise DatabaseUnavailable("DATABASE_URL is not set. Add a hosted PostGIS connection string in the project's environment variables.")
    if pool.closed:
        pool.open(wait=True)


class DatabaseUnavailable(Exception):
    pass


def rows(sql, params=()):
    _ensure_open()
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def row(sql, params=()):
    _ensure_open()
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()
