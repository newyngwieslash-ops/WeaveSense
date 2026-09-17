#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('artifacts/agent-v3',{recursive:true});
// Each check owns its binary; a manual Windows worker may still hold agent.exe open.
process.env.LOOM_AGENT_TEST_BINARY=resolve(mkdtempSync('artifacts/agent-v3/check-'),process.platform==='win32'?'agent.exe':'agent');
const built=spawnSync('go',['-C','workers/agent','build','-o',process.env.LOOM_AGENT_TEST_BINARY,'./cmd/agent'],{stdio:'inherit',windowsHide:true,env:{...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local'}});
if(built.status!==0)process.exit(built.status??1);
await import('./agent-integration-harness.mjs');
