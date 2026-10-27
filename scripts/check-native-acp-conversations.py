#!/usr/bin/env python3
"""Offline native storage qualification. Never opens/parses/rebuilds SQLite.
Copies only source-declared session .db/.meta after a confirmed clean exit.
No account authentication; local synthetic gateway only. Not egress certification.
"""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request

spec = importlib.util.spec_from_file_location('gateway_fixture', Path(__file__).with_name('check-native-acp-gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
FIRST = 'Remember this synthetic conversation marker: offline-continuity-481. Do not use tools.'
SECOND = 'Continue our previous conversation with a short greeting. Do not use tools.'
MAX_STATE_BYTES = 16 * 1024 * 1024


class Handler(gateway.Handler):
    def handle_request(self):
        if self.path == '/mcp':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 <= length <= gateway.LIMIT: raise ValueError()
                payload = json.loads(self.rfile.read(length)) if length else {}
                authorized = self.headers.get('Authorization') == self.server.marker
                self.server.mcp_authorized.append(authorized)
                if not authorized:
                    self.send_error(401); return
                method = payload.get('method')
                if 'id' not in payload:
                    self.send_response(202); self.send_header('Content-Length', '0'); self.end_headers(); return
                if method == 'initialize':
                    result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'offline-fixture', 'version': '1'}}
                elif method == 'tools/list': result = {'tools': []}
                elif method == 'ping': result = {}
                else: raise ValueError()
                data = json.dumps({'jsonrpc': '2.0', 'id': payload['id'], 'result': result}).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            except (ValueError, TypeError): self.send_error(400)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 <= length <= gateway.LIMIT: self.send_error(413); return
        raw = self.rfile.read(length)
        if self.command == 'POST' and 'GenerateContent' in self.path:
            payload = json.loads(raw)
            # Save booleans only, never backend payloads or headers.
            self.server.continuity.append({
                'first_prompt': gateway.context_integrity(payload, FIRST)['full_prompt_in_concatenated_text_fields'],
                'previous_response': gateway.context_integrity(payload, gateway.TEXT)['full_prompt_in_concatenated_text_fields'],
                'second_prompt': gateway.context_integrity(payload, SECOND)['full_prompt_in_concatenated_text_fields'],
            })
        self.rfile = io.BytesIO(raw)
        return super().handle_request()


class Stub(gateway.Stub):
    def __init__(self):
        super().__init__()
        self.RequestHandlerClass = Handler
        self.marker = 'Bearer ' + secrets.token_hex(24)
        self.mcp_authorized = []
        self.continuity = []

    def endpoint(self):
        return {'type': 'http', 'name': 'offline-fixture', 'url': self.url + '/mcp',
                'headers': [{'name': 'Authorization', 'value': self.marker}]}


