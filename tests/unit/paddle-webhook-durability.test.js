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

    throw new Error('Unexpected RPC: ' + name);
  });

  return { rpc, inbox };
}

function payload(eventType, idSuffix = eventType.replace(/\W/g, '_')) {
  return {
    notification_id: 'ntf_' + idSuffix,
    event_type: eventType,
    data: { id: 'data_' + idSuffix }
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

    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_paddle_webhook_event',
      'fail_paddle_webhook_event',
      'claim_paddle_webhook_event',
      'complete_paddle_webhook_event'
    ]);
    const firstClaim = client.rpc.mock.calls[0][1];
    const failedClaim = client.rpc.mock.calls[1][1];
    const replayClaim = client.rpc.mock.calls[2][1];
    const completedClaim = client.rpc.mock.calls[3][1];
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
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_paddle_webhook_event',
      'fail_paddle_webhook_event',
      'claim_paddle_webhook_event',
      'complete_paddle_webhook_event',
      'claim_paddle_webhook_event'
    ]);
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
