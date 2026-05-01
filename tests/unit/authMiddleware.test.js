/**
 * auth 미들웨어 유닛 테스트
 * Supabase를 mock 처리하여 순수 미들웨어 로직만 테스트
 */

// Supabase 클라이언트 모킹
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn()
}));

const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../../middleware/auth');

// 헬퍼: mock request 생성
function makeReq(authHeader) {
  return { headers: { authorization: authHeader } };
}

// 헬퍼: mock response 생성
function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  let next;

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  });

  test('Authorization 헤더가 없으면 401을 반환해야 한다', async () => {
    const req = makeReq(undefined);
    const res = makeRes();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'AUTH_REQUIRED'
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('Bearer 형식이 아닌 헤더는 401을 반환해야 한다', async () => {
    const req = makeReq('Basic sometoken');
    const res = makeRes();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('유효하지 않은 토큰이면 401을 반환해야 한다', async () => {
    const mockGetUser = jest.fn().mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT', status: 401 }
    });
    createClient.mockReturnValue({
      auth: { getUser: mockGetUser }
    });

    const req = makeReq('Bearer invalid-token');
    const res = makeRes();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'AUTH_INVALID'
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('유효한 토큰이면 req.user와 req.supabase를 설정하고 next()를 호출해야 한다', async () => {
    const mockUser = { id: 'user-123', email: 'test@example.com' };
    const mockGetUser = jest.fn().mockResolvedValue({
      data: { user: mockUser },
      error: null
    });
    createClient.mockReturnValue({
      auth: { getUser: mockGetUser }
    });

    const req = makeReq('Bearer valid-token');
    const res = makeRes();

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(mockUser);
    expect(req.supabase).toBeDefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('user가 null이면 401을 반환해야 한다', async () => {
    const mockGetUser = jest.fn().mockResolvedValue({
      data: { user: null },
      error: null
    });
    createClient.mockReturnValue({
      auth: { getUser: mockGetUser }
    });

    const req = makeReq('Bearer token-without-user');
    const res = makeRes();

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('Supabase 연결 오류 시 에러가 전파되어야 한다', async () => {
    const mockGetUser = jest.fn().mockRejectedValue(new Error('Network error'));
    createClient.mockReturnValue({
      auth: { getUser: mockGetUser }
    });

    const req = makeReq('Bearer some-token');
    const res = makeRes();

    // 미들웨어가 에러를 throw하거나 next(err)를 호출
    await expect(authMiddleware(req, res, next)).rejects.toThrow('Network error');
    expect(next).not.toHaveBeenCalled();
  });
});
