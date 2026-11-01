import { runtimeEnvironment, agent } from './runtime-environment.ts';
import fs from 'node:fs';
import path from 'node:path';
export { runtimeEnvironment };
export const PROJECTS_DIR = path.join(agent, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true, mode: 0o700 });
process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;