class Native(gateway.Native):
    def __init__(self, argv, root, url, restore=None):
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        for key, name in [('HOME', 'home'), ('GEMINI_HOME', 'gemini'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'), ('TMPDIR', 'tmp')]:
            p = root / name; p.mkdir(mode=0o700); env[key] = str(p)
        cfg = root / 'gemini/antigravity-acp'; cfg.mkdir(mode=0o700)
        (cfg / 'settings.json').write_text(json.dumps({'auth': {'type': 'gateway'}}))
        if restore:
            source, session_id, suffixes = restore
            target = cfg / 'conversations'; target.mkdir(mode=0o700)
            for suffix in suffixes:
                source_file = source / (session_id + suffix)
                if source_file.is_symlink() or not source_file.is_file() or source_file.stat().st_size > MAX_STATE_BYTES:
                    raise gateway.Failure('unsafe_or_missing_conversation_file')
                shutil.copyfile(source_file, target / source_file.name)
                (target / source_file.name).chmod(0o600)
        env['AGY_LLM_GATEWAY_URL'] = url
        self.work = root / 'work'; self.work.mkdir()
        self.p = subprocess.Popen(argv, cwd=self.work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        self.sel = selectors.DefaultSelector(); self.sel.register(self.p.stdout, selectors.EVENT_READ)
        self.buf = b''; self.total = 0; self.n = 0; self.response_text = ''; self.notifications = 0
        self.usage_updates = []; self.explicit_context_events = []; self.current_model_matches_fixture = None
        self.overall_deadline = time.monotonic() + 35
        self.write_lock = threading.Lock()
        os.set_blocking(self.p.stdin.fileno(), False)


def close_native(child):
    code = child.cleanup()
    try: os.killpg(child.p.pid, 0); gone = False
    except ProcessLookupError: gone = True
    if code != 0 or not gone: raise gateway.Failure('native_clean_exit_required')


def qualification_exit_code(result):
    # Functional continuity alone must not turn failed storage qualification green.
    return 0 if result.get('status') == 'passed' else 1


def selftest():
    assert qualification_exit_code({'status': 'passed'}) == 0
    assert qualification_exit_code({
        'status': 'failed',
        'functional_status': 'passed',
        'credential_free_storage_qualification': 'failed',
        'requires_private_encrypted_storage': True,
    }) == 1
    assert qualification_exit_code({'status': 'failed', 'functional_status': 'failed'}) == 1
    assert qualification_exit_code({}) == 1
    stub = Stub()
    thread = threading.Thread(target=stub.serve_forever, daemon=True); thread.start()
    try:
        for method in ('initialize', 'tools/list'):
            request = urllib.request.Request(stub.url + '/mcp',
                data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method}).encode(),
                headers={'Authorization': stub.marker, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=3) as response:
                assert 'result' in json.load(response)
        request = urllib.request.Request(stub.url + '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
            data=json.dumps({'contents': [{'parts': [{'text': FIRST}, {'text': gateway.TEXT}, {'text': SECOND}]}]}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            assert gateway.TEXT in response.read().decode()
        assert all(stub.continuity[0].values()) and all(stub.mcp_authorized)
        print(json.dumps({'mode': 'fixture_selftest', 'status': 'passed'}))
    finally:
        stub.shutdown(); stub.server_close(); thread.join(timeout=2)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db-only', action='store_true'); ap.add_argument('--self-test', action='store_true'); ap.add_argument('--run', nargs=argparse.REMAINDER); args = ap.parse_args()
    if args.self_test:
        selftest(); return 0
    if not args.run or not Path(args.run[0]).is_absolute(): ap.error('absolute native executable required')
    suffixes = ('.db',) if args.db_only else ('.db', '.meta')
    result = {'source_version': 'conversation-fixture-v2-sensitive-state', 'sidecar_copied': not args.db_only, 'status': 'failed', 'scope': 'offline text restoration only; not pending tool restoration, account auth, or egress certification'}
    child = None; stubs = []; threads = []; stage = 'startup'
    temporary = tempfile.TemporaryDirectory(prefix='acp-conversation-fixture-')
    try:
        root = Path(temporary.name)
        for _ in range(2):
            stub = Stub(); stubs.append(stub)
            thread = threading.Thread(target=stub.serve_forever, daemon=True); thread.start(); threads.append(thread)
        first = root / 'first'; first.mkdir(); second = root / 'second'; second.mkdir()
        meta = {'antigravity': {'enabledTools': [], 'eagerMcpServers': ['offline-fixture']}}
        stage = 'first_start'; child = Native(args.run, first, stubs[0].url)
        init = child.rpc('initialize', {'protocolVersion': 1, 'clientCapabilities': {}})
        if init.get('agentCapabilities', {}).get('loadSession') is not True: raise gateway.Failure('load_not_supported')
        created = child.rpc('session/new', {'cwd': str(child.work), 'mcpServers': [stubs[0].endpoint()], '_meta': meta})
        sid = created.get('sessionId')
        if not isinstance(sid, str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}', sid): raise gateway.Failure('unsafe_session_id')
        stage = 'first_prompt'
        response = child.rpc('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': FIRST}]})
        if response.get('stopReason') != 'end_turn' or child.response_text.strip() != gateway.TEXT: raise gateway.Failure('first_prompt_incomplete')
        close_native(child); child = None
        stage = 'selective_restore'
        first_mcp_request_count = len(stubs[0].mcp_authorized)
        source = first / 'gemini/antigravity-acp/conversations'
        # Synthetic credential canary is deliberately outside the selected state.
        credential_marker = secrets.token_hex(32)
        (first / 'gemini/antigravity-acp/acp_token.json').write_text(json.dumps({'synthetic': credential_marker}))
        selected = [source / (sid + suffix) for suffix in suffixes]
        result['selected_file_count'] = len(selected)
        result['selected_state_bytes'] = sum(p.stat().st_size for p in selected)
        if result['selected_state_bytes'] > MAX_STATE_BYTES: raise gateway.Failure('state_size_limit')
        state_bytes = b''.join(p.read_bytes() for p in selected)
        result['credential_canary_absent_from_selected_state'] = credential_marker.encode() not in state_bytes
        result['old_mcp_header_absent_from_selected_state'] = stubs[0].marker.encode() not in state_bytes
        result['old_mcp_endpoint_absent_from_selected_state'] = stubs[0].url.encode() not in state_bytes
        # Check files only; never interpret the vendor database.
        result['unselected_conversation_file_count'] = len([p for p in source.iterdir() if p not in selected])
        child = Native(args.run, second, stubs[1].url, (source, sid, suffixes))
        result['credential_file_not_restored'] = not (second / 'gemini/antigravity-acp/acp_token.json').exists()
        stage = 'load'; child.rpc('initialize', {'protocolVersion': 1, 'clientCapabilities': {}})
        child.rpc('session/load', {'sessionId': sid, 'cwd': str(child.work), 'mcpServers': [stubs[1].endpoint()], '_meta': meta})
        child.response_text = ''  # ACP load replay is historical, not new output.
        stage = 'second_prompt'
        response = child.rpc('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': SECOND}]})
        result['second_end_turn'] = response.get('stopReason') == 'end_turn'
        result['second_fixture_response'] = child.response_text.strip() == gateway.TEXT
        result['restored_context_in_backend_request'] = bool(stubs[1].continuity) and all(all(x.values()) for x in stubs[1].continuity)
        close_native(child); child = None
        result['clean_process_exits'] = True
        result['stale_mcp_binding_not_reused'] = len(stubs[0].mcp_authorized) == first_mcp_request_count
        result['fresh_mcp_binding_authenticated'] = bool(stubs[1].mcp_authorized) and all(stubs[1].mcp_authorized)
        result['initial_mcp_binding_authenticated'] = bool(stubs[0].mcp_authorized) and all(stubs[0].mcp_authorized)
        required = ['second_end_turn', 'second_fixture_response', 'restored_context_in_backend_request', 'credential_file_not_restored', 'credential_canary_absent_from_selected_state', 'fresh_mcp_binding_authenticated', 'initial_mcp_binding_authenticated', 'stale_mcp_binding_not_reused']
        result['functional_status'] = 'passed' if all(result[k] for k in required) else 'failed'
        private_state_required = not result['old_mcp_header_absent_from_selected_state'] or not result['old_mcp_endpoint_absent_from_selected_state']
        result['credential_free_storage_qualification'] = 'failed' if private_state_required else 'passed_for_synthetic_markers_only'
        result['requires_private_encrypted_storage'] = private_state_required
        result['status'] = 'passed' if result['functional_status'] == 'passed' and not private_state_required else 'failed'
    except gateway.Failure as error: result.update(error=str(error), stage=stage)
    except Exception as error: result.update(error='harness_exception', error_type=type(error).__name__, stage=stage)
    finally:
        if child:
            try: close_native(child)
            except Exception: result['cleanup_incomplete'] = True
        for stub in stubs: stub.stop.set(); stub.shutdown(); stub.server_close()
        for thread in threads: thread.join(timeout=2)
        if not result.get('cleanup_incomplete'): temporary.cleanup()
    print(json.dumps(result, sort_keys=True))
    return qualification_exit_code(result)


if __name__ == '__main__': raise SystemExit(main())
