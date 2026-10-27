#!/usr/bin/env python3
"""Bounded POSIX ACP lifecycle checks, not an OS/network sandbox or security audit.
Default --self-test uses only a fake child. --run /absolute/runtime [args...]
requires an already-authorized, isolated runtime host. Never calls authenticate,
session/new, session/prompt, session/load, tools, or any network client.
Runtime startup itself may attempt network; this harness cannot certify otherwise.
Only structured metadata is emitted; child stderr and raw responses are discarded.
"""
import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TIMEOUT = 15.0
MAX_BYTES = 1024 * 1024
MAX_LINE = 64 * 1024

class CheckError(Exception):
    pass

class Child:
    def __init__(self, argv, root):
        # No inherited credentials, configuration, proxy settings, or HOME.
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(root / 'home'),
               'XDG_CONFIG_HOME': str(root / 'config'),
               'XDG_CACHE_HOME': str(root / 'cache'),
               'XDG_DATA_HOME': str(root / 'data'),
               'TMPDIR': str(root / 'tmp')}
        for key in ('HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR'):
            Path(env[key]).mkdir(mode=0o700)
        (root / 'work').mkdir(mode=0o700)
        self.p = subprocess.Popen(argv, cwd=root / 'work', env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.p.stdout, selectors.EVENT_READ)
        self.buf = b''
        self.total = 0
        self.messages = 0

    def initialize(self):
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': 1, 'clientCapabilities': {},
            'clientInfo': {'name': 'offline-lifecycle-check', 'version': '1'}}}
        self.p.stdin.write((json.dumps(request) + '\n').encode())
        self.p.stdin.flush()
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if b'\n' not in self.buf:
                ready = self.selector.select(max(0, deadline - time.monotonic()))
                if not ready:
                    raise CheckError('initialize_timeout')
                chunk = os.read(self.p.stdout.fileno(), 8192)
                if not chunk:
                    raise CheckError('initialize_eof')
                self.total += len(chunk)
                self.buf += chunk
                if self.total > MAX_BYTES:
                    raise CheckError('output_bound_exceeded')
                if b'\n' not in self.buf and len(self.buf) > MAX_LINE:
                    raise CheckError('line_bound_exceeded')
                continue
            line, self.buf = self.buf.split(b'\n', 1)
            if len(line) > MAX_LINE:
                raise CheckError('line_bound_exceeded')
            try:
                response = json.loads(line)
            except (ValueError, UnicodeError):
                raise CheckError('invalid_json') from None
            if not isinstance(response, dict) or response.get('jsonrpc') != '2.0':
                raise CheckError('invalid_response')
            self.messages += 1
            if self.messages > 128:
                raise CheckError('message_bound_exceeded')
            if 'method' in response:
                if 'id' in response:
                    raise CheckError('unexpected_client_callback')
                continue  # Never print notifications or respond to callbacks.
            if response.get('id') != 1 or 'error' in response:
                raise CheckError('initialize_not_successful')
            r = response.get('result')
            if not isinstance(r, dict):
                raise CheckError('invalid_result')
            caps = r.get('agentCapabilities', {})
            auth = r.get('authMethods', [])
            if not isinstance(caps, dict) or not isinstance(auth, list):
                raise CheckError('invalid_capabilities')
            mcp = caps.get('mcpCapabilities', {})
            checks = {'protocol_1': type(r.get('protocolVersion')) is int and r['protocolVersion'] == 1,
                      'personal_oauth_advertised': any(isinstance(a, dict) and a.get('id') == 'oauth-personal' for a in auth),
                      'session_load_advertised': caps.get('loadSession') is True,
                      'http_mcp_advertised': isinstance(mcp, dict) and mcp.get('http') is True}
            return checks
        raise CheckError('initialize_timeout')

    def group_exists(self):
        try:
            os.killpg(self.p.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def finish(self, mode):
        if mode == 'eof':
            self.p.stdin.close()
        else:
            os.killpg(self.p.pid, signal.SIGTERM)
        try:
            rc = self.p.wait(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            raise CheckError('exit_timeout') from None
        return {'exit_code': rc, 'exit_expected': rc == 0 if mode == 'eof' else rc in (0, -signal.SIGTERM),
                'process_group_gone': not self.group_exists()}

    def cleanup(self):
        # Only the freshly created child process group, never system-wide scans.
        if self.group_exists():
            os.killpg(self.p.pid, signal.SIGKILL)
        self.p.wait(timeout=TIMEOUT)
        self.selector.close()
        for stream in (self.p.stdin, self.p.stdout):
            stream.close()


def run_case(argv, mode):
    child = None
    report = {'case': mode, 'passed': False}
    with tempfile.TemporaryDirectory(prefix='acp-lifecycle-') as directory:
        root = Path(directory)
        try:
            child = Child(argv, root)
            report.update(child.initialize())
            report.update(child.finish(mode))
            report['passed'] = all(report[k] for k in ('protocol_1', 'personal_oauth_advertised',
                'session_load_advertised', 'http_mcp_advertised', 'exit_expected', 'process_group_gone'))
        except CheckError as exc:
            report['failure'] = str(exc)  # Only static internal codes, never child text.
        except Exception:
            report['failure'] = 'harness_or_launch_error'
        finally:
            if child:
                try:
                    child.cleanup()
                    report['cleanup_confirmed'] = not child.group_exists()
                except Exception:
                    report['cleanup_confirmed'] = False
                    report['passed'] = False
    report['temporary_profile_removed'] = not root.exists()
    report['passed'] = report['passed'] and report['temporary_profile_removed']
    return report


def fake(mode):
    for line in sys.stdin:
        request = json.loads(line)
        if request.get('method') != 'initialize':
            sys.exit(10)
        if mode == 'malformed':
            print('not json', flush=True)
        elif mode == 'callback':
            print(json.dumps({'jsonrpc': '2.0', 'id': 9, 'method': 'fs/read_text_file'}), flush=True)
        else:
            # Demonstrate that the harness doesn't pass a deliberately set secret.
            if 'ACP_HARNESS_TEST_SECRET' in os.environ:
                sys.exit(11)
            print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'protocolVersion': 1,
                'authMethods': [{'id': 'oauth-personal'}],
                'agentCapabilities': {'loadSession': True, 'mcpCapabilities': {'http': True}}}}), flush=True)


