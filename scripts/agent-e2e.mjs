#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('artifacts/agent-v3',{recursive:true});
const built=spawnSync('go',['-C','workers/agent','build','-o',process.platform==='win32'?'../../artifacts/agent-v3/agent.exe':'../../artifacts/agent-v3/agent','./cmd/agent'],{stdio:'inherit',windowsHide:true,env:{...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local'}});
if(built.status!==0)process.exit(built.status??1);
await import('./agent-integration-harness.mjs');
