#!/usr/bin/env python3
"""Bounded functional fixture; NOT a network sandbox or security test.
Only local stub traffic is initiated by this script. Native incidental egress is
not controlled or certified. Run native only on the already authorized host.
"""
import argparse, http.server, json, os, re, selectors, signal, subprocess
import tempfile, threading, time, urllib.request, urllib.error
from pathlib import Path
TEXT = 'offline fixture response'
PROMPT = 'Reply with a short greeting. Do not use tools or access files or networks.'
LIMIT = 2 * 1024 * 1024
SOURCE_VERSION = 'gateway-fixture-v5-bounded-input-range'
START_SENTINEL = '[OFFLINE_SYNTHETIC_CONTEXT_START_v3]'
END_SENTINEL = '[OFFLINE_SYNTHETIC_CONTEXT_END_v3]'
def fixture_prompt(case, large_bytes=512*1024, alphabet='unicode'):
    if case != 'large': return PROMPT
    if not 8192 <= large_bytes <= 512*1024: raise ValueError('large_bytes_out_of_range')
    if alphabet not in ('ascii','unicode'): raise ValueError('large_alphabet_invalid')
    prefix = PROMPT + '\n' + START_SENTINEL
    suffix = END_SENTINEL
    remaining = large_bytes-len((prefix+suffix).encode())
    unit = '\n界🙂x' if alphabet == 'unicode' else '\nabcXYZ09'
    count, remainder = divmod(remaining,len(unit.encode()))
    result = prefix + unit*count + 'x'*remainder + suffix
    assert len(result.encode()) == large_bytes
    return result

def context_integrity(payload, expected):
    # Inspect only JSON string values under text keys, never emit their content.
    texts = []
    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == 'text' and isinstance(item, str): texts.append(item)
                elif isinstance(item, (dict, list)): walk(item)
        elif isinstance(value, list):
            for item in value: walk(item)
    walk(payload)
    joined = ''.join(texts)
    full_single = any(expected in value for value in texts)
    full_joined = expected in joined
    prefix = suffix = 0
    for value in texts:
        # Native normally places user text in one part; these measurements also
        # disclose front/back loss without costly sequence alignment.
        start = value.find(expected[:min(32,len(expected))])
        if start >= 0:
            candidate = value[start:]
            n = 0
            for a,b in zip(expected,candidate):
                if a != b: break
                n += 1
            prefix = max(prefix,len(expected[:n].encode()))
        end = value.rfind(expected[-min(32,len(expected)):])
        if end >= 0:
            candidate = value[:end+min(32,len(expected))]
            n = 0
            for a,b in zip(reversed(expected),reversed(candidate)):
                if a != b: break
                n += 1
            suffix = max(suffix,len(expected[len(expected)-n:].encode()) if n else 0)
    expected_bytes = len(expected.encode())
    return {'expected_prompt_utf8_bytes': expected_bytes,
            'request_text_field_count': len(texts),
            'request_text_fields': [{'index':i,'utf8_bytes':len(t.encode()),'characters':len(t)} for i,t in enumerate(texts)],
            'request_total_text_utf8_bytes': sum(len(t.encode()) for t in texts),
            'full_prompt_in_single_text_field': full_single,
            'full_prompt_in_concatenated_text_fields': full_joined,
            'full_prompt_matching_utf8_bytes': expected_bytes if full_joined else 0,
            'longest_matching_prompt_prefix_utf8_bytes': prefix,
            'longest_matching_prompt_suffix_utf8_bytes': suffix,
            'start_sentinel_present': START_SENTINEL in joined,
            'end_sentinel_present': END_SENTINEL in joined}

def numeric_context_metadata(value):
    allowed = {'maxTokens','max_tokens','contextWindow','contextWindowSize','context_window_size','inputTokenLimit','outputTokenLimit','used','size','max','limit'}
    found = []
    def walk(v):
        if isinstance(v,dict):
            for k,item in v.items():
                if k in allowed and type(item) in (int,float): found.append({'field':k,'value':item})
                elif isinstance(item,(dict,list)): walk(item)
        elif isinstance(v,list):
            for item in v: walk(item)
    walk(value)
    return found[:64]