class HarnessTests(unittest.TestCase):
    def command(self, mode='normal'):
        return [sys.executable, str(Path(__file__).resolve()), '--fake', mode]

    def test_two_fresh_launches(self):
        os.environ['ACP_HARNESS_TEST_SECRET'] = 'synthetic-only'
        try:
            for _ in range(2):
                self.assertTrue(run_case(self.command(), 'eof')['passed'])
        finally:
            del os.environ['ACP_HARNESS_TEST_SECRET']

    def test_idle_termination(self):
        self.assertTrue(run_case(self.command(), 'terminate')['passed'])

    def test_invalid_framing_cleanup(self):
        r = run_case(self.command('malformed'), 'eof')
        self.assertEqual(r['failure'], 'invalid_json')
        self.assertTrue(r['cleanup_confirmed'])
        self.assertTrue(r['temporary_profile_removed'])

    def test_client_callback_not_serviced(self):
        r = run_case(self.command('callback'), 'eof')
        self.assertEqual(r['failure'], 'unexpected_client_callback')
        self.assertTrue(r['cleanup_confirmed'])


if __name__ == '__main__':
    if sys.argv[1:2] == ['--fake']:
        fake(sys.argv[2])
    elif sys.argv[1:] == ['--self-test']:
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    elif sys.argv[1:2] == ['--run'] and len(sys.argv) >= 3 and os.path.isabs(sys.argv[2]):
        results = [run_case(sys.argv[2:], mode) for mode in ('eof', 'eof', 'terminate')]
        print(json.dumps({'kind': 'ordinary_lifecycle_only', 'results': results}, sort_keys=True))
        sys.exit(0 if all(r['passed'] for r in results) else 1)
    else:
        sys.exit('Usage: native_lifecycle.py --self-test | --run /absolute/runtime [args...]')
