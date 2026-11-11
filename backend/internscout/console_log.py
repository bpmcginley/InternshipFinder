"""Console diagnostics with opt-in JSON lines for ingest logs."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import TextIO, cast


@dataclass(frozen=True)
class _ConsoleLine:
    values: tuple[object, ...]
    sep: str | None
    end: str | None
    file: TextIO | None
    flush: bool
    exception_type: str | None


class _ConsoleHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        line = cast(_ConsoleLine, record.msg)
        if os.environ.get("INTERNSCOUT_LOG_FORMAT") == "json":
            sep = " " if line.sep is None else line.sep
            payload = {
                "level": record.levelname,
                "message": sep.join(str(value) for value in line.values),
            }
            if line.exception_type is not None:
                payload["exception_type"] = line.exception_type
            print(json.dumps(payload), file=line.file, flush=line.flush)
        else:
            print(*line.values, sep=line.sep, end=line.end, file=line.file, flush=line.flush)


# Keep these diagnostics off the process's root logger.
_logger = logging.Logger("internscout.console", level=logging.INFO)
_logger.addHandler(_ConsoleHandler())
_logger.propagate = False


def console(
    *values: object,
    sep: str | None = None,
    end: str | None = None,
    file: TextIO | None = None,
    flush: bool = False,
    level: int = logging.INFO,
    exception_type: str | None = None,
) -> None:
    """Write diagnostic text using print's stream options.

    Pass only console-safe values. For an exception, pass its class name and safe
    context. JSON output records the class name as a separate field.
    """
    if level < _logger.level:
        return
    line = _ConsoleLine(values, sep, end, file, flush, exception_type)
    # These were unconditional prints. Global logging filters and factories are for other loggers.
    record = logging.LogRecord(_logger.name, level, "", 0, line, (), None)
    _logger.handle(record)


def console_exception(context: str, exception_type: str) -> None:
    """Report a previously silent failure with fixed context and the exception class name."""
    if os.environ.get("INTERNSCOUT_LOG_FORMAT") != "json":
        return
    try:
        console(context, level=logging.WARNING, exception_type=exception_type)
    except Exception:
        # New telemetry must not interrupt the caller's existing fallback.
        pass
