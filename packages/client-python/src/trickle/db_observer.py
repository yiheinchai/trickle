"""Database query observer — patches popular Python database drivers to capture
SQL queries, execution time, row counts, and column names.

Supports:
  - sqlite3 (stdlib)
  - psycopg2 / psycopg (PostgreSQL)
  - pymysql (MySQL)
  - mysql.connector (MySQL Connector/Python)

Captured data is written to .trickle/queries.jsonl as:
  { "kind": "query", "query": "SELECT ...", "params": [...], "durationMs": 2.5,
    "rowCount": 1, "columns": ["id", "name"], "timestamp": 1710516000000 }

This matches the JS db-observer format so the MCP server's get_database_queries
tool works for Python projects too.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

_queries_file: Optional[str] = None
_debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
_MAX_QUERY_LENGTH = 500
_MAX_QUERIES = 500
_query_count = 0


def _get_queries_file() -> str:
    global _queries_file
    if _queries_file:
        return _queries_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _queries_file = os.path.join(local_dir, "queries.jsonl")
    # Clear previous run's data
    try:
        with open(_queries_file, "w"):
            pass
    except OSError:
        pass
    return _queries_file


def _write_query(record: Dict[str, Any]) -> None:
    global _query_count
    if _query_count >= _MAX_QUERIES:
        return
    _query_count += 1
    try:
        with open(_get_queries_file(), "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def _truncate(s: str, max_len: int = _MAX_QUERY_LENGTH) -> str:
    if len(s) <= max_len:
        return s
    return s[:max_len - 3] + "..."


def _sanitize_params(params: Any) -> Optional[List[Any]]:
    """Extract first 5 params, converting to JSON-safe values."""
    if params is None:
        return None
    try:
        if isinstance(params, dict):
            items = list(params.items())[:5]
            return [f"{k}={_safe_val(v)}" for k, v in items]
        items = list(params)[:5]
        return [_safe_val(p) for p in items]
    except Exception:
        return None


def _safe_val(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        return v[:100]
    if isinstance(v, bytes):
        return f"<bytes({len(v)})>"
    return str(v)[:100]


# ── sqlite3 ──────────────────────────────────────────────────────────────────

class _TracedSqliteCursor:
    """Proxy cursor that traces SQL queries while delegating to the real cursor."""

    def __init__(self, real_cursor: Any) -> None:
        object.__setattr__(self, "_cursor", real_cursor)

    def execute(self, sql: str, parameters: Any = ()) -> Any:
        cursor = object.__getattribute__(self, "_cursor")
        start = time.perf_counter()
        error_msg = None
        try:
            cursor.execute(sql, parameters)
            return self
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            row_count = 0
            columns = None
            try:
                if cursor.description:
                    columns = [d[0] for d in cursor.description]
                row_count = cursor.rowcount if cursor.rowcount >= 0 else 0
            except Exception:
                pass
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "sqlite3",
                "query": _truncate(sql),
                "durationMs": round(duration, 2),
                "rowCount": row_count,
                "timestamp": int(time.time() * 1000),
            }
            params = _sanitize_params(parameters)
            if params:
                record["params"] = params
            if columns:
                record["columns"] = columns
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    def executemany(self, sql: str, seq_of_parameters: Any) -> Any:
        cursor = object.__getattribute__(self, "_cursor")
        start = time.perf_counter()
        error_msg = None
        try:
            cursor.executemany(sql, seq_of_parameters)
            return self
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            row_count = cursor.rowcount if cursor.rowcount >= 0 else 0
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "sqlite3",
                "query": _truncate(sql),
                "durationMs": round(duration, 2),
                "rowCount": row_count,
                "timestamp": int(time.time() * 1000),
            }
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_cursor"), name)

    def __iter__(self) -> Any:
        return iter(object.__getattribute__(self, "_cursor"))

    def __next__(self) -> Any:
        return next(object.__getattribute__(self, "_cursor"))


class _TracedSqliteConnection:
    """Proxy connection that returns traced cursors.

    Presents itself as sqlite3.Connection to type inference via __class__.
    """

    def __init__(self, real_conn: Any) -> None:
        object.__setattr__(self, "_conn", real_conn)

    def cursor(self, *args: Any, **kwargs: Any) -> _TracedSqliteCursor:
        conn = object.__getattribute__(self, "_conn")
        return _TracedSqliteCursor(conn.cursor(*args, **kwargs))

    def execute(self, sql: str, parameters: Any = ()) -> _TracedSqliteCursor:
        cursor = self.cursor()
        cursor.execute(sql, parameters)
        return cursor

    def executemany(self, sql: str, seq: Any) -> _TracedSqliteCursor:
        cursor = self.cursor()
        cursor.executemany(sql, seq)
        return cursor

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_conn"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_conn":
            object.__setattr__(self, name, value)
        else:
            setattr(object.__getattribute__(self, "_conn"), name, value)

    def __enter__(self) -> "_TracedSqliteConnection":
        object.__getattribute__(self, "_conn").__enter__()
        return self

    def __exit__(self, *args: Any) -> Any:
        return object.__getattribute__(self, "_conn").__exit__(*args)


def patch_sqlite3(sqlite3_module: Any) -> None:
    """Patch sqlite3.connect to return traced connection proxies."""
    if getattr(sqlite3_module, "_trickle_patched", False):
        return
    sqlite3_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching sqlite3")

    _orig_connect = sqlite3_module.connect

    def _patched_connect(*args: Any, **kwargs: Any) -> _TracedSqliteConnection:
        conn = _orig_connect(*args, **kwargs)
        return _TracedSqliteConnection(conn)

    sqlite3_module.connect = _patched_connect


# ── psycopg2 / psycopg ──────────────────────────────────────────────────────

def patch_psycopg2(psycopg2_module: Any) -> None:
    """Patch psycopg2 cursor.execute to capture queries."""
    if getattr(psycopg2_module, "_trickle_patched", False):
        return
    psycopg2_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching psycopg2")

    try:
        from psycopg2.extensions import cursor as CursorClass
    except ImportError:
        return

    _orig_execute = CursorClass.execute

    def _patched_execute(self: Any, query: Any, vars: Any = None) -> None:
        sql = query if isinstance(query, str) else str(query)
        start = time.perf_counter()
        error_msg = None
        try:
            _orig_execute(self, query, vars)
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            row_count = self.rowcount if self.rowcount >= 0 else 0
            columns = None
            if self.description:
                columns = [d[0] for d in self.description]
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "psycopg2",
                "query": _truncate(sql),
                "durationMs": round(duration, 2),
                "rowCount": row_count,
                "timestamp": int(time.time() * 1000),
            }
            params = _sanitize_params(vars)
            if params:
                record["params"] = params
            if columns:
                record["columns"] = columns
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    CursorClass.execute = _patched_execute


# ── pymysql ──────────────────────────────────────────────────────────────────

def patch_pymysql(pymysql_module: Any) -> None:
    """Patch pymysql cursor.execute to capture queries."""
    if getattr(pymysql_module, "_trickle_patched", False):
        return
    pymysql_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching pymysql")

    try:
        CursorClass = pymysql_module.cursors.Cursor
    except AttributeError:
        return

    _orig_execute = CursorClass.execute

    def _patched_execute(self: Any, query: str, args: Any = None) -> int:
        start = time.perf_counter()
        error_msg = None
        result = 0
        try:
            result = _orig_execute(self, query, args)
            return result
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            row_count = result if isinstance(result, int) else 0
            columns = None
            if self.description:
                columns = [d[0] for d in self.description]
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "pymysql",
                "query": _truncate(query),
                "durationMs": round(duration, 2),
                "rowCount": row_count,
                "timestamp": int(time.time() * 1000),
            }
            params = _sanitize_params(args)
            if params:
                record["params"] = params
            if columns:
                record["columns"] = columns
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    CursorClass.execute = _patched_execute


# ── mysql.connector ──────────────────────────────────────────────────────────

def patch_mysql_connector(mysql_module: Any) -> None:
    """Patch mysql.connector cursor.execute to capture queries."""
    if getattr(mysql_module, "_trickle_patched_connector", False):
        return
    mysql_module._trickle_patched_connector = True

    if _debug:
        print("[trickle/db] Patching mysql.connector")

    try:
        CursorClass = mysql_module.cursor.MySQLCursor
    except AttributeError:
        return

    _orig_execute = CursorClass.execute

    def _patched_execute(self: Any, operation: str, params: Any = None, multi: bool = False) -> Any:
        start = time.perf_counter()
        error_msg = None
        try:
            result = _orig_execute(self, operation, params, multi)
            return result
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            row_count = self.rowcount if self.rowcount >= 0 else 0
            columns = None
            if self.description:
                columns = [d[0] for d in self.description]
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "mysql.connector",
                "query": _truncate(operation),
                "durationMs": round(duration, 2),
                "rowCount": row_count,
                "timestamp": int(time.time() * 1000),
            }
            p = _sanitize_params(params)
            if p:
                record["params"] = p
            if columns:
                record["columns"] = columns
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    CursorClass.execute = _patched_execute


# ── Redis (redis-py) ─────────────────────────────────────────────────────────

def patch_redis(redis_module: Any) -> None:
    """Patch redis.client.Redis.execute_command to capture Redis operations."""
    if getattr(redis_module, "_trickle_patched", False):
        return
    redis_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching redis")

    try:
        RedisClass = redis_module.Redis
    except AttributeError:
        return

    _orig_execute = RedisClass.execute_command

    def _patched_execute_command(self: Any, *args: Any, **kwargs: Any) -> Any:
        cmd = args[0] if args else "UNKNOWN"
        cmd_args = list(args[1:4])  # Capture first 3 args
        start = time.perf_counter()
        error_msg = None
        try:
            result = _orig_execute(self, *args, **kwargs)
            return result
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration = (time.perf_counter() - start) * 1000
            query_str = f"{cmd} {' '.join(str(a)[:50] for a in cmd_args)}".strip()
            record: Dict[str, Any] = {
                "kind": "query",
                "driver": "redis",
                "query": _truncate(query_str),
                "durationMs": round(duration, 2),
                "rowCount": 1,
                "timestamp": int(time.time() * 1000),
            }
            if error_msg:
                record["error"] = error_msg
            _write_query(record)

    RedisClass.execute_command = _patched_execute_command


# ── MongoDB (pymongo) ────────────────────────────────────────────────────────

def patch_pymongo(pymongo_module: Any) -> None:
    """Patch pymongo Collection methods to capture MongoDB operations."""
    if getattr(pymongo_module, "_trickle_patched", False):
        return
    pymongo_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching pymongo")

    try:
        Collection = pymongo_module.collection.Collection
    except AttributeError:
        return

    _methods_to_patch = [
        "find", "find_one", "insert_one", "insert_many",
        "update_one", "update_many", "delete_one", "delete_many",
        "aggregate", "count_documents",
    ]

    for method_name in _methods_to_patch:
        orig = getattr(Collection, method_name, None)
        if orig is None or getattr(orig, "_trickle_patched", False):
            continue

        def _make_wrapper(orig_method: Any, op_name: str) -> Any:
            def _wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
                collection_name = getattr(self, "name", "?")
                start = time.perf_counter()
                error_msg = None
                result = None
                try:
                    result = orig_method(self, *args, **kwargs)
                    return result
                except Exception as e:
                    error_msg = str(e)[:200]
                    raise
                finally:
                    duration = (time.perf_counter() - start) * 1000
                    # Build a readable query string
                    filter_str = ""
                    if args:
                        try:
                            filter_str = " " + json.dumps(args[0], default=str)[:200]
                        except Exception:
                            pass
                    query_str = f"db.{collection_name}.{op_name}({filter_str.strip()})"
                    row_count = 0
                    if op_name == "insert_many" and result:
                        try:
                            row_count = len(result.inserted_ids)
                        except Exception:
                            pass
                    elif op_name in ("update_one", "update_many") and result:
                        try:
                            row_count = result.modified_count
                        except Exception:
                            pass
                    elif op_name in ("delete_one", "delete_many") and result:
                        try:
                            row_count = result.deleted_count
                        except Exception:
                            pass
                    elif op_name in ("find_one", "count_documents"):
                        row_count = 1 if result is not None else 0

                    record: Dict[str, Any] = {
                        "kind": "query",
                        "driver": "pymongo",
                        "query": _truncate(query_str),
                        "durationMs": round(duration, 2),
                        "rowCount": row_count,
                        "timestamp": int(time.time() * 1000),
                    }
                    if error_msg:
                        record["error"] = error_msg
                    _write_query(record)
            _wrapper._trickle_patched = True
            return _wrapper

        setattr(Collection, method_name, _make_wrapper(orig, method_name))


# ── SQLAlchemy ──────────────────────────────────────────────────────────────

def patch_sqlalchemy(sa_module: Any) -> None:
    """Patch SQLAlchemy to capture queries via event listeners.

    SQLAlchemy's event system lets us listen to 'before_cursor_execute' and
    'after_cursor_execute' events on Engine instances. We monkey-patch
    create_engine to auto-register these listeners.
    """
    if getattr(sa_module, "_trickle_patched", False):
        return
    sa_module._trickle_patched = True

    if _debug:
        print("[trickle/db] Patching SQLAlchemy")

    try:
        from sqlalchemy import event as sa_event
    except ImportError:
        return

    _orig_create_engine = sa_module.create_engine

    def _patched_create_engine(*args: Any, **kwargs: Any) -> Any:
        engine = _orig_create_engine(*args, **kwargs)
        _attach_query_listeners(engine, sa_event)
        return engine

    sa_module.create_engine = _patched_create_engine

    # Also patch create_async_engine if available
    try:
        if hasattr(sa_module, "create_async_engine"):
            _orig_create_async = sa_module.create_async_engine

            def _patched_create_async(*args: Any, **kwargs: Any) -> Any:
                engine = _orig_create_async(*args, **kwargs)
                # async engine wraps a sync engine
                try:
                    _attach_query_listeners(engine.sync_engine, sa_event)
                except Exception:
                    pass
                return engine

            sa_module.create_async_engine = _patched_create_async
    except Exception:
        pass


def _attach_query_listeners(engine: Any, sa_event: Any) -> None:
    """Attach before/after_cursor_execute event listeners to an engine."""
    if getattr(engine, "_trickle_listeners", False):
        return
    engine._trickle_listeners = True

    @sa_event.listens_for(engine, "before_cursor_execute")
    def _before_execute(conn: Any, cursor: Any, statement: Any,
                        parameters: Any, context: Any, executemany: Any) -> None:
        conn.info.setdefault("_trickle_query_start", {})[id(cursor)] = time.perf_counter()

    @sa_event.listens_for(engine, "after_cursor_execute")
    def _after_execute(conn: Any, cursor: Any, statement: Any,
                       parameters: Any, context: Any, executemany: Any) -> None:
        start = conn.info.get("_trickle_query_start", {}).pop(id(cursor), None)
        duration = (time.perf_counter() - start) * 1000 if start else 0

        row_count = 0
        columns = None
        try:
            row_count = cursor.rowcount if cursor.rowcount >= 0 else 0
            if cursor.description:
                columns = [d[0] for d in cursor.description]
        except Exception:
            pass

        sql_text = str(statement) if statement else ""
        record: Dict[str, Any] = {
            "kind": "query",
            "driver": "sqlalchemy",
            "query": _truncate(sql_text),
            "durationMs": round(duration, 2),
            "rowCount": row_count,
            "timestamp": int(time.time() * 1000),
        }
        params = _sanitize_params(parameters)
        if params:
            record["params"] = params
        if columns:
            record["columns"] = columns
        _write_query(record)

    @sa_event.listens_for(engine, "handle_error")
    def _on_error(exception_context: Any) -> None:
        start = None
        try:
            cursor = exception_context.cursor
            start = exception_context.connection.info.get("_trickle_query_start", {}).pop(id(cursor), None)
        except Exception:
            pass
        duration = (time.perf_counter() - start) * 1000 if start else 0
        sql_text = str(exception_context.statement) if exception_context.statement else ""
        record: Dict[str, Any] = {
            "kind": "query",
            "driver": "sqlalchemy",
            "query": _truncate(sql_text),
            "durationMs": round(duration, 2),
            "rowCount": 0,
            "error": str(exception_context.original_exception)[:200],
            "timestamp": int(time.time() * 1000),
        }
        _write_query(record)


# ── Auto-patching entry point ────────────────────────────────────────────────

def patch_databases(debug: bool = False) -> None:
    """Auto-detect and patch all available database drivers.

    Called from observe_runner.py during startup. Patches sqlite3 eagerly
    (always available) and installs an import hook for other drivers.
    """
    global _debug
    _debug = debug

    import sys
    import builtins

    # sqlite3 (stdlib — always available, patch eagerly)
    try:
        import sqlite3
        patch_sqlite3(sqlite3)
    except Exception:
        pass

    # Patch already-imported drivers
    _DB_PATCHES = {
        "psycopg2": patch_psycopg2,
        "pymysql": patch_pymysql,
        "mysql.connector": patch_mysql_connector,
        "redis": patch_redis,
        "pymongo": patch_pymongo,
        "sqlalchemy": patch_sqlalchemy,
    }
    for mod_name, patcher in _DB_PATCHES.items():
        if mod_name in sys.modules:
            try:
                patcher(sys.modules[mod_name])
            except Exception:
                pass

    # Hook builtins.__import__ to catch future imports of database drivers
    _orig_import = builtins.__import__

    def _hooked_import(name: str, *args: Any, **kwargs: Any) -> Any:
        module = _orig_import(name, *args, **kwargs)
        if name in _DB_PATCHES and not getattr(module, "_trickle_patched", False):
            try:
                _DB_PATCHES[name](module)
            except Exception:
                pass
        return module

    builtins.__import__ = _hooked_import
