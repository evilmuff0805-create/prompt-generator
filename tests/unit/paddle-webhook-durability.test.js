'use strict';

const {
  executePaddleWebhook,
  sanitizeWebhookError
} = require('../../routes/paddle');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeDurableInboxClient() {
  const inbox = new Map();
  const watermarks = new Map();

  const rpc = jest.fn(async (name, args) => {
    const eventId = args.p_event_id;
    const row = inbox.get(eventId);

    if (name === 'claim_paddle_webhook_event') {
      if (row?.status === 'completed') {
        return { data: { outcome: 'completed', attemptCount: row.attemptCount }, error: null };
      }
      if (row?.status === 'processing') {
        return { data: { outcome: 'busy', attemptCount: row.attemptCount }, error: null };
      }

      const next = {
        status: 'processing',
        attemptCount: (row?.attemptCount || 0) + 1,
        claimToken: args.p_claim_token,
        lastError: null
      };
      inbox.set(eventId, next);
      return { data: { outcome: 'claimed', attemptCount: next.attemptCount }, error: null };
    }

    if (name === 'complete_paddle_webhook_event') {
      if (!row || row.status !== 'processing' || row.claimToken !== args.p_claim_token) {
        return { data: false, error: null };
      }
      row.status = 'completed';
      row.claimToken = null;
      row.lastError = null;
      return { data: true, error: null };
    }

    if (name === 'fail_paddle_webhook_event') {
      if (!row || row.status !== 'processing' || row.claimToken !== args.p_claim_token) {
        return { data: false, error: null };
      }
      row.status = 'failed';
      row.claimToken = null;
      row.lastError = args.p_error;
      return { data: true, error: null };
    }

    const watermarkKey = `${args.p_entity_type}:${args.p_entity_id}`;
    const watermark = watermarks.get(watermarkKey) || {};

    if (name === 'claim_paddle_event_order') {
      if (watermark.lastEventId === args.p_provider_event_id) {
        return { data: { outcome: 'completed' }, error: null };
      }
      if (
        watermark.lastOccurredAt
        && Date.parse(args.p_occurred_at) < Date.parse(watermark.lastOccurredAt)
      ) {
        return { data: { outcome: 'stale' }, error: null };
      }
      if (
        watermark.lastOccurredAt
        && Date.parse(args.p_occurred_at) === Date.parse(watermark.lastOccurredAt)
      ) {
        return {
          data: {
            outcome: 'ambiguous',
            reconciliationRequired: true,
            lastEventId: watermark.lastEventId,
            lastOccurredAt: watermark.lastOccurredAt
          },
          error: null
        };
      }
      if (watermark.pendingEventId) {
        return {
          data: {
            outcome: 'busy',
            pendingEventId: watermark.pendingEventId,
            pendingClaimedAt: watermark.pendingClaimedAt || '2026-07-28T00:00:00.000Z',
            leaseExpiresAt: watermark.leaseExpiresAt || '2026-07-28T00:05:00.000Z',
            leaseExpired: watermark.leaseExpired === true
          },
          error: null
        };
      }
      watermarks.set(watermarkKey, {
        ...watermark,
        pendingEventId: args.p_provider_event_id,
        pendingEventType: args.p_event_type,
        pendingOccurredAt: args.p_occurred_at,
        claimToken: args.p_claim_token,
        pendingClaimedAt: '2026-07-28T00:00:00.000Z',
        leaseExpiresAt: '2026-07-28T00:05:00.000Z',
        leaseExpired: false
      });
      return { data: { outcome: 'claimed' }, error: null };
    }

    if (name === 'complete_paddle_event_order') {
      if (
        watermark.pendingEventId !== args.p_provider_event_id
        || watermark.claimToken !== args.p_claim_token
      ) {
        return { data: false, error: null };
      }
      watermarks.set(watermarkKey, {
        lastEventId: watermark.pendingEventId,
        lastEventType: watermark.pendingEventType,
        lastOccurredAt: watermark.pendingOccurredAt
      });
      return { data: true, error: null };
    }

    if (name === 'fail_paddle_event_order') {
      if (
        watermark.pendingEventId !== args.p_provider_event_id
        || watermark.claimToken !== args.p_claim_token
      ) {
        return { data: false, error: null };
      }
      watermarks.set(watermarkKey, {
        lastEventId: watermark.lastEventId,
        lastEventType: watermark.lastEventType,
        lastOccurredAt: watermark.lastOccurredAt
      });
      return { data: true, error: null };
    }

    throw new Error('Unexpected RPC: ' + name);
  });

  return { rpc, inbox, watermarks };
}

