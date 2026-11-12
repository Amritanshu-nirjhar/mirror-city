import os

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=8, open=False,
                      kwargs={"row_factory": dict_row, "autocommit": True})


def rows(sql, params=()):
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def row(sql, params=()):
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()
