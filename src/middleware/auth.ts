import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { env, isDatabaseConfigured } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { getDb } from '../lib/mongo.js';

export interface AuthUser {
  id: string;
  email: string;
  phone?: string | null;
  role: 'user' | 'admin';
  full_name: string;
  is_suspended: boolean;
}

interface JwtPayload {
  sub: string;
  email: string;
  phone?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    accessToken?: string;
  }
}

export function signAuthToken(userId: string, email: string, phone?: string | null): string {
  return jwt.sign({ sub: userId, email, phone: phone ?? null }, env.JWT_SECRET, { expiresIn: '7d' });
}

export function signFileToken(fileId: string): string {
  return jwt.sign({ fileId, purpose: 'private-file' }, env.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyFileToken(token: string, expectedFileId: string): boolean {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { fileId?: string; purpose?: string };
    return decoded.purpose === 'private-file' && decoded.fileId === expectedFileId;
  } catch {
    return false;
  }
}

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function resolveUserFromToken(token: string): Promise<AuthUser> {
  if (!isDatabaseConfigured()) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not configured yet');
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication token');
  }

  const db = await getDb();
  const profile = await db.collection('profiles').findOne({ id: payload.sub });
  if (!profile) {
    throw new AppError(401, 'UNAUTHORIZED', 'User profile not found');
  }
  if (profile.is_suspended) {
    throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
  }

  return {
    id: String(profile.id),
    email: payload.email ?? '',
    phone: payload.phone ?? null,
    role: profile.role === 'admin' ? 'admin' : 'user',
    full_name: String(profile.full_name || 'Community Member'),
    is_suspended: Boolean(profile.is_suspended),
  };
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication token required');
  }
  request.accessToken = token;
  request.authUser = await resolveUserFromToken(token);
}

export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const token = extractBearerToken(request);
  if (!token) return;
  try {
    request.accessToken = token;
    request.authUser = await resolveUserFromToken(token);
  } catch {
    request.authUser = undefined;
    request.accessToken = undefined;
  }
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await authenticate(request);
  if (request.authUser?.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Administrator privileges required');
  }
}
