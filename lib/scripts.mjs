import { readFileSync } from 'node:fs';

const helper = readFileSync(new URL('./remote-files.ps1', import.meta.url), 'utf8');
const operations = new Set(['status', 'read', 'readlines', 'write', 'replace', 'stat', 'upload', 'download']);

/** Build a fixed PowerShell program. Every caller-controlled value is base64 JSON data. */
export function buildOperation(operation, args = {}) {
  if (!operations.has(operation)) throw new TypeError('Unsupported operation: ' + operation);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('args must be an object');
  const seen = new Set();
  function validate(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Arguments must be finite JSON data');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Arguments must be plain JSON data');
    seen.add(value);
    for (const child of Object.values(value)) validate(child);
    seen.delete(value);
  }
  validate(args);
  const data = Buffer.from(JSON.stringify({ operation, args }), 'utf8').toString('base64');
  return "$requestBase64 = '" + data + "'" + String.fromCharCode(10) + helper;
}
