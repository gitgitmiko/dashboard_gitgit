#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd, rows, cols):
    rows = max(1, min(int(rows), 200))
    cols = max(2, min(int(cols), 500))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    rows = int(os.environ.get("PTY_ROWS", "24"))
    cols = int(os.environ.get("PTY_COLS", "80"))
    shell = os.environ.get("SHELL", "/bin/bash")
    cwd = os.environ.get("HOME", "/")
    try:
        os.chdir(cwd)
    except OSError:
        os.chdir("/")

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(shell, [os.path.basename(shell), "-l"], os.environ)

    set_winsize(master, rows, cols)
    ctrl = None
    try:
        os.fstat(3)
        ctrl = 3
        fcntl.fcntl(ctrl, fcntl.F_SETFL, os.O_NONBLOCK)
    except OSError:
        ctrl = None

    fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
    fcntl.fcntl(0, fcntl.F_SETFL, os.O_NONBLOCK)
    ctrl_buf = b""
    child_alive = True

    def on_chld(*_args):
        nonlocal child_alive
        try:
            waited, _status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                child_alive = False
        except ChildProcessError:
            child_alive = False

    def shutdown(*_args):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGCHLD, on_chld)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        while True:
            fds = [master, 0]
            if ctrl is not None:
                fds.append(ctrl)
            readable, _w, _x = select.select(fds, [], [], 1.0)
            if master in readable:
                try:
                    data = os.read(master, 8192)
                except BlockingIOError:
                    data = b""
                if not data:
                    break
                os.write(1, data)
            if 0 in readable:
                try:
                    data = os.read(0, 8192)
                except BlockingIOError:
                    data = b""
                if not data:
                    break
                os.write(master, data)
            if ctrl is not None and ctrl in readable:
                try:
                    chunk = os.read(ctrl, 4096)
                except BlockingIOError:
                    chunk = b""
                if not chunk:
                    ctrl = None
                else:
                    ctrl_buf += chunk
                    while b"\n" in ctrl_buf:
                        line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8"))
                            set_winsize(master, msg.get("rows", rows), msg.get("cols", cols))
                            try:
                                os.kill(pid, signal.SIGWINCH)
                            except ProcessLookupError:
                                pass
                        except (ValueError, OSError):
                            pass
            if not child_alive:
                try:
                    while True:
                        data = os.read(master, 8192)
                        if not data:
                            break
                        os.write(1, data)
                except (OSError, BlockingIOError):
                    pass
                break
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    main()
