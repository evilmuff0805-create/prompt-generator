(function () {
  'use strict';

  const operatorDetails = Object.freeze({
    businessName: 'codemeet',
    representative: 'yerim suk',
    registrationNumber: '470-32-01835',
    customerInquiries: 'codemeet@naver.com'
  });

  const operatorLabels = Object.freeze({
    ko: Object.freeze({
      heading: '서비스 운영자 정보',
      businessName: '사업자',
      representative: '대표자',
      registrationNumber: '사업자등록번호',
      customerInquiries: '고객문의'
    }),
    ja: Object.freeze({
      heading: 'サービス運営者情報',
      businessName: '事業者',
      representative: '代表者',
      registrationNumber: '事業者登録番号',
      customerInquiries: 'お問い合わせ'
    }),
    'zh-CN': Object.freeze({
      heading: '服务运营方信息',
      businessName: '经营者',
      representative: '代表人',
      registrationNumber: '企业登记号',
      customerInquiries: '客户咨询'
    }),
    fr: Object.freeze({
      heading: 'Informations sur l’exploitant du service',
      businessName: 'Nom commercial',
      representative: 'Représentant',
      registrationNumber: 'Numéro d’immatriculation de l’entreprise',
      customerInquiries: 'Service client'
    }),
    ru: Object.freeze({
      heading: 'Сведения об операторе сервиса',
      businessName: 'Наименование компании',
      representative: 'Представитель',
      registrationNumber: 'Регистрационный номер компании',
      customerInquiries: 'Поддержка клиентов'
    })
  });

  function operatorDetailsHtml(locale) {
    const labels = operatorLabels[locale];
    return `
      <section class="operator-details">
        <h2>${labels.heading}</h2>
        <p>
          <strong>${labels.businessName}:</strong> ${operatorDetails.businessName}<br />
          <strong>${labels.representative}:</strong> ${operatorDetails.representative}<br />
          <strong>${labels.registrationNumber}:</strong> ${operatorDetails.registrationNumber}<br />
          <strong>${labels.customerInquiries}:</strong> <a href="mailto:${operatorDetails.customerInquiries}">${operatorDetails.customerInquiries}</a>
        </p>
      </section>
    `;
  }

  function documentHtml(title, meta, notice, body) {
    return `
      <h1 class="page-title">${title}</h1>
      <p class="page-meta">${meta}</p>
      <p class="legal-translation-note">${notice}</p>
      ${body}
      <!-- operator-details -->
      <hr class="divider" />
      <p style="font-size:0.8rem; color: var(--clr-text-muted);">© 2026 PromptGen. All rights reserved.</p>
    `;
  }

  const koNotice = '이 번역은 편의를 위해 제공됩니다. 번역문과 영어 원문이 충돌하는 경우, 관련 법률이 허용하는 범위에서 영어 원문이 우선합니다.';

  const documents = {
    ko: {
      terms: {
        title: '이용약관 – PromptGen',
        html: documentHtml(
          '이용약관',
          '시행일: 2026년 5월 1일 · 최종 업데이트: 2026년 7월 18일',
          koNotice,
          `
          <p><strong>PromptGen</strong>(이하 “당사”)에 오신 것을 환영합니다. <strong>promptgen-ai.com</strong>에 접속하거나 서비스를 사용하면 본 이용약관(이하 “약관”)에 동의하는 것으로 간주됩니다. 서비스를 사용하기 전에 주의 깊게 읽어 주세요.</p>
          <hr class="divider" />
          <h2>1. 약관 동의</h2>
          <p>계정을 만들거나 PromptGen의 일부를 사용함으로써 만 13세 이상이며 본 약관에 동의함을 확인합니다. 조직을 대신해 서비스를 사용하는 경우, 해당 조직을 본 약관에 구속할 권한이 있음을 진술합니다.</p>
          <h2>2. 서비스 설명</h2>
          <p>PromptGen은 이미지→프롬프트 분석, 엔드프레임 추출기, 그리고 Seedance 같은 외부 영상 생성 도구에서 사용할 스토리보드 그리드와 컷별 프롬프트를 만드는 스토리보드 생성기를 제공합니다. PromptGen 자체는 최종 영상을 생성하지 않습니다. 플랜은 다음과 같습니다.</p>
          <ul>
            <li><strong>무료 플랜:</strong> 비용 없이 하루 1회 분석.</li>
            <li><strong>Pro 플랜:</strong> 결제 주기마다 1,000크레딧이 제공되는 월간 1인용 구독.</li>
            <li><strong>Enterprise 플랜:</strong> 결제 주기마다 4,000크레딧이 제공되는 고용량 월간 1인용 구독. API, 팀 워크스페이스, 커스텀 모델 또는 관리형 지원은 포함되지 않습니다.</li>
          </ul>
          <p>현재 기준으로 유료 플랜의 이미지 분석은 1회당 10크레딧, 스토리보드는 1개당 120크레딧을 사용합니다. 구독이 정상 갱신될 때 잔액은 해당 플랜의 할당량으로 초기화되며 미사용 크레딧은 이월되지 않습니다. 표시된 스토리보드 수는 전체 할당량을 모두 스토리보드에 사용하고 이미지 분석에는 사용하지 않았을 때의 최대치입니다.</p>
          <h2>3. 사용자 계정</h2>
          <p>무료 범위를 넘는 기능을 사용하려면 Google OAuth로 로그인해야 합니다. 계정 보안을 유지하고 계정에서 발생하는 모든 활동에 책임을 져야 합니다. 무단 사용을 발견하면 즉시 알려 주세요.</p>
          <h2>4. 허용되는 사용</h2>
          <p>다음 목적으로 PromptGen을 사용하지 않는 데 동의합니다.</p>
          <ul>
            <li>불법·유해·모욕·명예훼손에 해당하거나 제3자의 권리를 침해하는 이미지 업로드.</li>
            <li>노골적인 성적·폭력적 콘텐츠 또는 기타 금지 콘텐츠 업로드.</li>
            <li>당사의 API 또는 AI 모델을 역설계·스크래핑하거나 오용하려는 시도.</li>
            <li>크레딧 또는 요청 제한 시스템의 우회·남용.</li>
            <li>기타 불법 목적의 서비스 이용.</li>
          </ul>
          <p>당사는 본 약관을 위반한 계정을 일시 정지하거나 종료할 수 있습니다.</p>
          <h2>5. 지식재산권</h2>
          <p>업로드한 이미지의 소유권은 사용자에게 있습니다. 콘텐츠를 업로드하면 사용자에게 서비스를 제공하는 목적으로만 해당 콘텐츠를 처리할 수 있는 제한적이고 비독점적인 라이선스를 당사에 부여합니다. 생성된 프롬프트는 개인적 또는 상업적 용도로 사용할 수 있습니다.</p>
          <p>PromptGen의 명칭, 로고, 웹사이트 디자인 및 기반 기술은 당사의 지식재산이며 서면 허가 없이 복사하거나 재사용할 수 없습니다.</p>
          <h2>6. 결제 및 크레딧</h2>
          <p>Pro와 Enterprise는 당사의 판매 책임자(Merchant of Record)이자 공인 리셀러인 <strong>Paddle</strong>이 판매·처리하는 반복 월간 구독입니다. 취소할 때까지 자동으로 갱신됩니다. 가격은 관련 세금 적용 전 USD로 표시되며, Paddle Checkout은 구매 전에 최종 현지화 금액과 세금 처리를 보여 줍니다.</p>
          <p>Paddle 고객 포털에서 구독을 관리하거나 취소할 수 있습니다. 취소는 현재 결제 기간 종료 시 효력이 발생합니다. 크레딧은 양도할 수 없습니다. 환불 및 법정 철회권에는 당사의 <a href="/refund.html">환불 정책</a>, Paddle의 구매자 약관과 환불 정책, 관련 법률이 적용됩니다.</p>
          <h2>7. 보증의 부인</h2>
          <p>PromptGen은 어떠한 종류의 보증도 없이 “있는 그대로” 및 “이용 가능한 상태로” 제공됩니다. 서비스가 중단되거나 오류가 없을 것, 또는 생성된 프롬프트가 특정 요구사항을 충족할 것을 보장하지 않습니다. AI 결과는 달라질 수 있습니다.</p>
          <h2>8. 책임의 제한</h2>
          <p>관련 법률이 허용하는 최대 범위에서, 당사는 서비스의 사용 또는 사용 불능으로 발생하는 간접·부수·특별·결과적 또는 징벌적 손해에 책임을 지지 않습니다.</p>
          <h2>9. 약관 변경</h2>
          <p>당사는 수시로 본 약관을 업데이트할 수 있습니다. 중요한 변경은 “최종 업데이트” 날짜를 변경해 알립니다. 변경 후에도 서비스를 계속 사용하면 개정 약관에 동의한 것으로 간주됩니다.</p>
          <h2>10. 준거법</h2>
          <p>본 약관은 대한민국 법률의 적용을 받습니다. 본 약관과 관련된 분쟁은 대한민국 관할 법원의 전속 관할에 따릅니다.</p>
          <h2>11. 문의</h2>
          <p>본 약관에 관한 질문은 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>으로 문의해 주세요.</p>
          `
        )
      },
      privacy: {
        title: '개인정보 처리방침 – PromptGen',
        html: documentHtml(
          '개인정보 처리방침',
          '시행일: 2026년 5월 1일 · 최종 업데이트: 2026년 7월 20일',
          koNotice,
          `
          <p>PromptGen(이하 “당사”)은 사용자의 개인정보 보호를 중요하게 생각합니다. 본 개인정보 처리방침은 <strong>promptgen-ai.com</strong>을 사용할 때 당사가 데이터를 수집·이용·보호하는 방법을 설명합니다.</p>
          <hr class="divider" />
          <h2>1. 수집하는 정보</h2>
          <p>당사는 다음 유형의 정보를 수집합니다.</p>
          <ul>
            <li><strong>계정 정보:</strong> Google로 로그인하면 Google OAuth에서 이름, 이메일 주소 및 프로필 사진을 받습니다.</li>
            <li><strong>이용 데이터:</strong> 분석 수행 횟수, 플랜 유형, 크레딧 잔액, 제품 퍼널 이벤트 이름, 정규화된 페이지 경로, 무작위 탭 세션 식별자 및 활동 시각. 제품 분석 이벤트에는 전체 URL, 쿼리 문자열, 원본 리퍼러, 프롬프트, 시나리오, 이미지, 이메일 주소 또는 액세스 토큰을 포함하지 않습니다.</li>
            <li><strong>업로드 이미지:</strong> 이미지→프롬프트 또는 스토리보드 레퍼런스로 업로드한 이미지. 이미지→프롬프트 업로드는 분석 후 삭제됩니다. 스토리보드 레퍼런스와 생성된 그리드는 처리, 결과 접근 및 예약 정리를 위해 비공개 저장소에 일시 보관될 수 있습니다.</li>
            <li><strong>생성된 프롬프트:</strong> 이미지에서 생성된 프롬프트는 사용자 확인을 위해 기록에 저장될 수 있습니다.</li>
            <li><strong>결제 정보:</strong> 결제 거래는 전적으로 Paddle이 처리합니다. 당사는 신용카드 또는 결제 세부정보를 저장하지 않습니다.</li>
            <li><strong>로그 데이터:</strong> 보안 및 디버깅을 위해 IP 주소, 요청 시각, 오류 정보가 포함된 서버 로그를 수집할 수 있습니다.</li>
          </ul>
          <h2>2. 정보 이용 목적</h2>
          <p>당사는 다음 목적으로 데이터를 사용합니다.</p>
          <ul>
            <li>PromptGen 서비스 제공, 유지 및 개선.</li>
            <li>계정, 크레딧 및 구독 플랜 관리.</li>
            <li>결제 처리 및 사기 방지.</li>
            <li>이용약관 집행 및 허용되는 사용 보장.</li>
            <li>결제 확인 같은 거래 관련 알림 전송.</li>
          </ul>
          <h2>3. 제3자 서비스</h2>
          <p>당사는 사용자의 데이터를 처리할 수 있는 다음 제3자 서비스를 이용합니다.</p>
          <ul>
            <li><strong>Google OAuth / Supabase Auth:</strong> 인증에 사용하며 Google의 개인정보처리방침이 적용됩니다.</li>
            <li><strong>Supabase:</strong> 데이터베이스 및 백엔드 인프라.</li>
            <li><strong>Google Gemini API:</strong> 이미지 분석과 프롬프트 제안을 위해 이미지→프롬프트 업로드를 전송합니다.</li>
            <li><strong>OpenAI API:</strong> 안전성 검토, 컷 프롬프트 생성 및 스토리보드 그리드 생성을 위해 시나리오, 프롬프트 텍스트와 레퍼런스 이미지를 전송할 수 있습니다.</li>
            <li><strong>Paddle:</strong> 결제 처리업체이며 Paddle의 개인정보처리방침이 적용됩니다.</li>
            <li><strong>Railway:</strong> 호스팅 제공업체.</li>
            <li><strong>Cloudflare:</strong> 콘텐츠 전송 및 보안 제공업체. Cloudflare는 쿠키를 사용하지 않는 Web Analytics RUM 비콘으로 페이지 수준 성능 지표를 처리할 수도 있습니다. 이 비콘은 브라우저 저장소 또는 영구 식별자를 사용하지 않으며 PromptGen의 자체 제품 퍼널 이벤트와 분리됩니다.</li>
          </ul>
          <p>당사는 사용자의 개인정보를 제3자에게 판매하지 않습니다.</p>
          <h2>4. 데이터 보존</h2>
          <ul>
            <li><strong>계정 데이터</strong>는 계정이 활성 상태인 동안 보존됩니다.</li>
            <li><strong>이미지→프롬프트 업로드</strong>는 분석 후 삭제됩니다.</li>
            <li><strong>스토리보드 레퍼런스 업로드</strong>는 처리를 위해 비공개 저장소에 보관되며 24시간 후 만료됩니다.</li>
            <li><strong>생성된 스토리보드 그리드</strong>는 생성일로부터 90일 동안 스토리보드 기록에서 이용할 수 있으며 이후 예약 정리로 삭제됩니다. soft-delete된 데이터베이스 기록은 완전 삭제 전 최대 30일 더 남을 수 있습니다.</li>
            <li><strong>프롬프트 기록</strong>은 사용자가 삭제하거나 계정을 닫을 때까지 저장됩니다.</li>
            <li><strong>결제 기록</strong>은 관련 법률이 요구하는 기간 동안 보존됩니다.</li>
            <li><strong>자체 제품 분석 이벤트</strong>는 180일 동안 보존된 후 자동 삭제됩니다.</li>
          </ul>
          <h2>5. 사용자의 권리</h2>
          <p>사용자는 개인정보에 대한 접근, 정정 또는 삭제 권리를 가질 수 있습니다. 권리 행사는 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>으로 문의해 주세요.</p>
          <h2>6. 보안</h2>
          <p>당사는 HTTPS 암호화, JWT 기반 인증, 데이터베이스의 Row Level Security 및 요청 제한을 포함한 합리적인 보안 조치를 적용합니다. 인터넷을 통한 전송 방식은 100% 안전하지 않습니다.</p>
          <h2>7. 쿠키 및 브라우저 저장소</h2>
          <p>당사는 제3자 광고 쿠키나 영구 분석 식별자를 사용하지 않습니다. 인증과 자체 제품 분석에는 세션 범위 브라우저 저장소를 사용합니다. 분석 식별자는 탭 세션과 함께 만료되는 무작위 UUID이며 사이트 간 추적에 사용되지 않고, 브라우저가 Do Not Track 신호를 전송하면 수집하지 않습니다. 언어 선택은 기능성 로컬 설정으로만 저장되며 분석 식별자 또는 사용자 추적 프로필과 결합하지 않습니다.</p>
          <h2>8. 아동의 개인정보</h2>
          <p>PromptGen은 만 13세 미만 아동을 대상으로 하지 않으며 아동의 개인정보를 고의로 수집하지 않습니다.</p>
          <h2>9. 방침 변경</h2>
          <p>당사는 본 방침을 정기적으로 업데이트할 수 있습니다. 변경 후 서비스를 계속 사용하면 업데이트된 방침에 동의한 것으로 간주됩니다.</p>
          <h2>10. 문의</h2>
          <p><strong>이메일:</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>웹사이트:</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>
          `
        )
      },
      refund: {
        title: '환불 정책 – PromptGen',
        html: documentHtml(
          '환불 정책',
          '시행일: 2026년 5월 1일 · 최종 업데이트: 2026년 7월 18일',
          koNotice,
          `
          <div class="highlight-box"><p>PromptGen 구독은 당사의 판매 책임자(Merchant of Record)인 <strong>Paddle</strong>이 판매합니다. 환불 가능 여부는 <a href="https://www.paddle.com/legal/refund-policy" rel="noopener noreferrer">Paddle 환불 정책</a>과 관련 소비자법에 따라 결정됩니다. 본 정책은 사용자 국가에서 보장되는 강행적 권리를 제한하지 않습니다.</p></div>
          <hr class="divider" />
          <h2>1. 구독 구매</h2>
          <p>Pro와 Enterprise는 일회성 크레딧 묶음이 아니라 월간 구독입니다. Pro는 결제 주기마다 1,000크레딧, Enterprise는 4,000크레딧을 제공합니다. 갱신 시 크레딧은 플랜 할당량으로 초기화되며 미사용 크레딧은 이월되지 않습니다.</p>
          <h2>2. 환불 가능 조건</h2>
          <p>Paddle은 환불 요청을 건별로 검토합니다. 사용자 국가의 법정 철회권, 중복 또는 잘못된 청구, 구매한 서비스에 접근하지 못하게 하는 중대한 기술적 결함 등이 환불 사유에 포함될 수 있습니다. 법률이 허용하는 경우 크레딧 또는 기타 혜택 사용 여부가 환불 자격에 영향을 줄 수 있습니다.</p>
          <ul>
            <li>일부 소비자에게는 최대 14일의 법정 철회 기간이 적용되며 국가별 기간과 예외가 다릅니다.</li>
            <li>기술적 오류로 동일 주문이 여러 번 청구된 경우.</li>
            <li>결제 오류로 잘못된 금액이 청구된 경우.</li>
            <li>지속적이고 중대한 결함 때문에 구매 시 설명된 기능에 접근하지 못한 경우.</li>
          </ul>
          <h2>3. 일반적으로 환불되지 않는 경우</h2>
          <p>법률에서 요구하거나 Paddle이 승인하는 경우를 제외하면 거래는 일반적으로 환불되지 않습니다. 다음과 같은 경우 요청이 거절될 수 있습니다.</p>
          <ul>
            <li>크레딧을 일부 또는 전부 사용한 경우.</li>
            <li>AI 생성 결과의 품질에 대한 불만만을 근거로 한 경우(AI 결과는 본질적으로 달라질 수 있습니다).</li>
            <li>이용약관 위반으로 계정이 정지 또는 종료된 경우.</li>
          </ul>
          <h2>4. 환불 요청 방법</h2>
          <p>Paddle 거래 이메일의 “영수증 보기” 또는 “구독 관리” 링크를 사용하거나 <a href="https://paddle.net" rel="noopener noreferrer">paddle.net</a>에서 환불 옵션을 선택하세요. 제품 지원은 다음 정보와 함께 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>으로 문의할 수 있습니다.</p>
          <ul>
            <li>계정 이메일 주소.</li>
            <li>구매일과 주문 ID(Paddle 영수증에서 확인).</li>
            <li>문제에 대한 간단한 설명.</li>
          </ul>
          <p>Paddle은 거래 기록으로 환불 자격을 확인하고 가능한 경우 승인된 환불을 원래 결제 수단으로 처리합니다. 처리 기한에는 Paddle의 최신 정책과 관련 법률이 적용됩니다.</p>
          <h2>5. 결제 처리업체</h2>
          <p>Paddle은 PromptGen 구독의 판매자이자 판매 책임자입니다. Paddle이 결제 지원, 취소 및 환불을 처리합니다. PromptGen은 사용자의 전체 결제 카드 정보를 저장하지 않습니다.</p>
          <h2>6. 정책 변경</h2>
          <p>당사는 수시로 본 환불 정책을 업데이트할 수 있습니다. 변경 사항은 위의 “최종 업데이트” 날짜에 반영됩니다.</p>
          <h2>7. 문의</h2>
          <p>환불 정책에 관한 질문은 다음으로 문의해 주세요.</p>
          <p><strong>이메일:</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>웹사이트:</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>
          `
        )
      }
    },
    ja: {
      terms: {
        title: '利用規約 – PromptGen',
        html: documentHtml('利用規約', '施行日：2026年5月1日 · 最終更新：2026年7月18日',
          'この翻訳は便宜のために提供されています。翻訳文と英語原文が矛盾する場合、適用法で許される範囲において英語原文が優先されます。', `
          <p><strong>PromptGen</strong>（以下「当社」）へようこそ。<strong>promptgen-ai.com</strong>へアクセスまたは利用することで、本利用規約（以下「本規約」）に同意したものとみなされます。サービス利用前に注意してお読みください。</p>
          <hr class="divider" />
          <h2>1. 規約への同意</h2><p>アカウントの作成またはPromptGenの一部を利用することで、13歳以上であり、本規約に同意することを確認します。組織を代表して利用する場合、その組織を本規約に拘束する権限があることを表明します。</p>
          <h2>2. サービス内容</h2><p>PromptGenは、画像からプロンプトへの分析、最終フレーム抽出ツール、およびSeedanceなど外部動画生成ツール向けのグリッドとショット別プロンプトを作るストーリーボード生成機能を提供します。PromptGen自体は最終動画を生成しません。プランは次のとおりです。</p>
          <ul><li><strong>無料プラン：</strong>1日1回の分析を無料で利用できます。</li><li><strong>Proプラン：</strong>請求サイクルごとに1,000クレジットを付与する月額・1ユーザー向けサブスクリプション。</li><li><strong>Enterpriseプラン：</strong>請求サイクルごとに4,000クレジットを付与する大容量の月額・1ユーザー向けサブスクリプション。API、チームワークスペース、カスタムモデル、マネージドサポートは含まれません。</li></ul>
          <p>現在のレートでは、有料プランで画像分析1回につき10クレジット、ストーリーボード1件につき120クレジットを消費します。正常に更新されるたび、残高はプランの割当数にリセットされ、未使用クレジットは繰り越されません。表示されるストーリーボード件数は、全クレジットをストーリーボードだけに使い、画像分析に使わない場合の上限です。</p>
          <h2>3. ユーザーアカウント</h2><p>無料範囲を超える機能にはGoogle OAuthでのログインが必要です。アカウントの機密性と、アカウントで行われるすべての活動に責任を負います。不正利用を発見した場合は直ちにご連絡ください。</p>
          <h2>4. 適切な利用</h2><p>PromptGenを次の目的で使用しないことに同意します。</p><ul><li>違法、有害、虐待的、名誉毀損的、または第三者の権利を侵害する画像のアップロード。</li><li>露骨な性的・暴力的コンテンツ、その他禁止コンテンツのアップロード。</li><li>当社のAPIやAIモデルのリバースエンジニアリング、スクレイピング、その他の不正利用。</li><li>クレジットやレート制限システムの回避または悪用。</li><li>その他の違法な目的での利用。</li></ul><p>当社は、本規約に違反したアカウントを停止または終了する権利を留保します。</p>
          <h2>5. 知的財産</h2><p>アップロードした画像の所有権はユーザーに残ります。コンテンツをアップロードすることで、サービス提供の目的に限り当社が処理するための限定的かつ非独占的なライセンスを当社に付与します。生成されたプロンプトは個人または商用目的で利用できます。</p><p>PromptGenの名称、ロゴ、ウェブサイトデザイン、基盤技術は当社の知的財産であり、書面による許可なく複製・再利用できません。</p>
          <h2>6. 支払いとクレジット</h2><p>ProとEnterpriseは、当社のMerchant of Record（販売責任者）兼認定再販業者である<strong>Paddle</strong>が販売・処理する月額自動更新サブスクリプションです。解約するまで自動更新されます。価格は適用税前のUSDで表示され、Paddle Checkoutが購入前に最終的な現地通貨額と税処理を表示します。</p><p>Paddleのカスタマーポータルでサブスクリプションを管理・解約できます。解約は現在の請求期間終了時に有効になります。クレジットは譲渡できません。返金と法定撤回権には、当社の<a href="/refund.html">返金ポリシー</a>、Paddleの購入者条件および返金ポリシー、適用法が適用されます。</p>
          <h2>7. 免責事項</h2><p>PromptGenは、いかなる保証もなく「現状有姿」かつ「提供可能な範囲」で提供されます。サービスが中断・エラーなく動作することや、生成プロンプトが特定の要件を満たすことを保証しません。AIの出力は変動します。</p>
          <h2>8. 責任の制限</h2><p>適用法で許される最大限の範囲で、当社はサービスの利用または利用不能から生じる間接的、付随的、特別、結果的、懲罰的損害について責任を負いません。</p>
          <h2>9. 規約の変更</h2><p>当社は本規約を随時更新できます。重要な変更は「最終更新」日を変更して通知します。変更後も利用を継続した場合、改定後の規約に同意したものとみなされます。</p>
          <h2>10. 準拠法</h2><p>本規約は大韓民国法に準拠します。本規約に関する紛争は韓国の管轄裁判所の専属管轄に服します。</p>
          <h2>11. お問い合わせ</h2><p>本規約に関する質問は<a href="mailto:codemeet@naver.com">codemeet@naver.com</a>までご連絡ください。</p>`)
      },
      privacy: {
        title: 'プライバシーポリシー – PromptGen',
        html: documentHtml('プライバシーポリシー', '施行日：2026年5月1日 · 最終更新：2026年7月20日',
          'この翻訳は便宜のために提供されています。翻訳文と英語原文が矛盾する場合、適用法で許される範囲において英語原文が優先されます。', `
          <p>PromptGen（以下「当社」）は個人情報の保護に努めています。本ポリシーは、<strong>promptgen-ai.com</strong>利用時にデータを収集、使用、保護する方法を説明します。</p><hr class="divider" />
          <h2>1. 収集する情報</h2><p>次の種類の情報を収集します。</p><ul><li><strong>アカウント情報：</strong>Googleログイン時に、Google OAuthから氏名、メールアドレス、プロフィール画像を受け取ります。</li><li><strong>利用データ：</strong>分析回数、プラン種別、クレジット残高、製品ファネルのイベント名、正規化されたページパス、ランダムなタブセッション識別子、活動時刻。製品分析イベントには、完全なURL、クエリ文字列、生の参照元、プロンプト、シナリオ、画像、メールアドレス、アクセストークンを含めません。</li><li><strong>アップロード画像：</strong>画像→プロンプトまたはストーリーボードの参考としてアップロードした画像。画像→プロンプトの画像は分析後に削除されます。参考画像と生成グリッドは、処理、結果閲覧、定期削除のため非公開ストレージに一時保管される場合があります。</li><li><strong>生成プロンプト：</strong>画像から生成されたプロンプトは、参照用に履歴へ保存される場合があります。</li><li><strong>支払い情報：</strong>決済はすべてPaddleが処理し、当社はカード情報や支払い詳細を保存しません。</li><li><strong>ログデータ：</strong>セキュリティとデバッグのため、IPアドレス、リクエスト時刻、エラー情報を含むサーバーログ。</li></ul>
          <h2>2. 情報の利用目的</h2><p>サービスの提供・維持・改善、アカウント・クレジット・プランの管理、決済と不正防止、利用規約の適用、取引関連通知の送信にデータを使用します。</p>
          <h2>3. 第三者サービス</h2><p>データを処理する可能性がある以下のサービスを利用します。</p><ul><li><strong>Google OAuth / Supabase Auth：</strong>認証。Googleのプライバシーポリシーが適用されます。</li><li><strong>Supabase：</strong>データベースとバックエンド基盤。</li><li><strong>Google Gemini API：</strong>画像分析と提案のため画像→プロンプトの画像を送信します。</li><li><strong>OpenAI API：</strong>安全性審査、ショットプロンプト生成、グリッド生成のため、シナリオ、プロンプト、参考画像を送信する場合があります。</li><li><strong>Paddle：</strong>決済処理。Paddleのプライバシーポリシーが適用されます。</li><li><strong>Railway：</strong>ホスティング。</li><li><strong>Cloudflare：</strong>配信とセキュリティ。Cookieを使わないWeb Analytics RUMビーコンでページ単位の性能指標を処理する場合があります。このビーコンはブラウザストレージや永続識別子を使わず、当社の製品ファネルイベントとは分離されています。</li></ul><p>個人情報を第三者へ販売しません。</p>
          <h2>4. データ保持</h2><ul><li><strong>アカウントデータ</strong>はアカウントが有効な間保持されます。</li><li><strong>画像→プロンプトのアップロード</strong>は分析後に削除されます。</li><li><strong>ストーリーボードの参考画像</strong>は処理のため非公開保存され、24時間後に期限切れとなります。</li><li><strong>生成されたストーリーボードグリッド</strong>は作成日から90日間履歴で利用でき、その後定期削除されます。soft-deleteされたデータベース記録は完全削除まで最大30日追加で残る場合があります。</li><li><strong>プロンプト履歴</strong>は削除または退会まで保存されます。</li><li><strong>支払い記録</strong>は法令上必要な期間保持されます。</li><li><strong>自社製品分析イベント</strong>は180日後に自動削除されます。</li></ul>
          <h2>5. ユーザーの権利</h2><p>個人データへのアクセス、訂正、削除を求める権利を有する場合があります。<a href="mailto:codemeet@naver.com">codemeet@naver.com</a>へご連絡ください。</p>
          <h2>6. セキュリティ</h2><p>HTTPS、JWT認証、Row Level Security、レート制限など合理的な措置を実施しますが、インターネット送信は100%安全ではありません。</p>
          <h2>7. Cookieとブラウザストレージ</h2><p>第三者広告Cookieや永続的な分析識別子は使いません。認証と自社分析にはセッション単位のブラウザストレージを使います。分析IDはタブ終了時に期限切れとなるランダムUUIDで、サイト横断追跡には使わず、Do Not Track信号時には収集しません。言語設定は機能上のローカル設定としてのみ保存し、分析IDや追跡プロフィールと結び付けません。</p>
          <h2>8. 子どものプライバシー</h2><p>PromptGenは13歳未満を対象とせず、子どもの個人データを意図的に収集しません。</p>
          <h2>9. ポリシーの変更</h2><p>本ポリシーを定期的に更新する場合があります。変更後の継続利用は更新版への同意とみなされます。</p>
          <h2>10. お問い合わせ</h2><p><strong>メール：</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>ウェブサイト：</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      },
      refund: {
        title: '返金ポリシー – PromptGen',
        html: documentHtml('返金ポリシー', '施行日：2026年5月1日 · 最終更新：2026年7月18日',
          'この翻訳は便宜のために提供されています。翻訳文と英語原文が矛盾する場合、適用法で許される範囲において英語原文が優先されます。', `
          <div class="highlight-box"><p>PromptGenのサブスクリプションはMerchant of Recordである<strong>Paddle</strong>が販売します。返金可否は<a href="https://www.paddle.com/legal/refund-policy" rel="noopener noreferrer">Paddleの返金ポリシー</a>と適用される消費者法に基づきます。本ポリシーは、お住まいの国で認められる強行的権利を制限しません。</p></div><hr class="divider" />
          <h2>1. サブスクリプション購入</h2><p>ProとEnterpriseは買い切りクレジットではなく月額サブスクリプションです。請求サイクルごとにProは1,000クレジット、Enterpriseは4,000クレジットを付与します。更新時にプラン割当数へリセットされ、未使用分は繰り越されません。</p>
          <h2>2. 返金対象</h2><p>Paddleが個別に審査します。居住国の法定撤回権、重複・誤請求、購入サービスへアクセスできない重大な技術的不具合などが対象となる場合があります。法令で認められる場合、クレジット等の利用状況が対象可否に影響します。</p><ul><li>一部の消費者には最大14日の法定撤回期間があり、国ごとの期間と例外が適用されます。</li><li>技術的エラーで同じ注文が複数回請求された場合。</li><li>請求エラーで誤った金額が請求された場合。</li><li>継続的かつ重大な不具合により購入時に説明された機能へアクセスできなかった場合。</li></ul>
          <h2>3. 原則返金不可となる場合</h2><p>法令上必要またはPaddleが承認する場合を除き、取引は原則返金不可です。次の場合は拒否されることがあります。</p><ul><li>クレジットを一部または全部使用した場合。</li><li>AI出力品質への不満のみを理由とする場合（AI結果は本質的に変動します）。</li><li>利用規約違反でアカウントが停止・終了された場合。</li></ul>
          <h2>4. 返金の申請方法</h2><p>Paddleの取引メールにある「領収書を表示」または「サブスクリプションを管理」を使うか、<a href="https://paddle.net" rel="noopener noreferrer">paddle.net</a>で返金を選択してください。製品サポートは<a href="mailto:codemeet@naver.com">codemeet@naver.com</a>へ、アカウントのメールアドレス、購入日と注文ID、問題の概要を添えてご連絡ください。</p><p>Paddleが取引記録で返金対象を確認し、可能な場合は元の支払い方法へ処理します。処理期限にはPaddleの最新ポリシーと適用法が優先されます。</p>
          <h2>5. 決済処理業者</h2><p>PaddleはPromptGenサブスクリプションの販売者兼Merchant of Recordで、決済サポート、解約、返金を扱います。PromptGenはカード番号全体を保存しません。</p>
          <h2>6. ポリシーの変更</h2><p>本ポリシーを随時更新する場合があります。変更は上記「最終更新」日に反映されます。</p>
          <h2>7. お問い合わせ</h2><p><strong>メール：</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>ウェブサイト：</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      }
    },
    'zh-CN': {
      terms: {
        title: '服务条款 – PromptGen',
        html: documentHtml('服务条款', '生效日期：2026年5月1日 · 最后更新：2026年7月18日',
          '本译文仅为方便阅读而提供。如译文与英文原文存在冲突，在适用法律允许的范围内，以英文原文为准。', `
          <p>欢迎使用 <strong>PromptGen</strong>（以下简称“我们”）。访问或使用 <strong>promptgen-ai.com</strong> 即表示您同意受本服务条款（以下简称“条款”）约束。使用服务前请仔细阅读。</p><hr class="divider" />
          <h2>1. 接受条款</h2><p>创建账号或使用 PromptGen 的任何部分，即表示您确认已年满13周岁并同意本条款。如果您代表组织使用服务，您声明有权使该组织受本条款约束。</p>
          <h2>2. 服务说明</h2><p>PromptGen 提供图片转提示词分析、尾帧提取工具，以及生成故事板网格和逐镜头提示词的故事板生成器，相关提示词可用于 Seedance 等外部视频生成工具。PromptGen 本身不生成最终视频。方案如下：</p><ul><li><strong>免费方案：</strong>每天免费分析1次。</li><li><strong>Pro 方案：</strong>单用户月度订阅，每个计费周期提供1,000积分。</li><li><strong>Enterprise 方案：</strong>高用量单用户月度订阅，每个计费周期提供4,000积分；不包含 API、团队工作区、自定义模型或托管支持。</li></ul><p>按当前费率，付费方案每次图片分析消耗10积分，每个故事板消耗120积分。每次成功续订后，余额将重置为方案额度，未使用积分不可结转。页面所示故事板数量按全部积分仅用于故事板、未用于图片分析时的最大值计算。</p>
          <h2>3. 用户账号</h2><p>使用免费层级以外的功能必须通过 Google OAuth 登录。您有责任维护账号安全并对账号下的所有活动负责。如发现未经授权的使用，请立即通知我们。</p>
          <h2>4. 可接受使用</h2><p>您同意不会使用 PromptGen：</p><ul><li>上传违法、有害、辱骂、诽谤或侵犯第三方权利的图片。</li><li>上传露骨色情、暴力或其他禁止内容。</li><li>试图逆向工程、抓取或以其他方式滥用我们的 API 或 AI 模型。</li><li>规避或滥用积分或频率限制系统。</li><li>用于任何违法目的。</li></ul><p>我们有权暂停或终止违反本条款的账号。</p>
          <h2>5. 知识产权</h2><p>您保留所上传图片的所有权。上传内容即授予我们有限、非独占的许可，仅为向您提供服务而处理该内容。生成的提示词可用于个人或商业用途。</p><p>PromptGen 名称、标识、网站设计和底层技术属于我们的知识产权，未经书面许可不得复制或重复使用。</p>
          <h2>6. 付款与积分</h2><p>Pro 和 Enterprise 是由我们的记录商户（Merchant of Record）及授权经销商 <strong>Paddle</strong> 销售和处理的循环月度订阅。订阅会自动续费，直至取消。价格在适用税费前以美元（USD）显示，Paddle Checkout 会在购买前显示最终本地化金额和税务处理。</p><p>您可通过 Paddle 客户门户管理或取消订阅。取消将在当前计费周期结束时生效。积分不可转让。退款和法定撤回权受我们的<a href="/refund.html">退款政策</a>、Paddle 买方条款与退款政策以及适用法律管辖。</p>
          <h2>7. 免责声明</h2><p>PromptGen 按“现状”和“可用状态”提供，不作任何形式的保证。我们不保证服务不会中断、没有错误，亦不保证生成的提示词满足您的特定要求。AI 输出可能存在差异。</p>
          <h2>8. 责任限制</h2><p>在适用法律允许的最大范围内，我们不对因使用或无法使用服务而产生的任何间接、附带、特殊、后果性或惩罚性损害承担责任。</p>
          <h2>9. 条款变更</h2><p>我们可能不时更新本条款。重大变更将通过更新“最后更新”日期通知。变更后继续使用服务即表示接受修订后的条款。</p>
          <h2>10. 适用法律</h2><p>本条款受大韩民国法律管辖。因本条款产生的争议由韩国有管辖权的法院专属管辖。</p>
          <h2>11. 联系我们</h2><p>如对本条款有疑问，请联系 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>。</p>`)
      },
      privacy: {
        title: '隐私政策 – PromptGen',
        html: documentHtml('隐私政策', '生效日期：2026年5月1日 · 最后更新：2026年7月20日',
          '本译文仅为方便阅读而提供。如译文与英文原文存在冲突，在适用法律允许的范围内，以英文原文为准。', `
          <p>PromptGen（以下简称“我们”）致力于保护您的个人信息。本政策说明您使用 <strong>promptgen-ai.com</strong> 时，我们如何收集、使用和保护数据。</p><hr class="divider" />
          <h2>1. 我们收集的信息</h2><p>我们收集以下类型的信息：</p><ul><li><strong>账号信息：</strong>通过 Google 登录时，我们会从 Google OAuth 获取您的姓名、电子邮箱和头像。</li><li><strong>使用数据：</strong>分析次数、方案类型、积分余额、产品漏斗事件名称、规范化页面路径、随机标签页会话标识符及活动时间。产品分析事件不包含完整 URL、查询字符串、原始来源网址、提示词、剧本、图片、电子邮箱或访问令牌。</li><li><strong>上传图片：</strong>用于图片转提示词或故事板参考的图片。图片转提示词的上传内容在分析后删除。故事板参考图和生成网格可能临时保存在私有存储中，用于处理、结果访问和定期清理。</li><li><strong>生成的提示词：</strong>根据图片生成的提示词可能保存到您的历史记录中。</li><li><strong>付款信息：</strong>付款交易完全由 Paddle 处理，我们不存储银行卡或付款详情。</li><li><strong>日志数据：</strong>为保障安全和调试而记录的服务器日志，包括 IP 地址、请求时间和错误信息。</li></ul>
          <h2>2. 信息使用方式</h2><p>我们使用数据来提供、维护和改进服务；管理账号、积分和订阅；处理付款和防止欺诈；执行服务条款；以及发送付款确认等交易通知。</p>
          <h2>3. 第三方服务</h2><p>以下服务可能处理您的数据：</p><ul><li><strong>Google OAuth / Supabase Auth：</strong>用于身份验证，适用 Google 隐私政策。</li><li><strong>Supabase：</strong>数据库和后端基础设施。</li><li><strong>Google Gemini API：</strong>接收图片转提示词的图片，用于分析和提示词建议。</li><li><strong>OpenAI API：</strong>可能接收故事板剧本、提示词文本和参考图片，用于安全审核、镜头提示词及网格生成。</li><li><strong>Paddle：</strong>付款处理方，适用 Paddle 隐私政策。</li><li><strong>Railway：</strong>托管服务商。</li><li><strong>Cloudflare：</strong>内容分发和安全服务商，也可能通过不使用 Cookie 的 Web Analytics RUM 信标处理页面级性能指标。该信标不使用浏览器存储或持久标识符，并与 PromptGen 自有产品漏斗事件分离。</li></ul><p>我们不会向第三方出售您的个人信息。</p>
          <h2>4. 数据保留</h2><ul><li><strong>账号数据</strong>在账号有效期间保留。</li><li><strong>图片转提示词上传</strong>在分析后删除。</li><li><strong>故事板参考图</strong>为处理需要存于私有存储，并在24小时后过期。</li><li><strong>生成的故事板网格</strong>自创建日起在历史记录中保留90天，之后由定期任务删除。soft-delete 的数据库记录在永久删除前可能额外保留最多30天。</li><li><strong>提示词历史</strong>保存至您删除记录或关闭账号。</li><li><strong>付款记录</strong>按适用法律要求保留。</li><li><strong>自有产品分析事件</strong>保留180天后自动删除。</li></ul>
          <h2>5. 您的权利</h2><p>您可能有权访问、更正或删除个人数据。请联系 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>。</p>
          <h2>6. 安全</h2><p>我们采取 HTTPS 加密、JWT 身份验证、数据库 Row Level Security 和频率限制等合理措施。任何互联网传输方式都无法保证100%安全。</p>
          <h2>7. Cookie 与浏览器存储</h2><p>我们不使用第三方广告 Cookie 或持久分析标识符。身份验证和自有产品分析使用会话范围的浏览器存储。分析标识符是随标签页会话到期的随机 UUID，不用于跨站跟踪；浏览器发送 Do Not Track 信号时不会收集。语言选择仅作为本地功能偏好保存，不会与分析标识符或用户跟踪档案关联。</p>
          <h2>8. 儿童隐私</h2><p>PromptGen 不面向13岁以下儿童，我们不会故意收集儿童的个人数据。</p>
          <h2>9. 政策变更</h2><p>我们可能定期更新本政策。变更后继续使用服务即表示接受更新后的政策。</p>
          <h2>10. 联系我们</h2><p><strong>邮箱：</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>网站：</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      },
      refund: {
        title: '退款政策 – PromptGen',
        html: documentHtml('退款政策', '生效日期：2026年5月1日 · 最后更新：2026年7月18日',
          '本译文仅为方便阅读而提供。如译文与英文原文存在冲突，在适用法律允许的范围内，以英文原文为准。', `
          <div class="highlight-box"><p>PromptGen 订阅由我们的记录商户（Merchant of Record）<strong>Paddle</strong> 销售。退款资格根据 <a href="https://www.paddle.com/legal/refund-policy" rel="noopener noreferrer">Paddle 退款政策</a>和适用消费者法律确定。本政策不限制您所在国家提供的强制性权利。</p></div><hr class="divider" />
          <h2>1. 订阅购买</h2><p>Pro 和 Enterprise 是月度订阅，并非一次性积分包。Pro 每个计费周期提供1,000积分，Enterprise 提供4,000积分。续订时积分重置为方案额度，未使用积分不结转。</p>
          <h2>2. 退款资格</h2><p>Paddle 会逐案审核退款申请。资格可能包括您所在国家的法定撤回权、重复或错误收费，或导致无法使用已购服务的重大技术缺陷。在法律允许时，积分或其他权益的使用情况可能影响资格。</p><ul><li>部分消费者享有最长14天的法定撤回期；具体期限和例外因国家而异。</li><li>因技术错误对同一订单重复收费。</li><li>计费错误导致收费金额不正确。</li><li>持续的重大缺陷导致无法访问购买时说明的功能。</li></ul>
          <h2>3. 通常不予退款的情况</h2><p>除法律要求或 Paddle 批准外，交易通常不可退款。以下情况可能被拒绝：</p><ul><li>积分已部分或全部使用。</li><li>仅因对 AI 生成结果质量不满意（AI 结果本身具有不确定性）。</li><li>账号因违反服务条款而被暂停或终止。</li></ul>
          <h2>4. 申请退款</h2><p>使用 Paddle 交易邮件中的“查看收据”或“管理订阅”链接，或访问 <a href="https://paddle.net" rel="noopener noreferrer">paddle.net</a> 并选择退款。您也可向 <a href="mailto:codemeet@naver.com">codemeet@naver.com</a> 提交产品支持请求，并提供账号邮箱、购买日期、Paddle 收据中的订单号及问题简述。</p><p>Paddle 使用交易记录核实退款资格，并在可行时将获批退款退回原付款方式。处理期限以 Paddle 当前政策和适用法律为准。</p>
          <h2>5. 付款处理方</h2><p>Paddle 是 PromptGen 订阅的卖方和记录商户，负责付款支持、取消和退款。PromptGen 不存储完整的银行卡资料。</p>
          <h2>6. 政策变更</h2><p>我们可能不时更新本退款政策。任何变更都会反映在上方“最后更新”日期中。</p>
          <h2>7. 联系我们</h2><p><strong>邮箱：</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>网站：</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      }
    },
    fr: {
      terms: {
        title: 'Conditions d’utilisation – PromptGen',
        html: documentHtml('Conditions d’utilisation', 'Date d’entrée en vigueur : 1 mai 2026 · Dernière mise à jour : 18 juillet 2026',
          'Cette traduction est fournie à titre pratique. En cas de divergence avec la version anglaise, celle-ci prévaut dans la mesure autorisée par la loi applicable.', `
          <p>Bienvenue sur <strong>PromptGen</strong> (« nous », « notre »). En accédant à <strong>promptgen-ai.com</strong> ou en l’utilisant, vous acceptez les présentes Conditions d’utilisation (« Conditions »). Veuillez les lire attentivement avant d’utiliser le service.</p><hr class="divider" />
          <h2>1. Acceptation des Conditions</h2><p>En créant un compte ou en utilisant PromptGen, vous confirmez avoir au moins 13 ans et accepter ces Conditions. Si vous agissez pour une organisation, vous déclarez être habilité à l’engager.</p>
          <h2>2. Description du service</h2><p>PromptGen propose l’analyse Image vers prompt, un extracteur de dernière image et un générateur de storyboard produisant une grille et des prompts de plans destinés à des outils externes comme Seedance. PromptGen ne génère pas lui-même la vidéo finale. Les offres sont :</p><ul><li><strong>Gratuit :</strong> 1 analyse gratuite par jour.</li><li><strong>Pro :</strong> abonnement mensuel individuel avec 1 000 crédits par cycle de facturation.</li><li><strong>Enterprise :</strong> abonnement mensuel individuel à haut volume avec 4 000 crédits par cycle. Il n’inclut ni API, ni espace d’équipe, ni modèle personnalisé, ni assistance gérée.</li></ul><p>Aux tarifs actuels, une analyse d’image consomme 10 crédits et un storyboard 120 crédits. À chaque renouvellement réussi, le solde revient au quota de l’offre ; les crédits inutilisés ne sont pas reportés. Le nombre de storyboards affiché est un maximum calculé en supposant que le quota entier leur est consacré et qu’aucun crédit n’est utilisé pour l’analyse d’images.</p>
          <h2>3. Comptes utilisateur</h2><p>Vous devez vous connecter via Google OAuth pour accéder aux fonctions au-delà de l’offre gratuite. Vous êtes responsable de la confidentialité du compte et de toute activité qui y est réalisée. Signalez-nous immédiatement toute utilisation non autorisée.</p>
          <h2>4. Usage acceptable</h2><p>Vous vous engagez à ne pas utiliser PromptGen pour :</p><ul><li>Importer des images illégales, nuisibles, abusives, diffamatoires ou portant atteinte aux droits d’un tiers.</li><li>Importer du contenu sexuel explicite, violent ou autrement interdit.</li><li>Tenter de désosser, extraire ou détourner notre API ou nos modèles d’IA.</li><li>Contourner ou abuser des systèmes de crédits ou de limitation de débit.</li><li>Utiliser le service à des fins illégales.</li></ul><p>Nous pouvons suspendre ou fermer les comptes qui enfreignent ces Conditions.</p>
          <h2>5. Propriété intellectuelle</h2><p>Vous conservez la propriété des images importées. Vous nous accordez une licence limitée et non exclusive pour les traiter uniquement afin de fournir le service. Les prompts générés peuvent être utilisés à des fins personnelles ou commerciales.</p><p>Le nom PromptGen, le logo, le design du site et la technologie sous-jacente sont notre propriété intellectuelle et ne peuvent être copiés ou réutilisés sans autorisation écrite.</p>
          <h2>6. Paiements et crédits</h2><p>Pro et Enterprise sont des abonnements mensuels récurrents vendus et traités par <strong>Paddle</strong>, notre Merchant of Record et revendeur agréé. Ils se renouvellent automatiquement jusqu’à résiliation. Les prix sont affichés en USD avant taxes ; Paddle Checkout présente avant l’achat le montant final localisé et le traitement fiscal.</p><p>Vous pouvez gérer ou résilier l’abonnement depuis le portail client Paddle. La résiliation prend effet à la fin de la période en cours. Les crédits ne sont pas transférables. Les remboursements et droits de rétractation obligatoires sont régis par notre <a href="/refund.html">Politique de remboursement</a>, les conditions acheteur et la politique de Paddle, ainsi que la loi applicable.</p>
          <h2>7. Exclusions de garantie</h2><p>PromptGen est fourni « en l’état » et « selon disponibilité », sans garantie. Nous ne garantissons ni un service continu ou sans erreur, ni l’adéquation des prompts à vos besoins. Les résultats de l’IA peuvent varier.</p>
          <h2>8. Limitation de responsabilité</h2><p>Dans toute la mesure permise par la loi, nous ne sommes pas responsables des dommages indirects, accessoires, spéciaux, consécutifs ou punitifs résultant de l’utilisation ou de l’impossibilité d’utiliser le service.</p>
          <h2>9. Modification des Conditions</h2><p>Nous pouvons mettre à jour ces Conditions. Les changements importants sont signalés par la date de « Dernière mise à jour ». Continuer à utiliser le service vaut acceptation des Conditions révisées.</p>
          <h2>10. Droit applicable</h2><p>Ces Conditions sont régies par le droit de la République de Corée. Tout litige relève de la compétence exclusive des tribunaux compétents de Corée.</p>
          <h2>11. Contact</h2><p>Pour toute question, écrivez à <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>.</p>`)
      },
      privacy: {
        title: 'Politique de confidentialité – PromptGen',
        html: documentHtml('Politique de confidentialité', 'Date d’entrée en vigueur : 1 mai 2026 · Dernière mise à jour : 20 juillet 2026',
          'Cette traduction est fournie à titre pratique. En cas de divergence avec la version anglaise, celle-ci prévaut dans la mesure autorisée par la loi applicable.', `
          <p>PromptGen (« nous », « notre ») s’engage à protéger vos informations personnelles. Cette politique explique comment nous collectons, utilisons et protégeons vos données sur <strong>promptgen-ai.com</strong>.</p><hr class="divider" />
          <h2>1. Informations collectées</h2><p>Nous collectons :</p><ul><li><strong>Informations de compte :</strong> nom, adresse e-mail et photo reçus de Google OAuth lors de la connexion.</li><li><strong>Données d’utilisation :</strong> nombre d’analyses, offre, solde de crédits, noms d’événements du parcours produit, chemins de pages normalisés, identifiant aléatoire de session d’onglet et horodatages. Les événements d’analyse n’incluent ni URL complète, paramètres, référent brut, prompts, scénarios, images, adresses e-mail ou jetons d’accès.</li><li><strong>Images importées :</strong> images utilisées pour Image vers prompt ou comme références. Les premières sont supprimées après analyse. Les références et grilles peuvent être conservées temporairement dans un stockage privé pour le traitement, l’accès aux résultats et le nettoyage planifié.</li><li><strong>Prompts générés :</strong> ils peuvent être enregistrés dans votre historique.</li><li><strong>Informations de paiement :</strong> les transactions sont entièrement traitées par Paddle ; nous ne stockons pas vos données de carte.</li><li><strong>Journaux :</strong> adresses IP, horodatages et erreurs à des fins de sécurité et de débogage.</li></ul>
          <h2>2. Utilisation des informations</h2><p>Nous utilisons les données pour fournir, maintenir et améliorer le service, gérer le compte, les crédits et l’abonnement, traiter les paiements et prévenir la fraude, appliquer les Conditions et envoyer des communications transactionnelles.</p>
          <h2>3. Services tiers</h2><p>Les services suivants peuvent traiter vos données :</p><ul><li><strong>Google OAuth / Supabase Auth :</strong> authentification, soumise à la politique Google.</li><li><strong>Supabase :</strong> base de données et infrastructure dorsale.</li><li><strong>Google Gemini API :</strong> analyse des images et suggestions de prompts.</li><li><strong>OpenAI API :</strong> modération de sécurité, génération de prompts de plans et de grilles à partir des scénarios, textes et références.</li><li><strong>Paddle :</strong> traitement des paiements, soumis à sa politique de confidentialité.</li><li><strong>Railway :</strong> hébergement.</li><li><strong>Cloudflare :</strong> diffusion et sécurité. Son beacon Web Analytics RUM peut traiter des mesures de performance sans cookie ; il n’utilise ni stockage navigateur ni identifiant persistant et reste séparé de nos événements produit.</li></ul><p>Nous ne vendons pas vos informations personnelles.</p>
          <h2>4. Conservation</h2><ul><li>Les <strong>données de compte</strong> restent conservées tant que le compte est actif.</li><li>Les <strong>images Image vers prompt</strong> sont supprimées après analyse.</li><li>Les <strong>références de storyboard</strong> sont conservées en stockage privé pour le traitement et expirent après 24 heures.</li><li>Les <strong>grilles de storyboard générées</strong> restent disponibles dans l’historique pendant 90 jours après leur création, puis sont supprimées par le nettoyage planifié. L’enregistrement de base de données soft-delete peut subsister jusqu’à 30 jours supplémentaires avant sa suppression définitive.</li><li>L’<strong>historique des prompts</strong> reste jusqu’à sa suppression ou la fermeture du compte.</li><li>Les <strong>paiements</strong> sont conservés selon la loi.</li><li>Les <strong>événements d’analyse internes</strong> sont supprimés automatiquement après 180 jours.</li></ul>
          <h2>5. Vos droits</h2><p>Vous pouvez disposer de droits d’accès, de rectification ou d’effacement. Contactez <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>.</p>
          <h2>6. Sécurité</h2><p>Nous appliquons des mesures raisonnables : HTTPS, authentification JWT, Row Level Security et limitation de débit. Aucune transmission Internet n’est sûre à 100 %.</p>
          <h2>7. Cookies et stockage navigateur</h2><p>Nous n’utilisons ni cookies publicitaires tiers ni identifiants analytiques persistants. L’authentification et l’analyse interne utilisent un stockage limité à la session. L’identifiant analytique est un UUID aléatoire expirant avec l’onglet, non utilisé pour le suivi intersites et non collecté si Do Not Track est activé. La langue choisie est une préférence fonctionnelle locale, jamais associée à l’identifiant analytique ou à un profil de suivi.</p>
          <h2>8. Vie privée des enfants</h2><p>PromptGen ne s’adresse pas aux moins de 13 ans et ne collecte pas sciemment leurs données.</p>
          <h2>9. Modifications</h2><p>Nous pouvons mettre à jour cette politique. Continuer à utiliser le service après une modification vaut acceptation de la nouvelle version.</p>
          <h2>10. Contact</h2><p><strong>E-mail :</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>Site :</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      },
      refund: {
        title: 'Politique de remboursement – PromptGen',
        html: documentHtml('Politique de remboursement', 'Date d’entrée en vigueur : 1 mai 2026 · Dernière mise à jour : 18 juillet 2026',
          'Cette traduction est fournie à titre pratique. En cas de divergence avec la version anglaise, celle-ci prévaut dans la mesure autorisée par la loi applicable.', `
          <div class="highlight-box"><p>Les abonnements PromptGen sont vendus par <strong>Paddle</strong>, notre Merchant of Record. L’éligibilité dépend de la <a href="https://www.paddle.com/legal/refund-policy" rel="noopener noreferrer">politique de remboursement de Paddle</a> et du droit de la consommation applicable. Rien ici ne limite les droits obligatoires de votre pays.</p></div><hr class="divider" />
          <h2>1. Achats d’abonnements</h2><p>Pro et Enterprise sont des abonnements mensuels, pas des lots ponctuels. Pro fournit 1 000 crédits et Enterprise 4 000 par cycle. Au renouvellement, les crédits reviennent au quota et les crédits inutilisés ne sont pas reportés.</p>
          <h2>2. Éligibilité</h2><p>Paddle examine chaque demande. Peuvent notamment s’appliquer les droits légaux de rétractation, les prélèvements en double ou erronés et un défaut technique majeur empêchant l’accès au service acheté. L’utilisation des crédits peut influer sur l’éligibilité lorsque la loi le permet.</p><ul><li>Certains consommateurs disposent d’un délai légal allant jusqu’à 14 jours ; les durées et exceptions varient selon le pays.</li><li>La même commande a été débitée plusieurs fois à cause d’une erreur technique.</li><li>Une erreur de facturation a produit un montant incorrect.</li><li>Un défaut majeur persistant a empêché l’accès aux fonctions décrites lors de l’achat.</li></ul>
          <h2>3. Cas généralement non remboursables</h2><p>Sauf obligation légale ou accord de Paddle, les transactions ne sont généralement pas remboursables. La demande peut être refusée si les crédits ont été utilisés, si elle repose uniquement sur la qualité variable des résultats IA, ou si le compte a été suspendu pour violation des Conditions.</p>
          <h2>4. Demander un remboursement</h2><p>Utilisez les liens « Voir le reçu » ou « Gérer l’abonnement » de l’e-mail Paddle, ou rendez-vous sur <a href="https://paddle.net" rel="noopener noreferrer">paddle.net</a>. Vous pouvez aussi écrire à <a href="mailto:codemeet@naver.com">codemeet@naver.com</a> avec l’e-mail du compte, la date d’achat, l’identifiant de commande du reçu Paddle et une brève description.</p><p>Paddle vérifie l’éligibilité dans ses registres et rembourse, si possible, le moyen de paiement d’origine. Sa politique en vigueur et la loi applicable régissent les délais.</p>
          <h2>5. Prestataire de paiement</h2><p>Paddle est le vendeur et Merchant of Record des abonnements PromptGen. Il gère l’assistance paiement, les résiliations et les remboursements. PromptGen ne stocke pas les données complètes de votre carte.</p>
          <h2>6. Modifications</h2><p>Nous pouvons mettre à jour cette politique. Toute modification apparaîtra dans la date de « Dernière mise à jour ».</p>
          <h2>7. Contact</h2><p><strong>E-mail :</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>Site :</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      }
    },
    ru: {
      terms: {
        title: 'Условия использования – PromptGen',
        html: documentHtml('Условия использования', 'Дата вступления в силу: 1 мая 2026 г. · Последнее обновление: 18 июля 2026 г.',
          'Перевод предоставлен для удобства. При расхождениях с английской версией она имеет преимущественную силу в пределах, допускаемых применимым законодательством.', `
          <p>Добро пожаловать в <strong>PromptGen</strong> («мы», «наш»). Получая доступ к <strong>promptgen-ai.com</strong> или используя его, вы соглашаетесь с настоящими Условиями использования («Условия»). Внимательно прочитайте их до начала работы.</p><hr class="divider" />
          <h2>1. Принятие Условий</h2><p>Создавая аккаунт или используя PromptGen, вы подтверждаете, что вам не менее 13 лет, и принимаете Условия. Если вы действуете от имени организации, то подтверждаете право связать её этими Условиями.</p>
          <h2>2. Описание сервиса</h2><p>PromptGen предоставляет анализ «изображение в промпт», экстрактор последнего кадра и генератор раскадровок, создающий сетку и промпты для внешних видеосервисов, например Seedance. PromptGen сам не генерирует итоговое видео. Доступны:</p><ul><li><strong>Бесплатный тариф:</strong> 1 бесплатный анализ в день.</li><li><strong>Pro:</strong> ежемесячная подписка для одного пользователя с 1 000 кредитов за расчётный цикл.</li><li><strong>Enterprise:</strong> ежемесячная подписка большого объёма для одного пользователя с 4 000 кредитов за цикл. API, командные пространства, собственные модели и управляемая поддержка не включены.</li></ul><p>По текущим ставкам анализ изображения расходует 10 кредитов, раскадровка — 120. При успешном продлении баланс возвращается к квоте тарифа, неиспользованные кредиты не переносятся. Показанный максимум раскадровок рассчитан при условии, что вся квота расходуется только на них.</p>
          <h2>3. Аккаунты</h2><p>Для функций сверх бесплатного уровня нужен вход через Google OAuth. Вы отвечаете за конфиденциальность аккаунта и все действия в нём. Немедленно сообщайте о несанкционированном использовании.</p>
          <h2>4. Допустимое использование</h2><p>Запрещается:</p><ul><li>Загружать незаконные, вредоносные, оскорбительные, клеветнические изображения или нарушать права третьих лиц.</li><li>Загружать откровенно сексуальный, жестокий или иной запрещённый контент.</li><li>Пытаться декомпилировать, собирать данные или иначе злоупотреблять API и моделями ИИ.</li><li>Обходить или злоупотреблять кредитами и ограничением частоты.</li><li>Использовать сервис в незаконных целях.</li></ul><p>Мы можем приостановить или закрыть аккаунт за нарушение Условий.</p>
          <h2>5. Интеллектуальная собственность</h2><p>Права на загруженные изображения остаются у вас. Загружая контент, вы предоставляете нам ограниченную неисключительную лицензию обрабатывать его исключительно для оказания услуги. Созданные промпты можно использовать лично или коммерчески.</p><p>Название, логотип, дизайн и базовая технология PromptGen являются нашей интеллектуальной собственностью и не могут копироваться без письменного разрешения.</p>
          <h2>6. Платежи и кредиты</h2><p>Pro и Enterprise — повторяющиеся ежемесячные подписки, которые продаёт и обрабатывает <strong>Paddle</strong>, наш Merchant of Record и уполномоченный реселлер. Они автоматически продлеваются до отмены. Цены показаны в USD до налогов; Paddle Checkout до покупки показывает итоговую локализованную сумму и налоги.</p><p>Управлять подпиской и отменять её можно в клиентском портале Paddle. Отмена вступает в силу в конце текущего периода. Кредиты не передаются. Возвраты и обязательные права отказа регулируются нашей <a href="/refund.html">Политикой возврата</a>, условиями покупателя и политикой Paddle, а также законом.</p>
          <h2>7. Отказ от гарантий</h2><p>PromptGen предоставляется «как есть» и «по мере доступности», без гарантий. Мы не гарантируем непрерывность, отсутствие ошибок или соответствие промптов вашим требованиям. Результаты ИИ могут различаться.</p>
          <h2>8. Ограничение ответственности</h2><p>В максимальной разрешённой законом степени мы не отвечаем за косвенный, случайный, специальный, последующий или штрафной ущерб из-за использования или невозможности использовать сервис.</p>
          <h2>9. Изменения</h2><p>Мы можем обновлять Условия. О существенных изменениях сообщает дата «Последнее обновление». Продолжая пользоваться сервисом, вы принимаете новую редакцию.</p>
          <h2>10. Применимое право</h2><p>Условия регулируются законодательством Республики Корея. Споры относятся к исключительной юрисдикции компетентных судов Кореи.</p>
          <h2>11. Контакты</h2><p>Вопросы направляйте на <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>.</p>`)
      },
      privacy: {
        title: 'Политика конфиденциальности – PromptGen',
        html: documentHtml('Политика конфиденциальности', 'Дата вступления в силу: 1 мая 2026 г. · Последнее обновление: 20 июля 2026 г.',
          'Перевод предоставлен для удобства. При расхождениях с английской версией она имеет преимущественную силу в пределах, допускаемых применимым законодательством.', `
          <p>PromptGen («мы», «наш») стремится защищать ваши персональные данные. Здесь описано, как мы собираем, используем и защищаем информацию при работе с <strong>promptgen-ai.com</strong>.</p><hr class="divider" />
          <h2>1. Какие данные мы собираем</h2><ul><li><strong>Данные аккаунта:</strong> имя, адрес электронной почты и фото из Google OAuth при входе.</li><li><strong>Данные использования:</strong> число анализов, тариф, баланс, названия событий продуктовой воронки, нормализованные пути страниц, случайный идентификатор сессии вкладки и время действий. События не содержат полных URL, параметров запроса, исходных рефереров, промптов, сценариев, изображений, адресов почты или токенов доступа.</li><li><strong>Загруженные изображения:</strong> изображения для анализа или референсы. Первые удаляются после анализа. Референсы и сетки могут временно храниться в закрытом хранилище для обработки, доступа к результатам и плановой очистки.</li><li><strong>Созданные промпты:</strong> могут сохраняться в истории.</li><li><strong>Платёжные данные:</strong> платежи полностью обрабатывает Paddle; мы не храним реквизиты карт.</li><li><strong>Журналы:</strong> IP-адреса, время запросов и ошибки для безопасности и отладки.</li></ul>
          <h2>2. Как используются данные</h2><p>Для предоставления, поддержки и улучшения сервиса; управления аккаунтом, кредитами и подпиской; обработки платежей и предотвращения мошенничества; исполнения Условий; отправки транзакционных сообщений.</p>
          <h2>3. Сторонние сервисы</h2><ul><li><strong>Google OAuth / Supabase Auth:</strong> аутентификация по политике Google.</li><li><strong>Supabase:</strong> база данных и серверная инфраструктура.</li><li><strong>Google Gemini API:</strong> анализ изображений и предложения промптов.</li><li><strong>OpenAI API:</strong> может получать сценарии, тексты и референсы для проверки безопасности, генерации промптов и сеток.</li><li><strong>Paddle:</strong> обработка платежей по политике Paddle.</li><li><strong>Railway:</strong> хостинг.</li><li><strong>Cloudflare:</strong> доставка и безопасность. Cookie-free Web Analytics RUM может обрабатывать показатели производительности страниц без браузерного хранилища и постоянных идентификаторов, отдельно от нашей продуктовой аналитики.</li></ul><p>Мы не продаём персональные данные.</p>
          <h2>4. Сроки хранения</h2><ul><li><strong>Аккаунт</strong> — пока он активен.</li><li><strong>Изображения для анализа</strong> — удаляются после анализа.</li><li><strong>Референсы раскадровки</strong> хранятся конфиденциально для обработки и истекают через 24 часа.</li><li><strong>Созданные сетки раскадровки</strong> доступны в истории 90 дней с даты создания, после чего удаляются плановой очисткой. Запись базы данных в состоянии soft-delete может сохраняться ещё до 30 дней до окончательного удаления.</li><li><strong>История промптов</strong> — до удаления или закрытия аккаунта.</li><li><strong>Платежи</strong> — в сроки, требуемые законом.</li><li><strong>События собственной аналитики</strong> — 180 дней, затем автоматически удаляются.</li></ul>
          <h2>5. Ваши права</h2><p>Вы можете иметь право на доступ, исправление и удаление данных. Пишите на <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>.</p>
          <h2>6. Безопасность</h2><p>Мы применяем HTTPS, JWT, Row Level Security и ограничение запросов. Ни один способ передачи через интернет не безопасен на 100%.</p>
          <h2>7. Cookie и браузерное хранилище</h2><p>Мы не используем сторонние рекламные cookie или постоянные аналитические идентификаторы. Аутентификация и собственная аналитика используют хранилище в пределах сессии. Аналитический ID — случайный UUID, исчезающий с вкладкой, не используемый для межсайтового отслеживания и не собираемый при Do Not Track. Выбранный язык хранится только как локальная функциональная настройка и не связывается с аналитическим ID или профилем отслеживания.</p>
          <h2>8. Данные детей</h2><p>PromptGen не предназначен для детей младше 13 лет и сознательно не собирает их данные.</p>
          <h2>9. Изменения политики</h2><p>Мы можем обновлять Политику. Продолжение использования означает принятие новой версии.</p>
          <h2>10. Контакты</h2><p><strong>Эл. почта:</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>Сайт:</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      },
      refund: {
        title: 'Политика возврата – PromptGen',
        html: documentHtml('Политика возврата', 'Дата вступления в силу: 1 мая 2026 г. · Последнее обновление: 18 июля 2026 г.',
          'Перевод предоставлен для удобства. При расхождениях с английской версией она имеет преимущественную силу в пределах, допускаемых применимым законодательством.', `
          <div class="highlight-box"><p>Подписки PromptGen продаёт <strong>Paddle</strong>, наш Merchant of Record. Право на возврат определяется <a href="https://www.paddle.com/legal/refund-policy" rel="noopener noreferrer">Политикой возврата Paddle</a> и применимым законодательством о защите потребителей. Ничто здесь не ограничивает обязательные права в вашей стране.</p></div><hr class="divider" />
          <h2>1. Покупка подписки</h2><p>Pro и Enterprise — ежемесячные подписки, а не разовые пакеты. Pro даёт 1 000 кредитов, Enterprise — 4 000 за цикл. При продлении баланс сбрасывается до квоты, остаток не переносится.</p>
          <h2>2. Право на возврат</h2><p>Paddle рассматривает запросы индивидуально. Основания могут включать обязательное право отказа, двойное или ошибочное списание, существенный технический дефект, мешающий доступу к купленной услуге. Использование кредитов может влиять на право, когда это допускается законом.</p><ul><li>У некоторых потребителей есть законный срок отказа до 14 дней; сроки и исключения зависят от страны.</li><li>Один заказ списан несколько раз из-за технической ошибки.</li><li>Ошибка биллинга привела к неправильной сумме.</li><li>Устойчивый существенный дефект не позволил использовать заявленные функции.</li></ul>
          <h2>3. Обычно невозвратные случаи</h2><p>Если закон не требует и Paddle не одобрит иначе, транзакции обычно не возвращаются. Запрос могут отклонить, если кредиты использованы, причина — только переменное качество результата ИИ, либо аккаунт заблокирован за нарушение Условий.</p>
          <h2>4. Как запросить возврат</h2><p>Используйте «Просмотреть чек» или «Управление подпиской» в письме Paddle либо посетите <a href="https://paddle.net" rel="noopener noreferrer">paddle.net</a>. Для продуктовой поддержки напишите на <a href="mailto:codemeet@naver.com">codemeet@naver.com</a>, указав e-mail аккаунта, дату покупки, ID заказа из чека Paddle и краткое описание.</p><p>Paddle проверяет право по записям транзакции и по возможности возвращает средства на исходный способ оплаты. Сроки определяются актуальной политикой Paddle и законом.</p>
          <h2>5. Платёжный оператор</h2><p>Paddle — продавец и Merchant of Record подписок PromptGen, отвечающий за поддержку платежей, отмены и возвраты. PromptGen не хранит полные данные карты.</p>
          <h2>6. Изменения</h2><p>Мы можем обновлять Политику. Изменения отражаются в дате «Последнее обновление».</p>
          <h2>7. Контакты</h2><p><strong>Эл. почта:</strong> <a href="mailto:codemeet@naver.com">codemeet@naver.com</a><br /><strong>Сайт:</strong> <a href="https://promptgen-ai.com">promptgen-ai.com</a></p>`)
      }
    }
  };

  for (const [locale, pages] of Object.entries(documents)) {
    for (const page of Object.values(pages)) {
      page.html = page.html.replace('<!-- operator-details -->', operatorDetailsHtml(locale));
    }
  }

  window.PromptGenLegalDocuments = documents;
})();
