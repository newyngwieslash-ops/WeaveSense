"""Fixed YouTube subtitle worker and its authenticated, IP-pinned transport relay."""
import asyncio
import base64
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tempfile
import subprocess
from importlib.metadata import version

MAX_BYTES = 2 * 1024 * 1024
LANGUAGES = ('en', 'zh-Hans', 'zh-Hant')
# Pinned extractor _base.py uses www.youtube.com for page/player/API and captions.
# Additional hosts require extractor evidence + review; never suffix matching.
HOSTS = frozenset(('www.youtube.com',))

class Failure(Exception):
    def __init__(self, code, status=502):
        super().__init__(code)
        self.code, self.status = code, status


def validate_request(value):
    if (not isinstance(value, dict) or set(value) != {'video_id', 'language'}
            or not isinstance(value['video_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{11}', value['video_id'])
            or value['language'] not in LANGUAGES):
        raise Failure('invalid_request', 400)
    return value['video_id'], value['language']


def transcript_text(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_BYTES:
        raise Failure('output_too_large')
    try:
        payload = json.loads(raw)
    except (ValueError, RecursionError):
        raise Failure('invalid_response') from None
    if not isinstance(payload, dict) or not isinstance(payload.get('events'), list):
        raise Failure('invalid_response')
    count, chunks = len(payload['events']), []
    for event in payload['events']:
        if count > 100000 or not isinstance(event, dict):
            raise Failure('invalid_response')
        segs = event.get('segs', [])
        if not isinstance(segs, list):
            raise Failure('invalid_response')
        count += len(segs)
        if count > 100000 or any(not isinstance(s, dict) or not isinstance(s.get('utf8'), str) for s in segs):
            raise Failure('invalid_response')
        text = ''.join(s['utf8'] for s in segs).strip()
        if text and (not chunks or text != chunks[-1]):
            chunks.append(text)
    if not chunks:
        raise Failure('invalid_response')
    return '\n'.join(chunks)


def encode_result(value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(data) > MAX_BYTES:
        raise Failure('output_too_large')
    return data


def select_kind(metadata, language):
    if (not isinstance(metadata, dict) or not isinstance(metadata.get('subtitles'), dict)
            or not isinstance(metadata.get('automatic_captions'), dict)):
        raise Failure('invalid_response')
    for field, kind in [('subtitles', 'manual'), ('automatic_captions', 'automatic')]:
        tracks = metadata[field].get(language, [])
        if not isinstance(tracks, list) or any(not isinstance(t, dict) for t in tracks):
            raise Failure('invalid_response')
        if tracks:
            if not any(t.get('ext') == 'json3' for t in tracks):
                raise Failure('invalid_response')
            return kind
    return 'none'


def public_ip(raw):
    try:
        ip = ipaddress.ip_address(raw)
        if ip.version == 6 and ip.ipv4_mapped:
            return public_ip(str(ip.ipv4_mapped))
        forbidden = ('192.0.0.0/24', '198.18.0.0/15') if ip.version == 4 else ('2001:2::/48', '64:ff9b::/96', '64:ff9b:1::/48', '2002::/16')
        return ip.is_global and not ip.is_multicast and not any(ip in ipaddress.ip_network(c) for c in forbidden)
    except ValueError:
        return False


def connect_host(authority):
    if authority not in {h + ':443' for h in HOSTS}:
        raise Failure('target_not_allowed', 403)
    return authority[:-4]


async def resolve_public(host, resolver=None):
    if host not in HOSTS:
        raise Failure('target_not_allowed', 403)
    if resolver:
        answers = await asyncio.wait_for(resolver(host), 5)
    else:
        records = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM), 5)
        answers = [r[4][0] for r in records]
    if not answers or any(not public_ip(ip) for ip in answers):
        raise Failure('blocked_address', 403)
    return answers[0]


def child_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


async def reap(process):
    if os.name == 'posix':
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                break
            if sig == signal.SIGTERM:
                await asyncio.sleep(0.1)
    elif process.returncode is None:
        process.kill()
    async def discard(stream):
        while await stream.read(16384):
            pass
    await asyncio.gather(discard(process.stdout), discard(process.stderr))
    await process.wait()


async def run_process(args, deadline, cwd=None):
    # No inherited proxy, cookies, app credentials, Python path or user config.
    env = {'PATH': os.environ.get('PATH', ''), 'HOME': cwd or tempfile.gettempdir(),
           'TMPDIR': cwd or tempfile.gettempdir(), 'LANG': 'C.UTF-8'}
    if os.name == 'nt':
        env['SystemRoot'] = os.environ.get('SystemRoot', r'C:\Windows')
    process = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=env,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **({'start_new_session': True, 'preexec_fn': child_limits} if os.name == 'posix' else {}))
    total = 0
    async def drain(stream, keep):
        nonlocal total
        out = bytearray()
        while chunk := await stream.read(16384):
            total += len(chunk)
            if total > MAX_BYTES:
                raise Failure('output_too_large')
            if keep:
                out.extend(chunk)
        return bytes(out)
    tasks = [asyncio.create_task(drain(process.stdout, True)), asyncio.create_task(drain(process.stderr, True))]
    try:
        async with asyncio.timeout(max(0, deadline-asyncio.get_running_loop().time())):
            stdout, stderr = await asyncio.gather(*tasks)
            if await process.wait() != 0:
                if process.returncode == -getattr(signal, 'SIGXFSZ', 25) or b'File too large' in stderr:
                    raise Failure('output_too_large')
                raise Failure('upstream_failed')
            return stdout
    except TimeoutError:
        raise Failure('timeout', 504) from None
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await reap(process)


