import { runtimeEnvironment } from './runtime-environment.ts';
export { runtimeEnvironment };
// Synthetic credentials exercise authenticated settings; never use a user's file.
process.env.TAU_USER = 'test-admin';
process.env.TAU_PASS = 'test-password';
