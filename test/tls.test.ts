import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { ensureTlsCertificate as EnsureTlsCertificate } from '../src/server/tls.ts';

const { ensureTlsCertificate } = (await import('../bin/tls.js')) as { ensureTlsCertificate: typeof EnsureTlsCertificate };

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const entry = (address: string, internal = false) => ({
  address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4',
  netmask: '', mac: '', cidr: null, ...(address.includes(':') ? { scopeid: 0 } : {}),
}) as os.NetworkInterfaceInfo;
const interfaces = { lo: [entry('127.0.0.1', true)], wg0: [entry('10.10.0.2'), entry('fe80::1')], eth0: [entry('2001:db8::7')] };

function tlsDir(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-tls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'tau', 'tls');
}

test('creates a private CA and a server certificate it signs for local names and addresses', (t) => {
  const dir = tlsDir(t);
  const result = ensureTlsCertificate(dir, ['pc'], interfaces);
  const ca = new crypto.X509Certificate(fs.readFileSync(result.caFile));
  const cert = new crypto.X509Certificate(result.cert);
  assert.equal(ca.ca, true);
  assert.equal(cert.ca, false);
  assert.ok(cert.verify(ca.publicKey));
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(result.key)));
  for (const name of ['localhost', os.hostname(), 'pc']) assert.equal(cert.checkHost(name), name);
  for (const ip of ['127.0.0.1', '::1', '10.10.0.2', '2001:db8::7']) assert.ok(cert.checkIP(ip), ip);
  assert.equal(cert.checkIP('fe80::1'), undefined);
  assert.deepEqual(cert.keyUsage, [SERVER_AUTH]);
  assert.ok(Date.parse(cert.validTo) - Date.parse(cert.validFrom) <= 825 * 86_400_000);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const file of ['ca.key', 'server.key']) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
});

test('reuses a covering certificate and reissues with the same CA when names change or expiry nears', (t) => {
  const dir = tlsDir(t);
  const first = ensureTlsCertificate(dir, ['pc'], interfaces);
  const ca = fs.readFileSync(first.caFile, 'utf8');
  assert.equal(ensureTlsCertificate(dir, ['pc'], interfaces).cert, first.cert);

  const moved = ensureTlsCertificate(dir, ['pc'], { ...interfaces, wlan0: [entry('192.168.1.20')] });
  assert.notEqual(moved.cert, first.cert);
  assert.ok(new crypto.X509Certificate(moved.cert).checkIP('192.168.1.20'));
  const renamed = ensureTlsCertificate(dir, ['pc', 'tau.lan'], interfaces);
  assert.equal(new crypto.X509Certificate(renamed.cert).checkHost('tau.lan'), 'tau.lan');

  const expiring = Date.parse(new crypto.X509Certificate(renamed.cert).validTo) - 86_400_000;
  const renewed = ensureTlsCertificate(dir, ['pc', 'tau.lan'], interfaces, expiring);
  assert.notEqual(renewed.cert, renamed.cert);

  // Devices that trusted the CA keep trusting every reissued certificate.
  assert.equal(fs.readFileSync(first.caFile, 'utf8'), ca);
  assert.ok(new crypto.X509Certificate(renewed.cert).verify(new crypto.X509Certificate(ca).publicKey));
});

test('rejects host names that cannot appear in a certificate', (t) => {
  assert.throws(() => ensureTlsCertificate(tlsDir(t), ['pc,DNS:evil'], interfaces), /Invalid TLS host name/);
});
