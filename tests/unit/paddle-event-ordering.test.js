const fs = require('fs');
const path = require('path');

const {
  getPaddleOrderingTarget,
  parsePaddleOccurredAt
} = require('../../routes/paddle');

describe('Paddle semantic event ordering', () => {
  test.each([
    [
      {
        event_type: 'subscription.updated',
        data: { id: 'sub_1' }
      },
      null
    ],
    [
      {
        event_type: 'subscription.canceled',
        data: { id: 'sub_1' }
      },
      null
    ],
    [
      {
        event_type: 'transaction.completed',
        data: { id: 'txn_1', subscription_id: 'sub_1' }
      },
      { entityType: 'transaction', entityId: 'txn_1' }
    ],
    [
      {
        event_type: 'transaction.completed',
        data: {
          id: 'txn_pack_1',
          custom_data: { promptgenKind: 'credit_pack' }
        }
      },
      { entityType: 'transaction', entityId: 'txn_pack_1' }
    ],
    [
      {
        event_type: 'adjustment.updated',
        data: { id: 'adj_1', transaction_id: 'txn_1' }
      },
      { entityType: 'adjustment', entityId: 'adj_1' }
    ]
  ])('derives a stable ordering target', (payload, expected) => {
    expect(getPaddleOrderingTarget(payload)).toEqual(expected);
  });

  test('subscription snapshots and unhandled events do not use the immutable-edge watermark', () => {
    expect(getPaddleOrderingTarget({
      event_type: 'subscription.updated',
      data: { id: 'sub_reducer_1' }
    })).toBeNull();
    expect(getPaddleOrderingTarget({
      event_type: 'subscription.canceled',
      data: { id: 'sub_reducer_1' }
    })).toBeNull();
    expect(getPaddleOrderingTarget({
      event_type: 'customer.updated',
      data: { id: 'ctm_1' }
    })).toBeNull();
  });

  test('occurred_at must be a bounded valid timestamp', () => {
    expect(parsePaddleOccurredAt('2026-07-28T01:02:03.456Z'))
      .toBe('2026-07-28T01:02:03.456Z');
    expect(parsePaddleOccurredAt('not-a-date')).toBeNull();
    expect(parsePaddleOccurredAt('')).toBeNull();
    expect(parsePaddleOccurredAt('x'.repeat(81))).toBeNull();
  });

  test('preserves Paddle microseconds so distinct events do not collapse to one millisecond', () => {
    expect(parsePaddleOccurredAt('2026-07-28T01:02:03.155553Z'))
      .toBe('2026-07-28T01:02:03.155553Z');
    expect(parsePaddleOccurredAt('2026-07-28T01:02:03.155999Z'))
      .toBe('2026-07-28T01:02:03.155999Z');
  });

  test('ordering migration is service-role only and exposes claim/complete/fail RPCs', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../migrations/025_paddle_event_ordering.sql'),
      'utf8'
    );

    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('CREATE TABLE public.paddle_event_watermarks');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.claim_paddle_event_order');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.complete_paddle_event_order');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fail_paddle_event_order');
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.paddle_event_watermarks[\s\S]{0,80}FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(
      /GRANT SELECT ON TABLE public\.paddle_event_watermarks TO service_role;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_paddle_event_order\([\s\S]*?\) TO service_role;/
    );
    expect(sql).toContain('p_occurred_at < v_row.last_occurred_at');
    expect(sql).toContain("'outcome', 'ambiguous'");
    expect(sql).toContain("'leaseExpired', v_row.pending_lease_expires_at <= v_now");
  });
});
