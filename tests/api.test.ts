import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../src/lib/security.js';
import { AppError } from '../src/lib/errors.js';

// Mock Supabase client for deterministic unit/integration API tests
vi.mock('../src/lib/supabase.js', () => {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
    limit: vi.fn().mockResolvedValue({ data: [{ id: 'cat-1' }], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };

  return {
    supabaseAdmin: {
      from: vi.fn(() => mockChain),
      rpc: vi.fn(),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } }),
      },
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' } }),
        })),
      },
    },
    supabaseAnon: {
      auth: {
        signUp: vi.fn(),
        signInWithPassword: vi.fn(),
        resetPasswordForEmail: vi.fn(),
      },
    },
    createSupabaseUserClient: vi.fn(),
  };
});

describe('Security & Validation Helpers', () => {
  it('blocks sensitive financial data such as CVV, PIN, OTP, and card numbers', () => {
    expect(() => assertNoSensitiveFinancialData('Here is my CVV 123')).toThrow(AppError);
    expect(() => assertNoSensitiveFinancialData('My ATM PIN is 4455')).toThrow(AppError);
    expect(() => assertNoSensitiveFinancialData('Share OTP 998811')).toThrow(AppError);
    expect(() => assertNoSensitiveFinancialData('Card 4532 1234 5678 9012')).toThrow(AppError);
    expect(() => assertNoSensitiveFinancialData('Please meet at Dhanmondi 27 at 5pm')).not.toThrow();
  });

  it('sanitizes angle brackets from user text', () => {
    expect(sanitizeText('  <script>alert(1)</script>Hello  ')).toBe('scriptalert(1)/scriptHello');
  });
});

describe('API Endpoints & Authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/v1/health returns 200 ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('community-support-api');
  });

  it('GET /docs/json returns OpenAPI specification', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBeDefined();
    expect(spec.info.title).toContain('Community Support');
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const app = await buildApp();
    const protectedRequests = [
      { method: 'GET' as const, url: '/api/v1/auth/me' },
      { method: 'POST' as const, url: '/api/v1/posts', payload: {} },
      { method: 'GET' as const, url: '/api/v1/claims/mine' },
      { method: 'GET' as const, url: '/api/v1/contributions/mine' },
      { method: 'GET' as const, url: '/api/v1/conversations' },
      { method: 'GET' as const, url: '/api/v1/notifications' },
      { method: 'GET' as const, url: '/api/v1/admin/stats' },
    ];

    for (const req of protectedRequests) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects invalid token on admin routes with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates login payload with Zod', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