class Failure(Exception): pass

class Stub(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, case='basic', large_bytes=512*1024, alphabet='unicode'):
        self.case = case
        self.expected_prompt = fixture_prompt(case, large_bytes, alphabet)
        self.started = threading.Event()
        self.stop = threading.Event()
        self.expected_text = TEXT
        super().__init__(('127.0.0.1', 0), Handler)
        self.records = []
        self.generations = 0
        self.lock = threading.Lock()
    def handle_error(self, request, client_address): pass  # No raw tracebacks.
    @property
    def url(self): return 'http://127.0.0.1:%d' % self.server_port

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def setup(self):
        super().setup(); self.connection.settimeout(5)
    def do_GET(self): self.handle_request()
    def do_POST(self): self.handle_request()
    def handle_request(self):
        path = self.path.split('?', 1)[0]
        recognized = bool(re.fullmatch(r'/(?:v1beta|v1)/models(?:/[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent|countTokens))?', path))
        try: length = int(self.headers.get('Content-Length', '0'))
        except ValueError: length = LIMIT + 1
        if not 0 <= length <= LIMIT:
            self.send_error(413); return
        raw = self.rfile.read(length)
        try: payload = json.loads(raw) if raw else None
        except ValueError: payload = None
        # Structural only: no headers, query, prompt, arbitrary object keys, or model IDs.
        record = {'method': self.command, 'path': re.sub(r'/models/[^/:]+:', '/models/<model>:', path) if recognized else '<unrecognized>',
                  'length': length, 'request_type': type(payload).__name__,
                  'has_contents': isinstance(payload, dict) and isinstance(payload.get('contents'), list),
                  'has_tools': isinstance(payload, dict) and bool(payload.get('tools'))}
        with self.server.lock:
            count = len(self.server.records) + 1
            request_limit = getattr(self.server, 'request_limit', 16)
            if count <= request_limit + 1: self.server.records.append(record)
        if count > request_limit or not recognized:
            self.send_error(400); return
        if self.command == 'GET' and path.endswith('/models'):
            body = {'models': [{'name': 'models/gemini-2.5-pro', 'displayName': 'Offline fixture', 'supportedGenerationMethods': ['generateContent'], 'inputTokenLimit': 1048576, 'outputTokenLimit': 8192}]}
        elif self.command == 'POST' and path.endswith(':countTokens'):
            body = {'totalTokens': 10}
        elif self.command == 'POST' and path.endswith((':generateContent', ':streamGenerateContent')):
            record['request_model_matches_fixture'] = '/models/gemini-2.5-pro:' in path
            if self.server.case == 'large': record['context_integrity'] = context_integrity(payload, self.server.expected_prompt)
            with self.server.lock: self.server.generations += 1
            self.server.started.set()
            if self.server.case == 'outage':
                record['response_status'] = 503
                self.send_response(503); self.send_header('Content-Length', '0')
                self.send_header('Connection', 'close'); self.end_headers(); return
            if self.server.case == 'cancel':
                # Ordinary backend delay, released at case completion; no upstream.
                self.server.stop.wait(20)
                return
            body = {'candidates': [{'content': {'role': 'model', 'parts': [{'text': TEXT}]}, 'finishReason': 'STOP', 'index': 0}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 3, 'totalTokenCount': 13}, 'modelVersion': 'gemini-2.5-pro'}
        else:
            self.send_error(400); return
        sse = path.endswith(':streamGenerateContent') and 'alt=sse' in self.path
        data = (('data: ' + json.dumps(body) + '\n\n') if sse else json.dumps([body] if path.endswith(':streamGenerateContent') else body)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if sse else 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close'); self.end_headers()
        record['response_status'] = 200
        record['response_bytes'] = len(data)
        started = time.monotonic()
        if self.server.case == 'fragmented' and sse:
            # Deliberately split JSON/SSE framing; 16-byte writes at 1 KiB/s,
            # plus one 300 ms pause. This is not a whole-link bandwidth limit.
            record['fragment_bytes'] = 16
            record['target_body_bytes_per_second'] = 1024
            for offset in range(0, len(data), 16):
                if offset == 160 and self.server.stop.wait(0.3): break
                piece = data[offset:offset+16]
                self.wfile.write(piece); self.wfile.flush()
                if self.server.stop.wait(len(piece)/1024): break
        else:
            self.wfile.write(data)
        record['response_write_seconds'] = round(time.monotonic()-started, 3)

class Native:
    def __init__(self, argv, root, url):
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        for key, name in [('HOME','home'), ('GEMINI_HOME','gemini'), ('XDG_CONFIG_HOME','config'), ('XDG_CACHE_HOME','cache'), ('XDG_DATA_HOME','data'), ('TMPDIR','tmp')]:
            p = root/name; p.mkdir(mode=0o700); env[key] = str(p)
        cfg = Path(env['GEMINI_HOME'])/'antigravity-acp'; cfg.mkdir()
        (cfg/'settings.json').write_text(json.dumps({'auth': {'type': 'gateway'}}))
        env['AGY_LLM_GATEWAY_URL'] = url
        self.work = root/'work'; self.work.mkdir()
        self.p = subprocess.Popen(argv, cwd=self.work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        self.sel = selectors.DefaultSelector(); self.sel.register(self.p.stdout, selectors.EVENT_READ)
        self.buf = b''; self.total = 0; self.n = 0; self.response_text = ''; self.notifications = 0
        self.usage_updates = []; self.explicit_context_events = []; self.current_model_matches_fixture = None
        self.overall_deadline = time.monotonic() + 22
        self.write_lock = threading.Lock()
        os.set_blocking(self.p.stdin.fileno(), False)
    def send(self, x):
        data = (json.dumps(x, ensure_ascii=False)+'\n').encode()
        with self.write_lock:
            with selectors.DefaultSelector() as writable:
                writable.register(self.p.stdin, selectors.EVENT_WRITE)
                sent = 0
                while sent < len(data):
                    remaining = self.overall_deadline-time.monotonic()
                    if remaining <= 0 or not writable.select(remaining): raise Failure('native_input_timeout')
                    try: sent += os.write(self.p.stdin.fileno(), data[sent:sent+65536])
                    except BlockingIOError: continue
    def rpc(self, method, params, timeout=30):
        self.n += 1; ident = self.n
        self.send({'jsonrpc':'2.0','id':ident,'method':method,'params':params})
        deadline = min(time.monotonic()+timeout, self.overall_deadline)
        while time.monotonic() < deadline:
            if b'\n' not in self.buf:
                if not self.sel.select(max(0,deadline-time.monotonic())): raise Failure('response_timeout')
                chunk = os.read(self.p.stdout.fileno(), 65536)
                if not chunk: raise Failure('native_stdout_eof')
                self.total += len(chunk); self.buf += chunk
                if self.total > LIMIT: raise Failure('native_output_limit')
                continue
            line,self.buf = self.buf.split(b'\n',1)
            try: r = json.loads(line)
            except ValueError: raise Failure('native_invalid_json')
            if not isinstance(r,dict): raise Failure('native_invalid_message')
            if 'method' in r:
                self.notifications += 1
                if self.notifications > 256: raise Failure('native_message_limit')
                if 'id' in r:
                    # No tools/permissions are authorized by this text-only fixture.
                    self.send({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32601,'message':'Unsupported by text-only fixture'}})
                    raise Failure('unexpected_client_callback')
                if r.get('method') == 'session/update':
                    u = r.get('params',{}).get('update',{})
                    kind = u.get('sessionUpdate')
                    if kind == 'usage_update':
                        self.usage_updates.append({k:u[k] for k in ('used','size','max') if type(u.get(k)) in (int,float)})
                    if kind == 'current_model_update':
                        self.current_model_matches_fixture = u.get('currentModelId') == 'gemini-2.5-pro'
                    if isinstance(kind,str) and re.fullmatch(r'[a-z_]{1,80}',kind) and any(x in kind for x in ('truncat','compact')):
                        self.explicit_context_events.append(kind)
                    if kind == 'agent_message_chunk':
                        c = u.get('content',{})
                        if c.get('type') == 'text' and isinstance(c.get('text'),str): self.response_text += c['text']
                continue
            if r.get('id') != ident: raise Failure('native_unexpected_response_id')
            if 'error' in r:
                e = r['error']; code=e.get('code') if isinstance(e,dict) else None
                raise Failure('native_rpc_error_code_' + str(code if isinstance(code,int) else 'unknown'))
            if not isinstance(r.get('result'),dict): raise Failure('native_invalid_result')
            return r['result']
        raise Failure('response_timeout')
    def cleanup(self):
        try: self.p.stdin.close()
        except (OSError,ValueError): pass
        try: self.p.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
        for sig in (signal.SIGTERM,signal.SIGKILL):
            try: os.killpg(self.p.pid,sig)
            except ProcessLookupError: break
            try: self.p.wait(timeout=2)
            except subprocess.TimeoutExpired: pass
        self.p.wait(timeout=3); self.sel.close(); self.p.stdout.close()
        return self.p.returncode

def selftest(stub):
    listing = json.load(urllib.request.urlopen(stub.url+'/v1beta/models?pageSize=1000',timeout=3))
    req = urllib.request.Request(stub.url+'/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', data=json.dumps({'contents':[{'role':'user','parts':[{'text':PROMPT}]}]}).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=3) as r: data=r.read(LIMIT)
    assert listing['models'][0]['name']=='models/gemini-2.5-pro'
    assert json.loads(data.decode().removeprefix('data: ').strip())['candidates'][0]['content']['parts'][0]['text']==TEXT
    return {'mode':'stub_selftest','status':'passed'}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--large-bytes',type=int,default=512*1024); ap.add_argument('--large-alphabet',choices=['ascii','unicode'],default='unicode'); ap.add_argument('--case', choices=['basic','large','fragmented','cancel','outage'], default='basic'); ap.add_argument('--run',nargs=argparse.REMAINDER); args=ap.parse_args()
    if not 8192 <= args.large_bytes <= 512*1024: ap.error('--large-bytes must be between 8192 and 524288')
    if not args.run and args.case != 'basic': ap.error('case selection requires --run; default selftest is basic')
    started = time.monotonic()
    stub=Stub(args.case,args.large_bytes,args.large_alphabet); thread=threading.Thread(target=stub.serve_forever,daemon=True); thread.start()
    result={'mode':'native' if args.run else 'stub_selftest','status':'failed'}; child=None; stage='startup'; cancel_thread=None
    prompt=stub.expected_prompt
    try:
        if not args.run: result=selftest(stub)
        else:
            if not Path(args.run[0]).is_absolute(): raise Failure('native_path_must_be_absolute')
            with tempfile.TemporaryDirectory(prefix='acp-gateway-fixture-') as td:
                try:
                    child=Native(args.run,Path(td),stub.url)
                    stage='initialize'; r=child.rpc('initialize',{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'offline-gateway-fixture','version':'1'}})
                    result['initialize_protocol_1']=r.get('protocolVersion')==1
                    stage='session/new'; r=child.rpc('session/new',{'cwd':str(child.work),'mcpServers':[]})
                    sid=r.get('sessionId')
                    if not isinstance(sid,str): raise Failure('missing_session_id')
                    result['session_created']=True
                    if args.case == 'large':
                        models = r.get('models',{})
                        models = models if isinstance(models,dict) else {}
                        available = models.get('availableModels',[])
                        advertised = isinstance(available,list) and any(isinstance(m,dict) and m.get('modelId')=='gemini-2.5-pro' for m in available)
                        result['fixture_model_advertised']=advertised
                        result['initial_current_model_matches_fixture']=models.get('currentModelId')=='gemini-2.5-pro'
                        result['session_model_numeric_context_metadata']=numeric_context_metadata(models)
                        if advertised:
                            stage='session/set_model'
                            child.rpc('session/set_model',{'sessionId':sid,'modelId':'gemini-2.5-pro'},10)
                            result['fixture_model_selection_acknowledged']=True
                        else:
                            result['fixture_model_selection_acknowledged']=False
                            raise Failure('fixture_model_not_advertised_in_session_model_state')
                    if args.case == 'cancel':
                        def cancel_when_started():
                            if stub.started.wait(15) and not stub.stop.wait(0.15):
                                try:
                                    child.send({'jsonrpc':'2.0','method':'session/cancel','params':{'sessionId':sid}})
                                    result['cancel_notification_sent']=True
                                except Exception: result['cancel_send_failed']=True
                        cancel_thread=threading.Thread(target=cancel_when_started,daemon=True); cancel_thread.start()
                    stage='session/prompt'; r=child.rpc('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':prompt}]},20)
                    result['prompt_rpc_result_received']=True
                    reason=r.get('stopReason')
                    result['stop_reason']=reason if reason in ('end_turn','max_tokens','max_turn_requests','refusal','cancelled') else '<other>'
                    result['fixture_text_received']=child.response_text.strip()==TEXT
                    if args.case in ('cancel','outage'):
                        result['status']='observed'
                        if args.case == 'cancel': result['cancelled_stop_observed']=reason=='cancelled'
                    else:
                        result['status']='passed' if result['fixture_text_received'] and stub.generations>0 and reason=='end_turn' else 'failed'
                finally:
                    stub.stop.set()
                    if child:
                        result['usage_updates']=child.usage_updates
                        result['usage_counts_are_synthetic_backend_metadata']=True
                        result['explicit_context_event_types']=child.explicit_context_events
                        result['current_model_notification_matches_fixture']=child.current_model_matches_fixture
                        result['agent_text_present']=bool(child.response_text)
                        result['agent_text_bytes']=len(child.response_text.encode())
                        result['native_exit_code']=child.cleanup()
                        try:
                            os.killpg(child.p.pid, 0); result['process_group_gone']=False
                        except ProcessLookupError: result['process_group_gone']=True
                    if cancel_thread: cancel_thread.join(timeout=0.1)
    except Failure as e: result.update(error=str(e),stage=stage)
    except Exception as e: result.update(error='harness_exception',error_type=type(e).__name__,stage=stage)
    finally:
        stub.stop.set(); stub.shutdown(); stub.server_close(); thread.join(timeout=2)
    if args.case == 'large' and args.run:
        checks=[r['context_integrity'] for r in stub.records if 'context_integrity' in r]
        result['context_integrity_verified']=bool(checks) and all(c['full_prompt_in_concatenated_text_fields'] for c in checks)
        if not result['context_integrity_verified'] and result['status']=='passed':
            result['status']='failed'
            result['error']='full_synthetic_prompt_not_preserved_in_generation_request'
    result['source_version']=SOURCE_VERSION; result['result_format_version']=5
    if args.case == 'large': result['large_alphabet']=args.large_alphabet; result['requested_large_bytes']=args.large_bytes
    result['case']=args.case; result['synthetic_prompt_utf8_bytes']=len(prompt.encode()); result['elapsed_seconds']=round(time.monotonic()-started,3)
    result['gateway_requests']=stub.records; result['generation_count']=stub.generations
    result['scope']='synthetic text fixture; not real model quality, tools, or egress certification'
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__': main()
