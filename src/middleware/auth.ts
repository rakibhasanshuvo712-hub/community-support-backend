import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { env, isDatabaseConfigured } from '../config/env.js';
import { dbQuery } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  full_name: string;
  is_suspended: boolean;
}

interface JwtPayload {
  sub: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    accessToken?: string;
  }
}

export function signAuthToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, env.JWT_SECRET, { expiresIn: '7d' });
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

  const res = await dbQuery<{
    id: string;
    role: string;
    full_name: string;
    is_suspended: boolean;
  }>('SELECT id, role, full_name, is_suspended FROM profiles WHERE id = $1', [payload.sub]);

  const profile = res.rows[0];
  if (!profile) {
    throw new AppError(401, 'UNAUTHORIZED', 'User profile not found');
  }
  if (profile.is_suspended) {
    throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
  }

  return {
    id: profile.id,
    email: payload.email,
    role: profile.role === 'admin' ? 'admin' : 'user',
    full_name: profile.full_name,
    is_suspended: profile.is_suspended,
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
