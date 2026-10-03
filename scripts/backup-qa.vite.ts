import { defineConfig, isRunnableDevEnvironment } from 'vite';
import base from '../vite.config.ts';
import { createPgliteBackupHandler } from '../src/lib/server/pglite-backup.ts';

// Explicit isolated config only; never imported by the normal application config.
export default defineConfig(env => {
  if (process.env.DATABASE_URL || process.env.VERCEL || !process.env.LOOM_BACKUP_QA_TOKEN) throw Error('Isolated memory QA configuration required');
  const config = typeof base === 'function' ? base(env) : base;
  return { ...config, plugins: [{
    name:'loom-isolated-backup-qa',
    configureServer(server) {
      const handle = createPgliteBackupHandler({enabled:true,token:process.env.LOOM_BACKUP_QA_TOKEN!,getDatabase:async()=>{
        const environment = server.environments.ssr;
        if (!isRunnableDevEnvironment(environment)) throw Error('Application runner unavailable');
        const module = await environment.runner.import('/src/lib/db.ts');
        return module.getPglite();
      }});
      server.middlewares.use(async(req,res,next)=>{
        if (req.url?.split('?')[0] !== '/__qa/backup') return next();
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0)>0) {res.writeHead(400,{'Cache-Control':'no-store'});res.end();return;}
        try {
          const response=await handle(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers as Record<string,string>}),req.socket.remoteAddress);
          res.writeHead(response.status,Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {res.writeHead(500,{'Cache-Control':'no-store'});res.end();}
      });
    },
  },...(config.plugins ?? [])] };
});