def command(video, language=None, kind=None, output=None):
    proxy_token = os.environ['SUBTITLE_PROXY_TOKEN']
    proxy = 'http://subtitle:' + proxy_token + '@subtitle-egress:8794'
    args = [sys.executable, '-I', '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--skip-download',
            '--no-cache-dir', '--no-plugin-dirs', '--no-remote-components', '--no-progress',
            '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0',
            '--fragment-retries', '0', '--file-access-retries', '0', '--no-js-runtimes',
            '--js-runtimes', 'node:/usr/local/bin/node', '--proxy', proxy,
            '--use-extractors', 'Youtube$', '--extractor-args', 'youtube:skip=translated_subs']
    if language is None:
        args += ['--dump-single-json']
    else:
        if language not in LANGUAGES or kind not in ('manual', 'automatic') or not output:
            raise Failure('invalid_request', 400)
        args += ['--write-subs' if kind == 'manual' else '--write-auto-subs', '--sub-format', 'json3',
                 '--sub-langs', language, '--output', output]
    return args + ['--', 'https://www.youtube.com/watch?v=' + video]


async def extract(video, language):
    deadline = asyncio.get_running_loop().time() + 45
    with tempfile.TemporaryDirectory(prefix='subtitle-') as directory:
        try:
            metadata = json.loads(await run_process(command(video), deadline, directory))
            if not isinstance(metadata, dict) or metadata.get('id') != video or metadata.get('extractor_key') != 'Youtube':
                raise Failure('invalid_response')
            kind = select_kind(metadata, language)
            result = {'status': 'no_subtitles', 'video_id': video, 'language': language, 'kind': kind, 'text': ''}
            if kind == 'none':
                return result
            await run_process(command(video, language, kind, str(Path(directory)/'caption.%(ext)s')), deadline, directory)
            path = Path(directory)/('caption.' + language + '.json3')
            if path.is_symlink() or not path.is_file():
                raise Failure('invalid_response')
            if path.stat().st_size > MAX_BYTES:
                raise Failure('output_too_large')
            raw = path.read_bytes().decode('utf-8', errors='strict')
            result.update(status='ok', text=transcript_text(raw), json3=raw)
            encode_result(result)
            return result
        except (ValueError, UnicodeError, OSError, RecursionError):
            raise Failure('invalid_response') from None


async def read_head(reader, response=False):
    try:
        # Worker headers arrive only after extraction. Both response headers and
        # body share handle()'s remaining 46s budget; only untrusted inbound
        # headers have the separate 5s slow-client guard.
        raw = await reader.readuntil(b'\r\n\r\n') if response else await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
        raise Failure('invalid_request', 400) from None
    if len(raw) > 8192:
        raise Failure('invalid_request', 400)
    try:
        lines = raw.decode('ascii').split('\r\n')
        method, path, protocol = lines[0].split(' ')
        headers = {}
        for line in lines[1:-2]:
            key, value = line.split(':', 1)
            if not re.fullmatch(r'[A-Za-z0-9-]+', key) or key.lower() in headers or any(ord(c)<32 for c in value):
                raise ValueError()
            headers[key.lower()] = value.strip()
        if (method != 'HTTP/1.1' if response else protocol != 'HTTP/1.1') or 'transfer-encoding' in headers:
            raise ValueError()
        return method, path, headers
    except ValueError:
        raise Failure('invalid_request', 400) from None


