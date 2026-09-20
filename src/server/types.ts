export type JsonRecord = Record<string, unknown>;
export type TauArgs = Record<string, string | boolean | undefined> & {
  open?: boolean;
  port?: string;
  host?: string;
  'projects-dir'?: string;
};
export type TauSettingsFile = {
  tau?: {
    port?: string | number;
    host?: string;
    user?: string;
    pass?: string;
    authEnabled?: boolean;
    cookieSecret?: string;
    projectsDir?: string;
    [key: string]: unknown;
  };
};
export type TauSettings = {
  port: number;
  host: string;
  user: string;
  pass: string;
  authEnabled?: boolean;
  cookieSecret?: string;
  projectsDir: string;
};
export type ModelIdentity = {
  provider?: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
};
export type ParsedModelSpec = { model: ModelIdentity | null; level: string | null };
export type RpcCommand = {
  id?: string;
  type?: string;
  sessionId?: string;
  filePath?: string;
  outputPath?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  modelId?: string;
  level?: string;
  name?: string;
  enabled?: boolean;
  [key: string]: unknown;
};
/**
 * Extra `pi` CLI arguments and environment for a spawned session. Callers that
 * drive tau programmatically (pi-ant orchestration) need the child to run with
 * their own extensions, model flags, and orchestration variables.
 */
export type SessionSpawnOverrides = {
  args?: string[];
  env?: Record<string, string>;
};
export type RpcResponse = JsonRecord;
export type PendingCommand = {
  resolve: (value: RpcResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  command?: string;
};
export type LiveClient = {
  readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  isAlive?: boolean;
};
export type StatusError = Error & { status?: number; stderr?: string };


