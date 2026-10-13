import asyncio
import json
import sys
import unittest
from unittest.mock import patch
import server as s

VIDEO = 'BaW_jenozKc'
RAW = json.dumps({'events': [{'segs': [{'utf8': x}]} for x in ['one', 'one', 'two', 'one']]})

class Protocol(unittest.IsolatedAsyncioTestCase):
    async def test_relay_delayed_success_and_deadline_cleanup(self):
        # Real loopback HTTP worker -> production relay; only Docker service
        # discovery is redirected. Inbound header protection remains exercised.
        mode = 'healthy'
        closed = asyncio.Event()
        async def upstream(reader, writer):
            try:
                _, _, headers = await s.read_head(reader)
                await reader.readexactly(int(headers['content-length']))
                if mode == 'healthy':
                    await asyncio.sleep(5.25)
                    await s.respond(writer, 200, dict(status='no_subtitles', video_id=VIDEO, language='en', kind='none', text=''))
                elif mode == 'body_timeout':
                    # Headers consume part of the SAME overall budget; the
                    # partial body must not receive a newly reset deadline.
                    await asyncio.sleep(.1)
                    writer.write(b'HTTP/1.1 200 Result\r\nContent-Length: 100\r\n\r\n{')
                    await writer.drain()
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()
                closed.set()
        upstream_server = await asyncio.start_server(upstream, '127.0.0.1', 0)
        app = s.Server('egress', 'test-token', 'proxy-token')
        relay_server = await asyncio.start_server(app.handle, '127.0.0.1', 0)
        async def cleanup():
            for server in (upstream_server, relay_server):
                server.close()
                await server.wait_closed()
        self.addAsyncCleanup(cleanup)
        open_connection = asyncio.open_connection
        async def connect(host, port):
            if host == 'subtitle-worker':
                host, port = '127.0.0.1', upstream_server.sockets[0].getsockname()[1]
            return await open_connection(host, port)
        async def request():
            reader, writer = await open_connection('127.0.0.1', relay_server.sockets[0].getsockname()[1])
            body = json.dumps(dict(video_id=VIDEO, language='en')).encode()
            writer.write(f'POST /v1/transcript HTTP/1.1\r\nContent-Type: application/json\r\nAuthorization: Bearer test-token\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body)
            await writer.drain()
            result = await asyncio.wait_for(reader.read(), 8)
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(closed.wait(), 1)
            self.assertFalse(app.busy)
            self.assertEqual(app.connections, 0)
            return result
        with patch.object(s.asyncio, 'open_connection', connect):
            start = asyncio.get_running_loop().time()
            result = await request()
            self.assertIn(b' 200 ', result)
            self.assertIn(b'no_subtitles', result)
            self.assertGreater(asyncio.get_running_loop().time()-start, 5)
            timeout = asyncio.timeout
            # Scale only the existing overall request deadline for deterministic
            # fault injection; the 5s inbound wait_for and real code stay intact.
            for mode in ('header_timeout', 'body_timeout'):
                closed.clear()
                with patch.object(s.asyncio, 'timeout', lambda seconds: timeout(.2 if seconds == 46 else seconds)):
                    result = await request()
                self.assertIn(b' 504 ', result)
                self.assertIn(b'"error":"timeout"', result)

    def test_inputs_and_json3(self):
        self.assertEqual(s.validate_request({'video_id': VIDEO, 'language': 'en'}), (VIDEO, 'en'))
        for body in [{}, {'video_id': '../x', 'language': 'en'}, {'video_id': VIDEO, 'language': 'all'},
                     {'video_id': VIDEO, 'language': 'en', 'args': '--exec=x'}]:
            with self.assertRaises(s.Failure): s.validate_request(body)
        self.assertEqual(s.transcript_text(RAW), 'one\ntwo\none')
        for raw in ['{}', '{"events":{}}', '{"events":[{"segs":[{"utf8":3}]}]}',
                    json.dumps({'events':[{}]*100001}), 'x' * (s.MAX_BYTES+1)]:
            with self.assertRaises(s.Failure): s.transcript_text(raw)

    def test_inventory(self):
        meta = {'subtitles': {}, 'automatic_captions': {}}
        self.assertEqual(s.select_kind(meta, 'en'), 'none')
        meta['automatic_captions']['en'] = [{'ext':'json3'}]
        self.assertEqual(s.select_kind(meta, 'en'), 'automatic')
        meta['subtitles']['en'] = [{'ext':'json3'}]
        self.assertEqual(s.select_kind(meta, 'en'), 'manual')
        for value in [{}, {'subtitles':[], 'automatic_captions':{}}]:
            with self.assertRaises(s.Failure): s.select_kind(value, 'en')
        with self.assertRaises(s.Failure): s.encode_result({'text':'x' * s.MAX_BYTES})

    def test_public_addresses(self):
        for ip in ['127.0.0.1','10.1.2.3','169.254.169.254','198.18.0.1','2001:2::1','::ffff:127.0.0.1','::1','192.0.0.9']:
            self.assertFalse(s.public_ip(ip), ip)
        self.assertTrue(s.public_ip('8.8.8.8'))
        for authority in ['evil.com:443','www.youtube.com.evil.com:443','8.8.8.8:443','user@www.youtube.com:443','www.youtube.com:80']:
            with self.assertRaises(s.Failure): s.connect_host(authority)
        self.assertEqual(s.connect_host('www.youtube.com:443'), 'www.youtube.com')

    async def test_pinned_resolution(self):
        async def resolver(host): return ['8.8.8.8', '1.1.1.1']
        self.assertEqual(await s.resolve_public('www.youtube.com', resolver), '8.8.8.8')
        async def mixed(host): return ['8.8.8.8', '127.0.0.1']
        with self.assertRaises(s.Failure): await s.resolve_public('www.youtube.com', mixed)

    async def test_stream_limit_and_timeout(self):
        with self.assertRaisesRegex(s.Failure, 'output_too_large'):
            await s.run_process([sys.executable,'-c', 'import sys; sys.stdout.write("x"*3000000)'], asyncio.get_running_loop().time()+5)
        with self.assertRaisesRegex(s.Failure, 'timeout'):
            await s.run_process([sys.executable,'-c','import time; time.sleep(20)'], asyncio.get_running_loop().time()+0.15)
        with self.assertRaisesRegex(s.Failure, 'upstream_failed'):
            await s.run_process([sys.executable,'-c','raise SystemExit(2)'], asyncio.get_running_loop().time()+5)

    async def test_http_auth_strict_body_and_busy(self):
        async def fake(video, language): return {'status':'no_subtitles','video_id':video,'language':language,'kind':'none','text':''}
        app = s.Server('worker','test-token','proxy-token', extractor=fake)
        server = await asyncio.start_server(app.handle, '127.0.0.1', 0)
        async def close():
            server.close()
            await server.wait_closed()
        self.addAsyncCleanup(close)
        port = server.sockets[0].getsockname()[1]
        async def request(body, token='test-token', extra=''):
            reader, writer = await asyncio.open_connection('127.0.0.1',port)
            data = json.dumps(body).encode()
            writer.write(f'POST /v1/transcript HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n{extra}\r\n'.encode()+data)
            await writer.drain(); result=await reader.read(); writer.close(); await writer.wait_closed(); return result
        body={'video_id':VIDEO,'language':'en'}
        self.assertIn(b' 401 ', await request(body,''))
        self.assertIn(b' 400 ', await request({**body,'url':'http://private'}))
        self.assertIn(b' 400 ', await request(body, extra='Content-Length: 1\r\n'))
        self.assertIn(b'no_subtitles', await request(body))
        app.busy=True
        self.assertIn(b' 429 ', await request(body))

class ProcessAndExtraction(unittest.IsolatedAsyncioTestCase):
    async def test_fake_extractor_metadata_download_and_cleanup(self):
        from pathlib import Path
        calls = []
        async def fake(args, deadline, cwd):
            calls.append((args, cwd, deadline))
            if '--dump-single-json' in args:
                return json.dumps({'id':VIDEO,'extractor_key':'Youtube','subtitles':{'en':[{'ext':'json3'}]},'automatic_captions':{}}).encode()
            Path(cwd,'caption.en.json3').write_text(RAW, encoding='utf-8')
            return b''
        with patch.dict(s.os.environ, {'SUBTITLE_PROXY_TOKEN':'fake-proxy'}), patch.object(s,'run_process',fake):
            result=await s.extract(VIDEO,'en')
        self.assertEqual(result['text'],'one\ntwo\none');self.assertEqual(result['json3'],RAW)
        self.assertEqual(calls[0][2],calls[1][2]);self.assertFalse(Path(calls[0][1]).exists())
        self.assertIn('--write-subs',calls[1][0]);self.assertNotIn('--write-auto-subs',calls[1][0])
        self.assertIn('--no-plugin-dirs',calls[0][0]);self.assertIn('--no-remote-components',calls[0][0])

    @unittest.skipUnless(s.os.name == 'posix', 'Linux process-group / RLIMIT check runs in production image')
    async def test_file_cap_and_descendant_reaping(self):
        import os
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(s.Failure,'output_too_large'):
                await s.run_process([sys.executable,'-c',"open('large','wb').write(b'x'*3000000)"],asyncio.get_running_loop().time()+3,directory)
            self.assertLessEqual(Path(directory,'large').stat().st_size,s.MAX_BYTES)
            pidfile=Path(directory,'pid')
            source="import subprocess,time; p=subprocess.Popen(['sleep','30']);open('pid','w').write(str(p.pid));time.sleep(30)"
            with self.assertRaisesRegex(s.Failure,'timeout'):
                await s.run_process([sys.executable,'-c',source],asyncio.get_running_loop().time()+0.4,directory)
            pid=int(pidfile.read_text())
            for _ in range(30):
                if not Path('/proc',str(pid)).exists():break
                await asyncio.sleep(.05)
            self.assertFalse(Path('/proc',str(pid)).exists(), 'solver descendant must be reaped by container init')

    async def test_connect_pins_numeric_dial_and_refuses_mixed_dns(self):
        calls=[]
        async def fake_open(host, port):
            calls.append((host,port));raise OSError('test dial stop')
        app=s.Server('egress','token','proxy')
        auth='Basic '+s.base64.b64encode(b'subtitle:proxy').decode()
        with patch.object(s,'resolve_public',return_value='8.8.8.8'),patch.object(s.asyncio,'open_connection',fake_open):
            with self.assertRaises(OSError):await app.tunnel(None,None,'www.youtube.com:443',{'proxy-authorization':auth})
        self.assertEqual(calls,[('8.8.8.8',443)])
        calls.clear()
        with patch.object(s.asyncio,'open_connection',fake_open):
            with self.assertRaises(s.Failure):await app.tunnel(None,None,'attacker.example:443',{'proxy-authorization':auth})
        self.assertEqual(calls,[])

if __name__ == '__main__': unittest.main()
