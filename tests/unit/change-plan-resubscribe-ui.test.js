'use strict';

const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

describe('canceled-subscription resubscribe UI contract', () => {
  test('취소 상태 전용 UI와 명시적 확인 버튼이 존재해야 한다', () => {
    expect(indexSource).toContain('id="cpStateResubscribe"');
    expect(indexSource).toContain('id="changePlanResubscribeBtn"');
    expect(indexSource).toContain('id="changePlanResubscribeCancelBtn"');
  });

  test('Paddle의 안전한 상태 분류를 통과한 경우에만 재구독 UI를 표시해야 한다', () => {
    expect(appSource).toContain('ChangePlanHelpers.shouldOfferNewSubscription(json.code)');
    expect(appSource).toContain('_cpRenderResubscribe(targetPlan)');
  });

  test('재구독 UI 렌더링만으로 체크아웃을 자동 실행하지 않아야 한다', () => {
    const renderStart = appSource.indexOf('function _cpRenderResubscribe');
    const renderEnd = appSource.indexOf('function _cpRenderReady', renderStart);
    const renderSource = appSource.slice(renderStart, renderEnd);

    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    expect(renderSource).not.toContain('handleCheckout');
  });

  test('사용자가 재구독 버튼을 누른 경우에만 기존 체크아웃을 열어야 한다', () => {
    const handlerStart = appSource.indexOf("changePlanResubscribeBtn?.addEventListener('click'");
    const handlerEnd = appSource.indexOf("changePlanDismissBtn?.addEventListener", handlerStart);
    const handlerSource = appSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource).toContain("['pro', 'enterprise'].includes(targetPlan)");
    expect(handlerSource).toContain('await handleCheckout(targetPlan)');
  });
});
