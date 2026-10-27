"""Offline lifecycle conformance; no Docker daemon or vendor executable."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import unittest

WRAPPER = str(Path(__file__).with_name('rakazo-process'))


class ProcessTests(unittest.TestCase):
    def start(self, code, timeout=3000):
        proc = subprocess.Popen(
            [sys.executable, WRAPPER, str(timeout), sys.executable, '-u', '-c', code],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.addCleanup(self.finish, proc)
        return proc

    def finish(self, proc):
        if proc.poll() is None:
            proc.stdin.close()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            pipe.close()

    def send(self, proc, frame):
        proc.stdin.write(json.dumps(frame).encode() + b'\n')
        proc.stdin.flush()

    def line(self, proc):
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(3), 'command did not become ready')
        return proc.stdout.readline().decode().strip()

    def gone(self, pid):
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_roundtrip_separate_streams_and_stdin_end(self):
        proc = self.start("import sys; value=sys.stdin.buffer.read(); sys.stdout.buffer.write(value); sys.stderr.write('diagnostic'); sys.exit(7)")
        self.send(proc, {'type': 'stdin', 'data': base64.b64encode(b'hello\x00world').decode()})
        self.send(proc, {'type': 'end'})
        self.assertEqual(proc.wait(timeout=5), 7)
        self.assertEqual(proc.stdout.read(), b'hello\x00world')
        self.assertEqual(proc.stderr.read(), b'diagnostic')

    def test_eof_terminates_command(self):
        proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)")
        pid = int(self.line(proc))
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=5), 0)
        self.gone(pid)

    def test_close_escalates_ignored_term(self):
        proc = self.start("import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print(os.getpid(),flush=True); time.sleep(60)")
        pid = int(self.line(proc))
        self.send(proc, {'type': 'close'})
        self.assertEqual(proc.wait(timeout=5), 125)
        self.gone(pid)

    def test_timeout_terminates_command(self):
        proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)", 150)
        pid = int(self.line(proc))
        self.assertEqual(proc.wait(timeout=5), 124)
        self.gone(pid)

    def test_signal_terminates_command(self):
        proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)")
        pid = int(self.line(proc))
        proc.send_signal(signal.SIGTERM)
        self.assertEqual(proc.wait(timeout=5), 0)
        self.gone(pid)

    def test_preserves_helper_cleanup_failure(self):
        proc = self.start("import os,signal,sys,time; signal.signal(signal.SIGTERM,lambda *_: sys.exit(125)); print(os.getpid(),flush=True); time.sleep(60)")
        self.line(proc)
        self.send(proc, {'type': 'close'})
        self.assertEqual(proc.wait(timeout=5), 125)

    def test_invalid_frame_fails_closed(self):
        for frame in ({'type': 'stdin', 'data': '!'}, {'type': 'nope'}, {'type': 'stdin', 'data': base64.b64encode(b'x' * 65537).decode()}):
            with self.subTest(frame_type=frame['type']):
                proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)")
                pid = int(self.line(proc))
                self.send(proc, frame)
                self.assertEqual(proc.wait(timeout=5), 125)
                self.gone(pid)

    def test_unterminated_frame_limit_fails_closed(self):
        proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)")
        pid = int(self.line(proc))
        proc.stdin.write(b'x' * (100 * 1024 + 1))
        proc.stdin.flush()
        self.assertEqual(proc.wait(timeout=5), 125)
        self.gone(pid)

    def test_slow_stdin_is_bounded_and_close_still_works(self):
        proc = self.start("import os,time; print(os.getpid(),flush=True); time.sleep(60)")
        pid = int(self.line(proc))
        self.send(proc, {'type': 'stdin', 'data': base64.b64encode(b'x' * 65536).decode()})
        self.send(proc, {'type': 'close'})
        self.assertEqual(proc.wait(timeout=5), 0)
        self.gone(pid)


if __name__ == '__main__':
    unittest.main()
