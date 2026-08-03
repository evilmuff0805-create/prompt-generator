'use strict';

const fs = require('fs');
const path = require('path');
const {
  applyPaddleSubscriptionSnapshot,
  grantCreditsForPurchase
} = require('../../routes/paddle');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const PAYMENT_OCCURRED_AT = '2026-07-28T12:34:56.123456Z';

describe('Paddle subscription route reducer contract', () => {
  const originalTestAccounts = process.env.TEST_ACCOUNT_USER_IDS;

  afterEach(() => {
    if (originalTestAccounts === undefined) {
      delete process.env.TEST_ACCOUNT_USER_IDS;
    } else {
      process.env.TEST_ACCOUNT_USER_IDS = originalTestAccounts;
    }
  });

  test('recurring webhook never rewrites the profile subscription binding after the ordered RPC', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../routes/paddle.js'),
      'utf8'
    );
    expect(source).toContain('await grantCreditsForPurchase(');
    expect(source).not.toContain('async function saveSubscriptionIds(');
    expect(source).not.toContain('async function syncPlanFromSubscription(');
  });

  test('subscription lifecycle mutations are reachable only through ordered RPCs', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../routes/paddle.js'),
      'utf8'
    );

    expect(source).toMatch(/\.rpc\(\s*['"]apply_paddle_subscription_snapshot['"]/);
    expect(source).not.toMatch(/\.rpc\(\s*['"]apply_plan_change['"]/);
    expect(source).not.toMatch(/\.rpc\(\s*['"]expire_subscription_credits['"]/);
  });

  test('subscription payment uses the ordered lifecycle RPC and requires provider IDs', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { applied: false, reason: 'duplicate', terminal: false },
        error: null
      })
    };

    await grantCreditsForPurchase(
      client,
      'txn_ordered_1',
      USER_ID,
      'pro',
      'sub_ordered_1',
      'ctm_ordered_1',
      { occurredAt: PAYMENT_OCCURRED_AT }
    );

    expect(client.rpc).toHaveBeenCalledWith('apply_ordered_subscription_payment', {
      p_transaction_id: 'txn_ordered_1',
      p_user_id: USER_ID,
      p_plan: 'pro',
      p_amount: 600,
      p_subscription_id: 'sub_ordered_1',
      p_customer_id: 'ctm_ordered_1',
      p_occurred_at: PAYMENT_OCCURRED_AT,
      p_skip_entitlement_mutation: false
    });
  });

  test('terminal subscription payment records the ledger edge but withholds entitlement and raises a critical incident', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'terminal_subscription',
          terminal: true,
          entitlementGranted: false
        },
        error: null
      })
    };

    await expect(grantCreditsForPurchase(
      client,
      'txn_terminal_1',
      USER_ID,
      'enterprise',
      'sub_terminal_1',
      'ctm_terminal_1',
      {
        incidentReporter,
        requestId: 'req-terminal',
        notificationId: 'ntf-terminal',
        occurredAt: PAYMENT_OCCURRED_AT
      }
    )).resolves.toMatchObject({
      reason: 'terminal_subscription',
      entitlementGranted: false
    });

    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD',
      fingerprint: 'paddle-webhook:TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD:txn_terminal_1',
      context: expect.objectContaining({
        transactionId: 'txn_terminal_1',
        subscriptionId: 'sub_terminal_1',
        ledgerRecorded: true,
        entitlementGranted: false
      })
    }));
  });

  test('superseded subscription payment is recorded without changing current entitlement and raises an incident', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'superseded_subscription',
          terminal: false,
          entitlementGranted: false
        },
        error: null
      })
    };

    await expect(grantCreditsForPurchase(
      client,
      'txn_superseded_1',
      USER_ID,
      'pro',
      'sub_old_1',
      'ctm_current_1',
      {
        incidentReporter,
        requestId: 'req-superseded',
        notificationId: 'ntf-superseded',
        occurredAt: PAYMENT_OCCURRED_AT
      }
    )).resolves.toMatchObject({
      reason: 'superseded_subscription',
      entitlementGranted: false
    });

    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'SUPERSEDED_SUBSCRIPTION_PAYMENT_WITHHELD',
      fingerprint:
        'paddle-webhook:SUPERSEDED_SUBSCRIPTION_PAYMENT_WITHHELD:txn_superseded_1',
      context: expect.objectContaining({
        transactionId: 'txn_superseded_1',
        subscriptionId: 'sub_old_1',
        ledgerRecorded: true,
        entitlementGranted: false
      })
    }));
  });

  test.each([
    ['stale_payment', 'STALE_SUBSCRIPTION_PAYMENT_WITHHELD'],
    ['ambiguous_payment_order', 'AMBIGUOUS_SUBSCRIPTION_PAYMENT_WITHHELD']
  ])('%s is recorded without resetting credits and raises an incident', async (
    reason,
    eventCode
  ) => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason,
          terminal: false,
          entitlementGranted: false
        },
        error: null
      })
    };

    await expect(grantCreditsForPurchase(
      client,
      `txn_${reason}`,
      USER_ID,
      'pro',
      'sub_ordered_1',
      'ctm_ordered_1',
      {
        incidentReporter,
        requestId: 'req-order',
        notificationId: 'ntf-order',
        occurredAt: PAYMENT_OCCURRED_AT
      }
    )).resolves.toMatchObject({
      reason,
      entitlementGranted: false
    });

    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode,
      context: expect.objectContaining({
        occurredAt: PAYMENT_OCCURRED_AT,
        ledgerRecorded: true,
        entitlementGranted: false
      })
    }));
  });

  test.each([
    ['subscription.updated', 'subscription_canceled'],
    ['subscription.canceled', 'subscription_canceled']
  ])('%s status=canceled always goes through the terminal snapshot reducer', async (eventType, reason) => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason,
          terminal: true,
          lifecycleStatus: 'canceled'
        },
        error: null
      })
    };

    await applyPaddleSubscriptionSnapshot(client, {
      subscriptionId: 'sub_cancel_1',
      userId: USER_ID,
      customerId: 'ctm_cancel_1',
      status: 'canceled',
      plan: null,
      providerEventId: 'evt_cancel_1',
      eventType,
      occurredAt: '2026-07-28T12:34:56.123456Z'
    });

    expect(client.rpc).toHaveBeenCalledWith('apply_paddle_subscription_snapshot', {
      p_subscription_id: 'sub_cancel_1',
      p_user_id: USER_ID,
      p_customer_id: 'ctm_cancel_1',
      p_status: 'canceled',
      p_plan: null,
      p_allotment: 0,
      p_provider_event_id: 'evt_cancel_1',
      p_event_type: eventType,
      p_occurred_at: '2026-07-28T12:34:56.123456Z',
      p_skip_entitlement_mutation: false
    });
  });

  test('a superseded cancellation is accepted as recorded without expiring current entitlement', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'cancellation_recorded_superseded_subscription',
          terminal: true,
          lifecycleStatus: 'canceled',
          entitlementResult: {
            applied: false,
            reason: 'superseded_subscription'
          }
        },
        error: null
      })
    };

    await expect(applyPaddleSubscriptionSnapshot(client, {
      subscriptionId: 'sub_old_1',
      userId: USER_ID,
      customerId: 'ctm_current_1',
      status: 'canceled',
      plan: null,
      providerEventId: 'evt_old_cancel_1',
      eventType: 'subscription.canceled',
      occurredAt: '2026-07-28T12:34:56.123456Z'
    })).resolves.toMatchObject({
      reason: 'cancellation_recorded_superseded_subscription'
    });
  });

  test('equal-time conflicting snapshots are retained for reconciliation without retrying forever', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: false,
          reason: 'reconciliation_required',
          terminal: false,
          lifecycleStatus: 'active'
        },
        error: null
      })
    };

    await expect(applyPaddleSubscriptionSnapshot(client, {
      subscriptionId: 'sub_equal_time_1',
      userId: USER_ID,
      customerId: 'ctm_equal_time_1',
      status: 'active',
      plan: 'pro',
      providerEventId: 'evt_equal_time_conflict_1',
      eventType: 'subscription.updated',
      occurredAt: '2026-07-28T12:34:56.123456Z'
    }, {
      incidentReporter,
      requestId: 'req-equal-time',
      notificationId: 'ntf-equal-time'
    })).resolves.toMatchObject({
      reason: 'reconciliation_required'
    });

    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'SUBSCRIPTION_SNAPSHOT_RECONCILIATION_REQUIRED',
      context: expect.objectContaining({
        subscriptionId: 'sub_equal_time_1',
        providerEventId: 'evt_equal_time_conflict_1',
        occurredAt: '2026-07-28T12:34:56.123456Z'
      })
    }));
  });

  test('active snapshot maps the plan allotment while preserving occurred_at microseconds', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'subscription_entitlement_applied',
          terminal: false,
          lifecycleStatus: 'active'
        },
        error: null
      })
    };

    await applyPaddleSubscriptionSnapshot(client, {
      subscriptionId: 'sub_active_1',
      userId: USER_ID,
      customerId: 'ctm_active_1',
      status: 'active',
      plan: 'enterprise',
      providerEventId: 'evt_active_1',
      eventType: 'subscription.updated',
      occurredAt: '2026-07-28T12:34:56.987654Z'
    });

    expect(client.rpc).toHaveBeenCalledWith(
      'apply_paddle_subscription_snapshot',
      expect.objectContaining({
        p_status: 'active',
        p_plan: 'enterprise',
        p_allotment: 1500,
        p_occurred_at: '2026-07-28T12:34:56.987654Z'
      })
    );
  });

  test('test accounts still record snapshots but explicitly skip entitlement mutation', async () => {
    process.env.TEST_ACCOUNT_USER_IDS = USER_ID;
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'snapshot_recorded_entitlement_skipped',
          terminal: false
        },
        error: null
      })
    };

    await applyPaddleSubscriptionSnapshot(client, {
      subscriptionId: 'sub_test_1',
      userId: USER_ID,
      customerId: 'ctm_test_1',
      status: 'trialing',
      plan: 'pro',
      providerEventId: 'evt_test_1',
      eventType: 'subscription.updated',
      occurredAt: '2026-07-28T12:34:56.000001Z'
    });

    expect(client.rpc).toHaveBeenCalledWith(
      'apply_paddle_subscription_snapshot',
      expect.objectContaining({ p_skip_entitlement_mutation: true })
    );
  });
});