function payload(eventType, idSuffix = eventType.replace(/\W/g, '_')) {
  let data;
  if (eventType.startsWith('subscription.')) {
    data = { id: 'sub_' + idSuffix };
  } else if (eventType.startsWith('adjustment.')) {
    data = { id: 'adj_' + idSuffix };
  } else {
    data = { id: 'txn_' + idSuffix, subscription_id: 'sub_' + idSuffix };
  }
  return {
    notification_id: 'ntf_' + idSuffix,
    event_id: 'evt_' + idSuffix,
    event_type: eventType,
    occurred_at: '2026-07-28T00:00:00.000Z',
    data
  };
}

describe('durable Paddle webhook inbox', () => {
  const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });

  beforeEach(() => {
    incidentReporter.mockClear();
  });

  test('동시 중복 전달은 한 claim만 business mutation을 수행해야 한다', async () => {
    const client = makeDurableInboxClient();
    const enteredProcessor = deferred();
    const releaseProcessor = deferred();
    let mutationCount = 0;
    const event = payload('transaction.completed', 'concurrent');

    const first = executePaddleWebhook({
      payload: event,
      requestId: 'req-1',
      supabase: client,
      incidentReporter,
      processEvent: async () => {
        enteredProcessor.resolve();
        await releaseProcessor.promise;
        mutationCount += 1;
      }
    });

    await enteredProcessor.promise;
    const secondProcessor = jest.fn();
    const second = await executePaddleWebhook({
      payload: event,
      requestId: 'req-2',
      supabase: client,
      incidentReporter,
      processEvent: secondProcessor
    });

    expect(second).toMatchObject({ statusCode: 503, outcome: 'busy', retryAfter: '5' });
    expect(secondProcessor).not.toHaveBeenCalled();

    releaseProcessor.resolve();
    await expect(first).resolves.toMatchObject({ statusCode: 200, outcome: 'completed' });
    expect(mutationCount).toBe(1);
  });

  test.each([
    'transaction.completed',
    'subscription.updated',
    'subscription.canceled',
    'adjustment.created'
  ])('%s: 실패 후 재전송은 복구되고 완료 뒤 재전송만 duplicate 200이다', async (eventType) => {
    const client = makeDurableInboxClient();
    const event = payload(eventType);
    let mutationCount = 0;
    const processor = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary\nDB failure'), { code: 'DB_TEMPORARY' }))
      .mockImplementationOnce(async () => { mutationCount += 1; });

    const first = await executePaddleWebhook({
      payload: event,
      requestId: 'req-first',
      supabase: client,
      incidentReporter,
      processEvent: processor
    });
    expect(first).toMatchObject({ statusCode: 500, outcome: 'failed' });
    expect(client.inbox.get(event.notification_id)).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastError: 'DB_TEMPORARY: temporary DB failure'
    });

    const replay = await executePaddleWebhook({
      payload: event,
      requestId: 'req-replay',
      supabase: client,
      incidentReporter,
      processEvent: processor
    });
    expect(replay).toMatchObject({ statusCode: 200, outcome: 'completed' });
    expect(client.inbox.get(event.notification_id)).toMatchObject({ status: 'completed', attemptCount: 2 });
    expect(mutationCount).toBe(1);
    expect(processor).toHaveBeenCalledTimes(2);

    const usesImmutableOrdering = !eventType.startsWith('subscription.');
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(
      usesImmutableOrdering
        ? [
          'claim_paddle_webhook_event',
          'claim_paddle_event_order',
          'fail_paddle_event_order',
          'fail_paddle_webhook_event',
          'claim_paddle_webhook_event',
          'claim_paddle_event_order',
          'complete_paddle_event_order',
          'complete_paddle_webhook_event'
        ]
        : [
          'claim_paddle_webhook_event',
          'fail_paddle_webhook_event',
          'claim_paddle_webhook_event',
          'complete_paddle_webhook_event'
        ]
    );
    const firstClaim = client.rpc.mock.calls[0][1];
    const failedClaim = client.rpc.mock.calls[usesImmutableOrdering ? 3 : 1][1];
    const replayClaim = client.rpc.mock.calls[usesImmutableOrdering ? 4 : 2][1];
    const completedClaim = client.rpc.mock.calls[usesImmutableOrdering ? 7 : 3][1];
    expect(firstClaim.p_event_id).toBe(event.notification_id);
    expect(failedClaim).toMatchObject({
      p_event_id: event.notification_id,
      p_claim_token: firstClaim.p_claim_token,
      p_error: 'DB_TEMPORARY: temporary DB failure'
    });
    expect(replayClaim.p_event_id).toBe(event.notification_id);
    expect(replayClaim.p_claim_token).not.toBe(firstClaim.p_claim_token);
    expect(completedClaim).toEqual({
      p_event_id: event.notification_id,
      p_claim_token: replayClaim.p_claim_token
    });
    expect(incidentReporter).toHaveBeenCalledTimes(1);
    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'PADDLE_EVENT_PROCESSING_FAILED',
      fingerprint: `paddle-webhook:PADDLE_EVENT_PROCESSING_FAILED:${event.notification_id}`,
      context: expect.objectContaining({
        eventId: event.notification_id,
        eventType
      })
    }));

    const completedDuplicateProcessor = jest.fn();
    const completedDuplicate = await executePaddleWebhook({
      payload: event,
      requestId: 'req-duplicate',
      supabase: client,
      incidentReporter,
      processEvent: completedDuplicateProcessor
    });
    expect(completedDuplicate).toMatchObject({ statusCode: 200, outcome: 'duplicate' });
    expect(completedDuplicateProcessor).not.toHaveBeenCalled();
    expect(processor).toHaveBeenCalledTimes(2);
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(
      usesImmutableOrdering
        ? [
          'claim_paddle_webhook_event',
          'claim_paddle_event_order',
          'fail_paddle_event_order',
          'fail_paddle_webhook_event',
          'claim_paddle_webhook_event',
          'claim_paddle_event_order',
          'complete_paddle_event_order',
          'complete_paddle_webhook_event',
          'claim_paddle_webhook_event'
        ]
        : [
          'claim_paddle_webhook_event',
          'fail_paddle_webhook_event',
          'claim_paddle_webhook_event',
          'complete_paddle_webhook_event',
          'claim_paddle_webhook_event'
        ]
    );
  });

  test('transaction이 먼저 완료돼도 더 오래된 subscription snapshot을 generic stale로 버리지 않는다', async () => {
    const client = makeDurableInboxClient();
    const transaction = {
      notification_id: 'ntf_transaction_newer',
      event_id: 'evt_transaction_newer',
      event_type: 'transaction.completed',
      occurred_at: '2026-07-28T10:00:00.000Z',
      data: { id: 'txn_shared', subscription_id: 'sub_shared' }
    };
    const lateSnapshot = {
      notification_id: 'ntf_update_older',
      event_id: 'evt_update_older',
      event_type: 'subscription.updated',
      occurred_at: '2026-07-28T09:00:00.000Z',
      data: { id: 'sub_shared' }
    };
    const transactionProcessor = jest.fn().mockResolvedValue(undefined);
    const snapshotProcessor = jest.fn().mockResolvedValue(undefined);

    await expect(executePaddleWebhook({
      payload: transaction,
      requestId: 'req-transaction',
      supabase: client,
      incidentReporter,
      processEvent: transactionProcessor
    })).resolves.toMatchObject({ statusCode: 200, outcome: 'completed' });

    await expect(executePaddleWebhook({
      payload: lateSnapshot,
      requestId: 'req-late-snapshot',
      supabase: client,
      incidentReporter,
      processEvent: snapshotProcessor
    })).resolves.toMatchObject({ statusCode: 200, outcome: 'completed' });

    expect(transactionProcessor).toHaveBeenCalledTimes(1);
    expect(snapshotProcessor).toHaveBeenCalledTimes(1);
    expect(client.watermarks.has('transaction:txn_shared')).toBe(true);
    expect(client.watermarks.has('subscription:sub_shared')).toBe(false);
  });

  test('같은 immutable entity timestamp의 다른 이벤트는 ambiguous 503과 critical incident로 중단한다', async () => {
    const client = makeDurableInboxClient();
    const first = {
      notification_id: 'ntf_ambiguous_first',
      event_id: 'evt_ambiguous_first',
      event_type: 'transaction.completed',
      occurred_at: '2026-07-28T11:00:00.123456Z',
      data: { id: 'txn_ambiguous', subscription_id: 'sub_ambiguous' }
    };
    const second = {
      ...first,
      notification_id: 'ntf_ambiguous_second',
      event_id: 'evt_ambiguous_second'
    };

    await expect(executePaddleWebhook({
      payload: first,
      requestId: 'req-ambiguous-first',
      supabase: client,
      incidentReporter,
      processEvent: jest.fn().mockResolvedValue(undefined)
    })).resolves.toMatchObject({ statusCode: 200, outcome: 'completed' });

    const secondProcessor = jest.fn();
    await expect(executePaddleWebhook({
      payload: second,
      requestId: 'req-ambiguous-second',
      supabase: client,
      incidentReporter,
      processEvent: secondProcessor
    })).resolves.toMatchObject({
      statusCode: 503,
      outcome: 'order_ambiguous',
      retryAfter: '30'
    });

    expect(secondProcessor).not.toHaveBeenCalled();
    expect(client.inbox.get(second.notification_id)).toMatchObject({ status: 'failed' });
    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'PADDLE_EVENT_ORDER_AMBIGUOUS',
      context: expect.objectContaining({
        entityType: 'transaction',
        entityId: 'txn_ambiguous',
        lastEventId: 'evt_ambiguous_first',
        reconciliationRequired: true
      })
    }));
  });

  test('만료된 entity lease는 자동 탈취하지 않고 operator reconciliation incident로 중단한다', async () => {
    const client = makeDurableInboxClient();
    client.watermarks.set('transaction:txn_expired_lease', {
      pendingEventId: 'evt_previous_worker',
      pendingOccurredAt: '2026-07-28T11:30:00.000Z',
      pendingClaimedAt: '2026-07-28T11:30:01.000Z',
      leaseExpiresAt: '2026-07-28T11:35:01.000Z',
      leaseExpired: true,
      claimToken: 'claim_previous_worker'
    });
    const event = {
      notification_id: 'ntf_expired_lease',
      event_id: 'evt_expired_lease',
      event_type: 'transaction.completed',
      occurred_at: '2026-07-28T12:00:00.000Z',
      data: { id: 'txn_expired_lease', subscription_id: 'sub_expired_lease' }
    };
    const processEvent = jest.fn();

    await expect(executePaddleWebhook({
      payload: event,
      requestId: 'req-expired-lease',
      supabase: client,
      incidentReporter,
      processEvent
    })).resolves.toMatchObject({
      statusCode: 503,
      outcome: 'order_lease_expired',
      retryAfter: '30'
    });

    expect(processEvent).not.toHaveBeenCalled();
    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'PADDLE_EVENT_ORDER_LEASE_EXPIRED',
      context: expect.objectContaining({
        entityType: 'transaction',
        entityId: 'txn_expired_lease',
        pendingEventId: 'evt_previous_worker',
        pendingClaimedAt: '2026-07-28T11:30:01.000Z',
        leaseExpiresAt: '2026-07-28T11:35:01.000Z',
        leaseExpired: true
      })
    }));
  });

  test('같은 Paddle event_id가 다른 notification_id로 재전송돼도 business 처리는 한 번뿐이다', async () => {
    const client = makeDurableInboxClient();
    const first = payload('transaction.completed', 'semantic_duplicate');
    const second = {
      ...first,
      notification_id: 'ntf_semantic_duplicate_redelivery'
    };
    const processor = jest.fn().mockResolvedValue(undefined);

    await expect(executePaddleWebhook({
      payload: first,
      requestId: 'req-semantic-first',
      supabase: client,
      incidentReporter,
      processEvent: processor
    })).resolves.toMatchObject({ statusCode: 200, outcome: 'completed' });

    await expect(executePaddleWebhook({
      payload: second,
      requestId: 'req-semantic-second',
      supabase: client,
      incidentReporter,
      processEvent: processor
    })).resolves.toMatchObject({ statusCode: 200, outcome: 'semantic_duplicate' });

    expect(processor).toHaveBeenCalledTimes(1);
  });

  test('notification_id가 없으면 claim이나 business 처리를 시작하지 않는다', async () => {
    const client = makeDurableInboxClient();
    const processEvent = jest.fn();
    const result = await executePaddleWebhook({
      payload: { event_type: 'transaction.completed', data: { id: 'txn_fallback_is_not_safe' } },
      requestId: 'req-invalid',
      supabase: client,
      incidentReporter,
      processEvent
    });

    expect(result).toMatchObject({ statusCode: 400, outcome: 'invalid' });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  test('저장되는 오류는 단일 행·제한 길이 문자열로 정규화한다', () => {
    const error = Object.assign(new Error('line 1\nline 2\t' + 'x'.repeat(1000)), {
      code: 'DB TEMP/ERROR'
    });
    const sanitized = sanitizeWebhookError(error);

    expect(sanitized).toMatch(/^DB_TEMP_ERROR: line 1 line 2 /);
    expect(sanitized).not.toMatch(/[\r\n\t]/);
    expect(sanitized.length).toBeLessThanOrEqual(883);
    expect(sanitized).not.toContain('Error:');
  });
});