async def respond(writer, status, value):
    body = encode_result(value)
    writer.write(f'HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode()+body)
    await writer.drain()


class Server:
    def __init__(self, role, token, proxy_token, extractor=extract):
        self.role, self.token, self.proxy_token, self.extractor = role, token, proxy_token, extractor
        self.busy = False
        self.connections = 0

    async def relay(self, body):
        reader, writer = await asyncio.wait_for(asyncio.open_connection('subtitle-worker', 8793), 3)
        try:
            payload = encode_result(body)
            writer.write(f'POST /v1/transcript HTTP/1.1\r\nHost: subtitle-worker\r\nAuthorization: Bearer {self.token}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n'.encode()+payload)
            await writer.drain()
            method, status, headers = await read_head(reader, response=True)
            if method != 'HTTP/1.1' or not status.isdigit():
                raise Failure('invalid_response')
            size = int(headers.get('content-length', '0'))
            if not 0 < size <= MAX_BYTES:
                raise Failure('output_too_large')
            data = json.loads(await reader.readexactly(size))
            if status != '200':
                code = data.get('error')
                allowed = {'timeout','busy','upstream_failed','invalid_response','output_too_large'}
                raise Failure(code if code in allowed else 'upstream_failed', int(status))
            return data
        finally:
            writer.close()
            await writer.wait_closed()

    async def tunnel(self, reader, writer, authority, headers):
        expected = 'Basic ' + base64.b64encode(('subtitle:'+self.proxy_token).encode()).decode()
        if not hmac.compare_digest(headers.get('proxy-authorization', ''), expected):
            raise Failure('unauthorized', 407)
        host = connect_host(authority)
        ip = await resolve_public(host)
        # Numeric, validated IP: no second hostname lookup / DNS-rebinding window.
        upstream, outgoing = await asyncio.wait_for(asyncio.open_connection(ip, 443), 5)
        total = 0
        async def copy(source, target):
            nonlocal total
            while data := await source.read(16384):
                total += len(data)
                if total > 16 * MAX_BYTES:
                    raise Failure('output_too_large')
                target.write(data)
                await target.drain()
        tasks = []
        try:
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            tasks = [asyncio.create_task(copy(reader, outgoing)), asyncio.create_task(copy(upstream, writer))]
            async with asyncio.timeout(45):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            outgoing.close()
            await outgoing.wait_closed()

    async def handle(self, reader, writer):
        self.connections += 1
        try:
            if self.connections > 32:
                raise Failure('busy', 429)
            method, path, headers = await read_head(reader)
            if method == 'GET' and path == '/health' and headers.get('content-length', '0') == '0':
                await respond(writer, 200, {'ok': True})
                return
            if method == 'CONNECT' and self.role == 'egress':
                await self.tunnel(reader, writer, path, headers)
                return
            if not hmac.compare_digest(headers.get('authorization', ''), 'Bearer '+self.token):
                raise Failure('unauthorized', 401)
            if method != 'POST' or path != '/v1/transcript':
                raise Failure('not_found', 404)
            size = headers.get('content-length', '')
            if not re.fullmatch(r'[0-9]{1,4}', size) or not 0 < int(size) <= 4096 or headers.get('content-type') != 'application/json':
                raise Failure('invalid_request', 400)
            try:
                body = json.loads(await asyncio.wait_for(reader.readexactly(int(size)), 5))
            except (ValueError, RecursionError, asyncio.IncompleteReadError, TimeoutError):
                raise Failure('invalid_request', 400) from None
            video, language = validate_request(body)
            if self.busy:
                raise Failure('busy', 429)
            self.busy = True
            try:
                async with asyncio.timeout(46):
                    result = await self.extractor(video, language) if self.role == 'worker' else await self.relay(body)
                    await respond(writer, 200, result)
            finally:
                self.busy = False
        except Failure as error:
            if not writer.is_closing():
                await respond(writer, error.status, {'error': error.code})
        except TimeoutError:
            await respond(writer, 504, {'error': 'timeout'})
        except (OSError, ValueError, UnicodeError, asyncio.IncompleteReadError):
            await respond(writer, 502, {'error': 'upstream_failed'})
        finally:
            self.connections -= 1
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


async def main():
    role = os.environ.get('SUBTITLE_ROLE')
    token, proxy = os.environ.get('SUBTITLE_SERVICE_TOKEN', ''), os.environ.get('SUBTITLE_PROXY_TOKEN', '')
    if role not in ('worker', 'egress') or any(not re.fullmatch(r'[A-Za-z0-9_-]{24,128}', x) for x in (token, proxy)) or token == proxy:
        raise SystemExit('subtitle_configuration_required')
    if os.name != 'posix':
        raise SystemExit('subtitle_linux_required')
    for line in Path(__file__).with_name('requirements.txt').read_text().splitlines():
        package, pin = line.split('==')
        if tuple(map(int, version(package).split('.'))) != tuple(map(int, pin.split('.'))):
            raise SystemExit('subtitle_tool_version_mismatch')
    node_version = subprocess.run(['/usr/local/bin/node', '--version'], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
    if node_version != 'v24.16.0':
        raise SystemExit('subtitle_node_version_mismatch')
    app = Server(role, token, proxy)
    server = await asyncio.start_server(app.handle, '0.0.0.0', 8793 if role == 'worker' else 8794, limit=8192)
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    asyncio.run(main())
