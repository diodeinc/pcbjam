#!/usr/bin/env python3
"""Keep full command logs on disk and bounded progress in the CI console."""

import collections
import os
import pathlib
import re
import subprocess
import sys
import time


def main():
    log = pathlib.Path(sys.argv[1])
    log.parent.mkdir(parents=True, exist_ok=True)
    started = last_update = time.monotonic()
    tail = collections.deque(maxlen=40)
    print(f"Starting {sys.argv[2]} — full log: {log}", flush=True)
    with log.open("w") as output:
        process = subprocess.Popen(
            sys.argv[2:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", env={**os.environ, "KICAD_LOG_NESTED": "1"},
        )
        for line in process.stdout:
            output.write(line)
            output.flush()
            clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line).strip()
            tail.append(clean[-1000:])
            now = time.monotonic()
            if "@KW@" in clean or now - last_update >= 30:
                print(f"[{int(now - started)}s] {clean[:300]}", flush=True)
                last_update = now
        status = process.wait()
    print(f"Finished in {int(time.monotonic() - started)}s (exit {status}). Log: {log}", flush=True)
    if status:
        print("Last 40 log lines:", flush=True)
        # Prefix output so compiler/test text cannot become an Actions command.
        for line in tail:
            print(f"  | {line}")
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
