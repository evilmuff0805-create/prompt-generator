'use strict';

const { randomUUID } = require('crypto');

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[-_]?key|signature|rawbody)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4000;

let sink = (level, line) => {
  if (level === 'error' || level === 'critical') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

function sanitize(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(String(key))) return REDACTED;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message, 'message', depth + 1, seen),
      code: value.code,
      status: value.status
    };
  }

  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, '', depth + 1, seen));
  }

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = sanitize(childValue, childKey, depth + 1, seen);
  }
  return output;
}

function write(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: process.env.SERVICE_NAME || 'promptgen-api',
    environment: process.env.NODE_ENV || 'development',
    ...sanitize(fields)
  };

  sink(level, JSON.stringify(record));
  return record;
}

function createRequestId(candidate) {
  const value = String(candidate || '').trim();
  if (/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) return value;
  return randomUUID();
}

function _setSinkForTests(nextSink) {
  sink = nextSink || sink;
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  critical: (event, fields) => write('critical', event, fields),
  write,
  sanitize,
  createRequestId,
  _setSinkForTests,
  REDACTED
};
