"""Print tensor shape context when user code crashes.

When a RuntimeError (shape mismatch, etc.) or other exception occurs,
this reads .trickle/variables.jsonl and prints the tensor shapes of
variables traced near the crash site — so the user can immediately see
which shapes caused the error without adding print statements.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple


def print_error_context(exc: BaseException) -> None:
    """Print tensor shape context around the crash site.

    Reads variables.jsonl and the exception traceback to show relevant
    tensor shapes near where the error occurred.
    """
    try:
        _print_context(exc)
    except Exception:
        pass  # Never make errors worse


def _print_context(exc: BaseException) -> None:
    # Find the variables.jsonl file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    vars_file = os.path.join(local_dir, "variables.jsonl")
    if not os.path.exists(vars_file):
        return

    # Read all tensor observations
    records = _read_tensor_records(vars_file)
    if not records:
        return

    # Get crash frames from the traceback
    crash_frames = _extract_crash_frames(exc)
    if not crash_frames:
        return

    # Find tensor records relevant to the crash
    relevant = _find_relevant_tensors(records, crash_frames)
    if not relevant:
        return

    # Print the context
    _print_shape_report(exc, relevant, crash_frames)


def _read_tensor_records(vars_file: str) -> List[Dict[str, Any]]:
    """Read tensor variable records from variables.jsonl."""
    records = []
    try:
        with open(vars_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    if r.get("kind") == "variable":
                        records.append(r)
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return records


def _extract_crash_frames(exc: BaseException) -> List[Tuple[str, int, str]]:
    """Extract (filename, lineno, funcname) tuples from the traceback.

    Returns frames from most recent (crash site) to oldest.
    """
    tb = exc.__traceback__
    if tb is None:
        return []

    frames = []
    while tb is not None:
        frame = tb.tb_frame
        filename = frame.f_code.co_filename
        lineno = tb.tb_lineno
        funcname = frame.f_code.co_name
        frames.append((filename, lineno, funcname))
        tb = tb.tb_next

    frames.reverse()  # Most recent first
    return frames


def _find_relevant_tensors(
    records: List[Dict[str, Any]],
    crash_frames: List[Tuple[str, int, str]],
) -> List[Dict[str, Any]]:
    """Find tensor records relevant to the crash site.

    Strategy:
    1. Map crash frames to recorded files (handles temp file paths from AST transform)
    2. Look for tensors near the crash line in matched files
    3. If no frame-specific matches, show all tensors (sorted by line)
    """
    if not records:
        return []

    # Collect all unique files from records
    record_files = set(r.get("file", "") for r in records)

    # Build crash frame to record-file mapping
    # The crash traceback may reference .trickle_xxx.py temp files,
    # but records use the original file path.
    frame_to_records: List[Tuple[Tuple[str, int, str], List[Dict[str, Any]]]] = []

    for frame in crash_frames[:5]:
        filename, lineno, funcname = frame
        matched_records: List[Dict[str, Any]] = []

        # Direct match
        for r in records:
            if r.get("file", "") == filename:
                matched_records.append(r)

        # If no direct match, try matching by directory (temp files are in same dir)
        if not matched_records:
            frame_dir = os.path.dirname(filename)
            for r in records:
                rec_dir = os.path.dirname(r.get("file", ""))
                if rec_dir == frame_dir:
                    matched_records.append(r)

        # If still no match, try basename matching (for imported modules)
        if not matched_records:
            frame_base = os.path.basename(filename)
            for r in records:
                rec_base = os.path.basename(r.get("file", ""))
                if rec_base == frame_base:
                    matched_records.append(r)

        if matched_records:
            frame_to_records.append((frame, matched_records))

    # If we matched frames, find records near the crash lines
    relevant: List[Dict[str, Any]] = []
    seen_keys: set = set()

    if frame_to_records:
        for (filename, lineno, funcname), file_records in frame_to_records:
            scored = []
            for r in file_records:
                rline = r.get("line", 0)
                distance = abs(rline - lineno)
                key = (r["file"], r["line"], r["varName"])
                if key in seen_keys:
                    continue
                if distance <= 50:
                    scored.append((distance, r))
                    seen_keys.add(key)

            scored.sort(key=lambda x: x[0])
            for _, r in scored[:15]:
                relevant.append(r)
    else:
        # Fallback: no frame matches — show all records (likely a simple script)
        seen_keys = set()
        for r in records:
            key = (r["file"], r["line"], r["varName"])
            if key not in seen_keys:
                relevant.append(r)
                seen_keys.add(key)

    return relevant


def _format_type(type_node: Dict[str, Any]) -> str:
    """Format a type node as a concise string."""
    if not type_node:
        return "unknown"

    kind = type_node.get("kind", "")
    class_name = type_node.get("class_name", "")

    if class_name in ("Tensor", "ndarray"):
        props = type_node.get("properties", {})
        parts = [class_name]

        shape_prop = props.get("shape", {})
        if shape_prop.get("kind") == "primitive" and shape_prop.get("name"):
            parts[0] = f"{class_name}{shape_prop['name']}"

        dtype_prop = props.get("dtype", {})
        if dtype_prop.get("kind") == "primitive" and dtype_prop.get("name"):
            dtype = dtype_prop["name"].replace("torch.", "").replace("numpy.", "")
            parts.append(dtype)

        device_prop = props.get("device", {})
        if device_prop.get("kind") == "primitive" and device_prop.get("name"):
            if device_prop["name"] != "cpu":
                parts.append(f"@{device_prop['name']}")

        return " ".join(parts)

    if kind == "primitive":
        return type_node.get("name", "unknown")

    if class_name:
        return class_name

    return kind or "unknown"


def _is_tensor(r: Dict[str, Any]) -> bool:
    """Check if a record is a tensor type."""
    cn = r.get("type", {}).get("class_name", "")
    return cn in ("Tensor", "ndarray")


def _print_shape_report(
    exc: BaseException,
    relevant: List[Dict[str, Any]],
    crash_frames: List[Tuple[str, int, str]],
) -> None:
    """Print a formatted tensor shape report for the crash."""
    # Separate tensors from non-tensors
    tensors = [r for r in relevant if _is_tensor(r)]
    non_tensors = [r for r in relevant if not _is_tensor(r)]

    if not tensors and not non_tensors:
        return

    crash_file, crash_line, crash_func = crash_frames[0] if crash_frames else ("", 0, "")

    print(file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)
    print("\033[36m  trickle: tensor shapes near the error\033[0m", file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)

    # Group by file
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    for r in tensors:
        f = r.get("file", "?")
        if f not in by_file:
            by_file[f] = []
        by_file[f].append(r)

    for filepath, file_tensors in by_file.items():
        try:
            rel_path = os.path.relpath(filepath, os.getcwd())
        except ValueError:
            rel_path = filepath
        # If relative path goes up too many levels, just show the filename
        if rel_path.startswith("../" * 3):
            rel_path = os.path.basename(filepath)
        print(f"\033[1m  {rel_path}\033[0m", file=sys.stderr)

        # Sort by line number
        file_tensors.sort(key=lambda r: r.get("line", 0))

        for r in file_tensors:
            line = r.get("line", 0)
            name = r.get("varName", "?")
            type_str = _format_type(r.get("type", {}))

            # Highlight the crash line
            marker = " \033[31m◄ error\033[0m" if line == crash_line and filepath.endswith(os.path.basename(crash_file)) else ""
            print(f"    \033[90mline {line:4d}\033[0m  \033[1m{name:20s}\033[0m \033[32m{type_str}\033[0m{marker}", file=sys.stderr)

        print(file=sys.stderr)

    # Show non-tensor variables if they might be relevant (near crash)
    relevant_non_tensors = [r for r in non_tensors if abs(r.get("line", 0) - crash_line) <= 10]
    if relevant_non_tensors:
        print("  \033[90mOther variables near error:\033[0m", file=sys.stderr)
        for r in relevant_non_tensors[:5]:
            name = r.get("varName", "?")
            type_str = _format_type(r.get("type", {}))
            sample = r.get("sample")
            sample_str = f" = {sample}" if sample is not None and not isinstance(sample, (dict, list)) else ""
            print(f"    \033[1m{name}\033[0m: {type_str}{sample_str}", file=sys.stderr)
        print(file=sys.stderr)

    print("\033[90m  Run `trickle vars --tensors` for full tensor details\033[0m", file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)
    print(file=sys.stderr)
