// This module runs before Tau's configuration or discovery modules load.
import { runtimeEnvironment } from '../runtime-environment.ts';
import fs from 'node:fs';
import path from 'node:path';
export { runtimeEnvironment };
export const projects = path.join(runtimeEnvironment.root, 'projects');
fs.mkdirSync(projects, { mode: 0o700 });
process.env.TAU_PROJECTS_DIR = projects;
