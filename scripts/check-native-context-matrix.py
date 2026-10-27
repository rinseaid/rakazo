#!/usr/bin/env python3
"""Bounded positive native context matrix; synthetic loopback inference only.

No account, credentials, tool calls, permission grants, runtime patches, or
production configuration changes. Native incidental egress is not certified.
Use --plan / --self-test without a runtime. The parent runs --run only on the
already authorized compatible native host. Preserve Rakazo's 128 KiB guard.
"""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gateway = load('context_gateway', 'check-native-acp-gateway.py')
conversation = load('context_conversation', 'check-native-acp-conversations.py')
VERSION = 'context-matrix-v2-bounded-longitudinal-snapshots'
MATRIX_SECONDS = 900
MAX_PROMPT_BYTES = 1024 * 1024
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
ALPHABETS = ('ascii', 'unicode', 'mixed')


def marker(label, position):
    return f'[CONTEXT_MATRIX_{label}_{position}]'


def fill(unit, byte_count):
    count, remainder = divmod(byte_count, len(unit.encode()))
    return unit * count + 'x' * remainder


def payload(byte_count, alphabet, label):
    assert 8192 <= byte_count <= MAX_PROMPT_BYTES
    assert alphabet in ALPHABETS and re.fullmatch(r'[A-Z0-9_]{1,48}', label)
    start = marker(label, 'BEGIN') + '\n' + gateway.PROMPT + '\n'
    middle = '\n' + marker(label, 'MIDDLE') + '\n'
    end = '\n' + marker(label, 'END')
    units = {
        'ascii': 'line_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ\n',
        'unicode': '界🙂é日本語x\n',
        'mixed': '{"fixture":true,"count":42,"text":"界🙂"}\nconst f = (x: number) => ({value: x + 1});\n',
    }
    remaining = byte_count - len((start + middle + end).encode())
    text = start + fill(units[alphabet], remaining // 2) + middle + fill(units[alphabet], remaining - remaining // 2) + end
    assert len(text.encode()) == byte_count
    return text


def blocks(text, count):
    # Standard ACP text blocks; split at Unicode character boundaries.
    result = [text[len(text) * i // count:len(text) * (i + 1) // count] for i in range(count)]
    assert ''.join(result) == text
    return result


def integrity(body, expected, label, pieces):
    result = gateway.context_integrity(body, expected)
    # Google's readable _parse_prompt joins consecutive text blocks with a space.
    # Report this separately; never mislabel separator normalization as exact byte retention.
    joined_blocks = ' '.join(pieces)
    result['acp_block_join_preserved'] = gateway.context_integrity(body, joined_blocks)['full_prompt_in_concatenated_text_fields']
    result['individual_blocks_preserved'] = [gateway.context_integrity(body, piece)['full_prompt_in_concatenated_text_fields'] for piece in pieces]
    result['sentinels'] = {position.lower(): gateway.context_integrity(body, marker(label, position))['full_prompt_in_concatenated_text_fields'] for position in ('BEGIN', 'MIDDLE', 'END')}
    result['all_payload_content_preserved'] = result['full_prompt_in_concatenated_text_fields'] or (result['acp_block_join_preserved'] and all(result['individual_blocks_preserved']))
    return result


class Handler(gateway.Handler):
    def handle_request(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= gateway.LIMIT:
                self.send_error(413)
                return
            raw = self.rfile.read(length)
            if self.command == 'POST' and re.search(r':(?:streamGenerateContent|generateContent)(?:\?|$)', self.path):
                body = json.loads(raw)
                # Structural results only; no payload text, headers, paths, or model output stored.
                checks = [integrity(body, item['text'], item['label'], item['pieces']) for item in self.server.expected]
                self.server.observations.append({'expected_turns': len(checks), 'turns': checks})
            self.rfile = io.BytesIO(raw)
            return super().handle_request()
        except (ValueError, TypeError):
            self.send_error(400)


class Stub(gateway.Stub):
    def __init__(self):
        super().__init__('basic')
        self.RequestHandlerClass = Handler
        self.expected = []
        self.observations = []


def plan():
    cases = []
    # Reconfirm the guard boundary with representative nonrepetitive syntax/alphabet mixtures.
    for size in (64, 128):
        for alphabet in ALPHABETS:
            cases.append({'id': f'{size}k-{alphabet}', 'bytes_per_turn': size * 1024, 'alphabet': alphabet, 'blocks': 1, 'turns': 1, 'restart_before_turn': None})
    # Compare loss thresholds by alphabet, not merely final native completion.
    for size in (256, 512):
        for alphabet in ALPHABETS:
            cases.append({'id': f'{size}k-{alphabet}', 'bytes_per_turn': size * 1024, 'alphabet': alphabet, 'blocks': 1, 'turns': 1, 'restart_before_turn': None})
    for alphabet in ('ascii', 'mixed'):
        cases.append({'id': f'1024k-{alphabet}', 'bytes_per_turn': MAX_PROMPT_BYTES, 'alphabet': alphabet, 'blocks': 1, 'turns': 1, 'restart_before_turn': None})
    cases.append({'id': '512k-mixed-four-blocks', 'bytes_per_turn': 512 * 1024, 'alphabet': 'mixed', 'blocks': 4, 'turns': 1, 'restart_before_turn': None})
    # Three small valid turns cross the single-prompt failure range; fourth follows DB-only restore.
    cases.append({'id': '64k-mixed-four-turns-restore', 'bytes_per_turn': 64 * 1024, 'alphabet': 'mixed', 'blocks': 1, 'turns': 4, 'restart_before_turn': 3})
    return cases


def longitudinal_plan():
    return [{'id': f'64k-mixed-{turns}-turns-restore', 'bytes_per_turn': 64 * 1024,
             'alphabet': 'mixed', 'blocks': 1, 'turns': turns,
             'restart_before_turn': turns - 1, 'snapshot_limit_bytes': MAX_SNAPSHOT_BYTES}
            for turns in (8, 16)]


def matched_contract_plan():
    # Explicit opt-in: restore an eight-turn DB already larger than the former
    # 2 MiB ceiling, then verify every original payload after the ninth turn.
    # This does not relax the HTTP request bound or qualify native compaction.
    return [{'id': '64k-mixed-9-turns-restore-4mib-contract',
             'bytes_per_turn': 64 * 1024, 'alphabet': 'mixed', 'blocks': 1,
             'turns': 9, 'restart_before_turn': 8,
             'snapshot_limit_bytes': 4 * 1024 * 1024}]


def state_bytes(profile, sid):
    source = profile / 'gemini/antigravity-acp/conversations'
    for suffix in ('-wal', '-journal'):
        journal = source / (sid + '.db' + suffix)
        if journal.exists() and journal.stat().st_size:
            raise gateway.Failure('conversation_not_quiescent')
    state = source / (sid + '.db')
    if not state.is_file() or state.is_symlink():
        raise gateway.Failure('conversation_state_missing_or_invalid')
    return source, state.stat().st_size


def initialize(child, restore_sid=None):
    init = child.rpc('initialize', {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'offline-context-fixture', 'version': '1'}})
    if init.get('protocolVersion') != 1:
        raise gateway.Failure('protocol_mismatch')
    if restore_sid and init.get('agentCapabilities', {}).get('loadSession') is not True:
        raise gateway.Failure('restore_not_advertised')
    params = {'cwd': str(child.work), 'mcpServers': [], '_meta': {'antigravity': {'enabledTools': []}}}
    if restore_sid:
        params['sessionId'] = restore_sid
    session = child.rpc('session/load' if restore_sid else 'session/new', params)
    sid = restore_sid or session.get('sessionId')
    if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', sid):
        raise gateway.Failure('invalid_session_id')
    child.rpc('session/set_mode', {'sessionId': sid, 'modeId': 'default'})
    child.rpc('session/set_model', {'sessionId': sid, 'modelId': 'gemini-2.5-pro'})
    child.response_text = ''  # session/load notifications are historical output.
    return sid


def run_case(case, argv, matrix_deadline):
    started = time.monotonic()
    stub = Stub()
    # 16 turns plus two model-discovery requests; still a fixed bounded fixture.
    stub.request_limit = 20 if case['turns'] > 4 else 16
    thread = threading.Thread(target=stub.serve_forever, daemon=True)
    thread.start()
    temporary = tempfile.TemporaryDirectory(prefix='acp-context-matrix-')
    root = Path(temporary.name)
    first = root / 'first'
    first.mkdir(mode=0o700)
    active_profile = first
    child = None
    result = {'case': case, 'status': 'failed', 'completed_turns': 0, 'clean_process_exits': True, 'restored': False}
    stage = 'start'
    try:
        child = conversation.Native(argv, first, stub.url)
        child.overall_deadline = min(time.monotonic() + 60, matrix_deadline)
        sid = initialize(child)
        for turn in range(case['turns']):
            if time.monotonic() >= matrix_deadline:
                raise gateway.Failure('matrix_time_budget')
            if case['restart_before_turn'] == turn:
                stage = 'clean_exit_before_restore'
                conversation.close_native(child)
                child = None
                source, selected_bytes = state_bytes(first, sid)
                result['restored_state_bytes'] = selected_bytes
                if selected_bytes > case.get('snapshot_limit_bytes', conversation.MAX_STATE_BYTES):
                    raise gateway.Failure('conversation_state_bound')
                second = root / 'second'
                second.mkdir(mode=0o700)
                stage = 'restore'
                child = conversation.Native(argv, second, stub.url, (source, sid, ('.db',)))
                active_profile = second
                child.overall_deadline = min(time.monotonic() + 60, matrix_deadline)
                initialize(child, sid)
                result['restored'] = True
            label = case['id'].upper().replace('-', '_') + f'_T{turn + 1}'
            text = payload(case['bytes_per_turn'], case['alphabet'], label)
            pieces = blocks(text, case['blocks'])
            request = {'sessionId': sid, 'prompt': [{'type': 'text', 'text': piece} for piece in pieces]}
            if len(json.dumps(request, ensure_ascii=False).encode()) > gateway.LIMIT - 1024:
                raise gateway.Failure('fixture_input_frame_bound')
            stub.expected.append({'text': text, 'label': label, 'pieces': pieces})
            stage = 'prompt'
            child.response_text = ''
            response = child.rpc('session/prompt', request, timeout=25)
            if response.get('stopReason') != 'end_turn' or child.response_text.strip() != gateway.TEXT:
                raise gateway.Failure('fixture_response_incomplete')
            result['completed_turns'] += 1
        stage = 'cleanup'
        conversation.close_native(child)
        child = None
        _, result['final_state_bytes'] = state_bytes(active_profile, sid)
        if result['final_state_bytes'] > case.get('snapshot_limit_bytes', conversation.MAX_STATE_BYTES):
            raise gateway.Failure('conversation_state_bound')
        result['content_integrity_verified'] = bool(stub.observations) and all(check['all_payload_content_preserved'] for observation in stub.observations for check in observation['turns'])
        result['status'] = 'passed' if result['content_integrity_verified'] else 'failed'
        if not result['content_integrity_verified']:
            result['error'] = 'synthetic_content_not_fully_preserved'
    except gateway.Failure as error:
        result.update(error=str(error), stage=stage)
    except Exception as error:
        result.update(error='fixture_exception', error_type=type(error).__name__, stage=stage)
    finally:
        if child:
            try:
                conversation.close_native(child)
            except Exception:
                result['clean_process_exits'] = False
        stub.stop.set()
        stub.shutdown()
        stub.server_close()
        thread.join(timeout=2)
        if result['clean_process_exits']:
            temporary.cleanup()
        else:
            # Do not erase state under a process whose shutdown was not confirmed.
            temporary._finalizer.detach()
        result['observations'] = stub.observations
        result['observed_content_integrity_verified'] = bool(stub.observations) and all(check['all_payload_content_preserved'] for observation in stub.observations for check in observation['turns'])
        result['gateway_requests'] = stub.records
        result['generation_count'] = stub.generations
        result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return result


def selftest():
    for size in (64 * 1024, 128 * 1024, MAX_PROMPT_BYTES):
        for alphabet in ALPHABETS:
            text = payload(size, alphabet, 'SELFTEST')
            for count in (1, 4):
                pieces = blocks(text, count)
                body = {'contents': [{'parts': [{'text': ' '.join(pieces)}]}]}
                result = integrity(body, text, 'SELFTEST', pieces)
                assert result['all_payload_content_preserved'] and all(result['sentinels'].values())
                truncated = integrity({'text': text[:len(text) // 3]}, text, 'SELFTEST', pieces)
                assert not truncated['all_payload_content_preserved'] and not truncated['sentinels']['end']
    print(json.dumps({'status': 'passed', 'mode': 'pure_fixture_selftest', 'native_run': False, 'planned_cases': len(plan())}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--longitudinal', action='store_true', help='Only the opt-in 8/16-turn bounded snapshot cases')
    parser.add_argument('--case', choices=[case['id'] for case in plan() + longitudinal_plan() + matched_contract_plan()])
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--run', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    available = longitudinal_plan() if args.longitudinal else plan()
    if args.case:
        available = [case for case in plan() + longitudinal_plan() + matched_contract_plan() if case['id'] == args.case]
    if args.self_test:
        selftest()
        return
    if args.plan:
        print(json.dumps({'source_version': VERSION, 'matrix_budget_seconds': MATRIX_SECONDS, 'cases': available}, sort_keys=True))
        return
    if not args.run or not Path(args.run[0]).is_absolute() or args.output_dir is None:
        parser.error('--output-dir and --run /absolute/runtime [args] required')
    args.output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    deadline = time.monotonic() + MATRIX_SECONDS
    results = []
    selected = available
    for case in selected:
        if time.monotonic() >= deadline:
            break
        result = run_case(case, args.run, deadline)
        result['source_version'] = VERSION
        (args.output_dir / (case['id'] + '.json')).write_text(json.dumps(result, sort_keys=True))
        results.append(result)
        print(json.dumps({'case': case['id'], 'status': result['status'], 'completed_turns': result['completed_turns'], 'clean_process_exits': result['clean_process_exits']}), flush=True)
        if not result['clean_process_exits']:
            break
    summary = {'source_version': VERSION, 'scope': 'synthetic native gateway integrity; not real model capacity, consumer auth, quota, security proof, or incidental egress certification', 'planned': len(selected), 'completed': len(results), 'passed': sum(result['status'] == 'passed' for result in results), 'failed': sum(result['status'] != 'passed' for result in results), 'all_cleanup_confirmed': all(result['clean_process_exits'] for result in results), 'matrix_time_budget_seconds': MATRIX_SECONDS}
    (args.output_dir / 'summary.json').write_text(json.dumps(summary, sort_keys=True))
    print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    main()
