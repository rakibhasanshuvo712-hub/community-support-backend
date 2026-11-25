import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../src/lib/security.js';
import { AppError } from '../src/lib/errors.js';

vi.mock('../src/lib/firebase.js', () => ({
  getAdminAuth: vi.fn(() => ({
    verifyIdToken: vi.fn().mockRejectedValue(new Error('Invalid token')),
    updateUser: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  })),
  getDb: vi.fn(() => ({
    collection: vi.fn(() => ({
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    })),
  })),
  getSignedReadUrl: vi.fn().mockResolvedValue(null),
  uploadBufferToStorage: vi.fn(),
}));

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

  it('GET /api/v1/health returns 200 ok with firebase provider', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('firebase');
  });

  it('GET /api/v1/categories returns default categories', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.json().categories.length).toBe(11);
  });

  it('GET /docs/json returns OpenAPI specification', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBeDefined();
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
