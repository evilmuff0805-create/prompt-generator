'use strict';

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const SEVERITY_RANK = { info: 10, warn: 20, error: 30, critical: 40 };

let adminClient;
let fetchImpl = (...args) => fetch(...args);

function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return adminClient;
}

function normalizeSeverity(value) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value) ? value : 'error';
}

function fingerprintFor(source, eventCode, key) {
  return [source, eventCode, key || 'global']
    .map((part) => String(part || 'unknown').replace(/\s+/g, '_').slice(0, 180))
    .join(':')
    .slice(0, 500);
}

function shouldNotify(severity, occurrenceCount) {
  const minimum = normalizeSeverity(process.env.OPS_ALERT_MIN_SEVERITY || 'critical');
  const repeat = process.env.OPS_ALERT_REPEAT === 'true';
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum]
    && (repeat || occurrenceCount <= 1);
}

function webhookBody(format, incident) {
  const severity = normalizeSeverity(incident?.severity);
  const eventCode = String(incident?.eventCode || 'UNKNOWN_INCIDENT').slice(0, 160);
  const text = `[${severity.toUpperCase()}] ${eventCode}`;
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text.slice(0, 1900) };
  return { severity, eventCode };
}

async function sendWebhook(incident) {
  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!url) return false;

  const format = (process.env.OPS_ALERT_WEBHOOK_FORMAT || 'generic').toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(format, incident)),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`alert webhook returned HTTP ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function reportIncident(input) {
  const severity = normalizeSeverity(input?.severity);
  const source = String(input?.source || 'application').slice(0, 120);
  const eventCode = String(input?.eventCode || 'UNKNOWN_INCIDENT').slice(0, 160);
  const message = String(input?.message || 'Unknown incident').slice(0, 4000);
  const context = logger.sanitize(input?.context || {});
  const fingerprint = String(
    input?.fingerprint || fingerprintFor(source, eventCode, input?.key)
  ).slice(0, 500);

  logger.write(severity, 'ops.incident.reported', {
    source,
    eventCode,
    message,
    fingerprint,
    context
  });

  let persisted = false;
  let occurrenceCount = 1;
  let incidentId = null;

  try {
    const { data, error } = await getAdminClient().rpc('record_ops_incident', {
      p_fingerprint: fingerprint,
      p_source: source,
      p_event_code: eventCode,
      p_severity: severity,
      p_message: message,
      p_context: context
    });
    if (error) throw error;

    persisted = true;
    incidentId = data?.id ?? null;
    occurrenceCount = Number(data?.occurrenceCount || 1);
  } catch (error) {
    logger.error('ops.incident.persist_failed', {
      source,
      eventCode,
      fingerprint,
      error
    });
  }

  let notified = false;
  if (process.env.OPS_ALERT_WEBHOOK_URL && shouldNotify(severity, occurrenceCount)) {
    try {
      notified = await sendWebhook({
        id: incidentId,
        severity,
        source,
        eventCode,
        message,
        fingerprint,
        context,
        occurrenceCount,
        occurredAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error('ops.alert_webhook.failed', {
        source,
        eventCode,
        fingerprint,
        error
      });
    }
  }

  return { persisted, notified, incidentId, occurrenceCount, fingerprint };
}

async function resolveIncident(inputFingerprint) {
  const fingerprint = String(inputFingerprint || '').trim().slice(0, 500);
  if (!fingerprint) {
    logger.error('ops.incident.resolve_invalid', { reason: 'missing_fingerprint' });
    return { checked: false, resolved: false, fingerprint };
  }

  try {
    const { data, error } = await getAdminClient().rpc('resolve_ops_incident', {
      p_fingerprint: fingerprint
    });
    if (error) throw error;

    const resolved = data === true;
    if (resolved) {
      logger.info('ops.incident.resolved', { fingerprint });
    }
    return { checked: true, resolved, fingerprint };
  } catch (error) {
    logger.error('ops.incident.resolve_failed', { fingerprint, error });
    return { checked: false, resolved: false, fingerprint };
  }
}

function _setAdminClientForTests(client) {
  adminClient = client;
}

function _setFetchForTests(nextFetch) {
  fetchImpl = nextFetch;
}

module.exports = {
  reportIncident,
  resolveIncident,
  fingerprintFor,
  normalizeSeverity,
  shouldNotify,
  webhookBody,
  _setAdminClientForTests,
  _setFetchForTests
};
