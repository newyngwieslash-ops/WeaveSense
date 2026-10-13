import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { VIDEO_KINDS, videoId, rawTranscript } from './c02-fixtures.mjs';

// Controlled upstream bytes only. Real worker client parsing, S3 signer and business CAS remain untouched.
export async function startSubtitleInput({ token, beforeReply, onMetrics = () => {} }) {
  const metrics = { requests: [], active: 0, unexpected: [] }, revisions = new Map();
  const fixtures = new Map(VIDEO_KINDS.flatMap(kind => [1280,390].map(width => [videoId(kind,width),{kind,width,id:`qa-c02-${kind}-${width}`}])));
  const server = createServer(async (req,res) => {
    const start = Date.now(); let timer, active = false, record;
    res.once('close', () => { clearTimeout(timer); if (active) metrics.active--; if(record){record.closed=true;record.elapsedMs=Date.now()-start;} onMetrics(metrics); });
    try {
      assert.equal(req.method,'POST'); assert.equal(req.url,'/v1/transcript');
      assert.equal(req.headers.authorization,'Bearer '+token);
      let body=''; for await(const bytes of req){body+=bytes;assert.ok(Buffer.byteLength(body)<=4096);}
      const input=JSON.parse(body);assert.deepEqual(Object.keys(input).sort(),['language','video_id']);
      assert.ok(['en','zh-Hans','zh-Hant'].includes(input.language)); const fixture=fixtures.get(input.video_id);assert.ok(fixture);
      record={video:input.video_id,language:input.language,kind:fixture.kind,at:start};metrics.requests.push(record);metrics.active++;active=true;onMetrics(metrics);
      if(fixture.kind==='timeout') {
        res.writeHead(200,{'content-type':'application/json'});
        const drip=()=>{if(res.destroyed)return;res.write(' ');timer=setTimeout(drip,250);};drip();return;
      }
      await beforeReply?.(fixture); await new Promise(resolve=>setTimeout(resolve,250));
      if(fixture.kind==='invalid'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',video_id:'XXXXXXXXXXX',language:input.language,kind:'manual',text:'forged',json3:'{}'}));return;}
      if(fixture.kind==='none'){res.end(JSON.stringify({status:'no_subtitles',video_id:input.video_id,language:input.language,kind:'none',text:''}));return;}
      const json3=rawTranscript(fixture.kind,revisions.get(input.video_id)??0);
      const chunks=JSON.parse(json3).events.map(e=>e.segs.map(s=>s.utf8).join('').trim());
      const text=chunks.filter((text,index)=>index===0||text!==chunks[index-1]).join('\n');
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',video_id:input.video_id,language:input.language,kind:fixture.kind==='automatic'?'automatic':'manual',text,json3}));
    } catch(error){metrics.unexpected.push(error.message);onMetrics(metrics);res.writeHead(400);res.end(JSON.stringify({error:'fixture_rejected'}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {server,metrics,origin:'http://127.0.0.1:'+server.address().port,changeDigest(video){assert.ok(fixtures.has(video));revisions.set(video,(revisions.get(video)??0)+1);}};
}
