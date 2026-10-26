/*
 * Certificates for Tau's HTTPS listener.
 *
 * Browsers grant microphone access only to secure contexts, so the network
 * listener always speaks HTTPS. Tau keeps a small local certificate authority
 * under `<agentDir>/tau/tls/`: install its `ca.crt` on a phone once and every
 * later server certificate is trusted. The server certificate is reissued by
 * the same CA whenever this machine's names or addresses are no longer covered,
 * so that trust survives network changes.
 *
 * node:crypto generates keys but cannot build X.509 certificates; the
 * `openssl` CLI signs them.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CA_DAYS = 3650;
// Apple rejects locally trusted server certificates valid for longer.
const SERVER_DAYS = 825;
const RENEW_BEFORE_MS = 30 * 86_400_000;
const DNS_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export type TlsCertificate = { caFile: string; key: string; cert: string };

/** Numeric addresses browsers can reach; scoped/link-local IPv6 cannot appear in URLs. */
export function reachableAddresses(interfaces = os.networkInterfaces()): string[] {
  return [...new Set(Object.values(interfaces).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.includes('%') && !/^fe[89ab]/i.test(entry.address))
    .map((entry) => entry.address))];
}

export function certificateNames(hostnames: string[], interfaces = os.networkInterfaces()): { dns: string[]; ips: string[] } {
  const dns = [...new Set(['localhost', os.hostname(), ...hostnames].filter(Boolean))];
  for (const name of dns) if (!DNS_NAME.test(name)) throw new Error(`Invalid TLS host name: ${name}`);
  return { dns, ips: [...new Set(['127.0.0.1', '::1', ...reachableAddresses(interfaces)])] };
}

function writePrivate(file: string, data: string) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function newKey(): string {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}

function openssl(args: string[]): string {
  return execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function covers(cert: crypto.X509Certificate, ca: crypto.X509Certificate, key: string, names: { dns: string[]; ips: string[] }, now: number) {
  return cert.verify(ca.publicKey)
    && cert.checkPrivateKey(crypto.createPrivateKey(key))
    && Date.parse(cert.validTo) - now > RENEW_BEFORE_MS
    && names.dns.every((name) => cert.checkHost(name) === name)
    && names.ips.every((ip) => cert.checkIP(ip) !== undefined);
}

/** Creates the CA and keys once; (re)issues the server certificate only when needed. */
export function ensureTlsCertificate(dir: string, hostnames: string[], interfaces = os.networkInterfaces(), now = Date.now()): TlsCertificate {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const caKeyFile = path.join(dir, 'ca.key');
  const caFile = path.join(dir, 'ca.crt');
  const keyFile = path.join(dir, 'server.key');
  const certFile = path.join(dir, 'server.crt');

  if (!fs.existsSync(caKeyFile) || !fs.existsSync(caFile)) {
    writePrivate(caKeyFile, newKey());
    writePrivate(caFile, openssl([
      'req', '-x509', '-new', '-key', caKeyFile, '-days', String(CA_DAYS),
      '-subj', `/CN=Tau local CA (${os.hostname()})`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]));
  }
  if (!fs.existsSync(keyFile)) writePrivate(keyFile, newKey());
  const key = fs.readFileSync(keyFile, 'utf8');
  const names = certificateNames(hostnames, interfaces);
  const ca = new crypto.X509Certificate(fs.readFileSync(caFile));
  const current = fs.existsSync(certFile) ? new crypto.X509Certificate(fs.readFileSync(certFile)) : null;
  if (!current || !covers(current, ca, key, names, now)) {
    writePrivate(certFile, openssl([
      'req', '-x509', '-new', '-key', keyFile, '-CA', caFile, '-CAkey', caKeyFile, '-days', String(SERVER_DAYS),
      '-subj', `/CN=${os.hostname()}`,
      '-addext', `subjectAltName=${[...names.dns.map((name) => `DNS:${name}`), ...names.ips.map((ip) => `IP:${ip}`)].join(',')}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature',
      '-addext', 'extendedKeyUsage=serverAuth',
    ]));
  }
  return { caFile, key, cert: fs.readFileSync(certFile, 'utf8') };
}
