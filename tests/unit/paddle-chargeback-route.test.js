'use strict';

const crypto = require('crypto');
const http = require('http');
const express = require('express');

const mockCreateClient = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => mockCreateClient(...args)
}));

const originalEnvironment = {
  CREDIT_LEDGER_V2_ENABLED: process.env.CREDIT_LEDGER_V2_ENABLED,
  OPS_ALERT_WEBHOOK_URL: process.env.OPS_ALERT_WEBHOOK_URL,
  PADDLE_API_BASE: process.env.PADDLE_API_BASE,
  PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL
};

process.env.PADDLE_API_BASE = 'https://api.paddle.com';

const paddleRouter = require('../../routes/paddle');

function restoreEnvironment() {
  Object.entries(originalEnvironment).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

function buildSignatureHeader(secret, rawBody, timestamp) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');
  return `ts=${timestamp};h1=${signature}`;
}

function startServer() {
  const app = express();
  app.use('/api/paddle', paddleRouter);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function postSignedWebhook(server, rawBody, signature) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/paddle/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(rawBody),
        'paddle-signature': signature
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end(rawBody);
  });
}

describe('Paddle chargeback webhook route durability', () => {
  const webhookSecret = 'route-level-chargeback-secret';
  let adminClient;

  beforeEach(() => {
    process.env.CREDIT_LEDGER_V2_ENABLED = 'false';
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    process.env.PADDLE_WEBHOOK_SECRET = webhookSecret;
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

    adminClient = {
      from: jest.fn(),
      rpc: jest.fn().mockImplementation(async name => {
        if (name === 'claim_paddle_webhook_event') {
          return { data: { outcome: 'claimed' }, error: null };
        }
        if (name === 'claim_paddle_event_order') {
          return { data: { outcome: 'claimed' }, error: null };
        }
        if (name === 'record_ops_incident') {
          return {
            data: null,
            error: { message: 'simulated incident upsert failure' }
          };
        }
        if (name === 'fail_paddle_event_order' || name === 'fail_paddle_webhook_event') {
          return { data: true, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      })
    };
    mockCreateClient.mockReset().mockReturnValue(adminClient);
  });

  afterAll(restoreEnvironment);

  test('signed non-credit-pack chargeback retries when its critical incident cannot be persisted', async () => {
    const payload = {
      notification_id: 'ntf_chargeback_route_failure',
      event_id: 'evt_chargeback_route_failure',
      event_type: 'adjustment.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'adj_chargeback_route_failure',
        transaction_id: 'txn_subscription_chargeback',
        subscription_id: 'sub_chargeback_route_failure',
        customer_id: 'ctm_chargeback_route_failure',
        action: 'chargeback',
        status: 'approved',
        type: 'full'
      }
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildSignatureHeader(webhookSecret, rawBody, timestamp);
    const server = await startServer();

    let response;
    try {
      response = await postSignedWebhook(server, rawBody, signature);
    } finally {
      await stopServer(server);
    }

    expect(response).toMatchObject({
      statusCode: 500,
      body: 'Internal error'
    });

    const rpcNames = adminClient.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames).toEqual([
      'claim_paddle_webhook_event',
      'claim_paddle_event_order',
      'record_ops_incident',
      'fail_paddle_event_order',
      'fail_paddle_webhook_event',
      'record_ops_incident'
    ]);
    expect(adminClient.rpc).toHaveBeenCalledWith(
      'fail_paddle_webhook_event',
      expect.objectContaining({
        p_event_id: payload.notification_id,
        p_error: expect.stringContaining(
          'NON_CREDIT_PACK_CHARGEBACK_INCIDENT_PERSIST_FAILED'
        )
      })
    );
    expect(rpcNames).not.toContain('complete_paddle_webhook_event');
    expect(rpcNames).not.toContain('complete_paddle_event_order');
    expect(rpcNames).not.toContain('apply_credit_pack_adjustment_v2');
    expect(rpcNames).not.toContain('apply_purchase_refund');
    expect(rpcNames).not.toContain('apply_ordered_subscription_payment');
    expect(rpcNames).not.toContain('apply_plan_change');
    expect(rpcNames).not.toContain('expire_subscription_credits');
    expect(adminClient.from).not.toHaveBeenCalled();
  });
});
