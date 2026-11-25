import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { getAdminAuth, getDb } from '../lib/firebase.js';
import { isFirebaseConfigured } from '../config/env.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  full_name: string;
  is_suspended: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    accessToken?: string;
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
  if (!isFirebaseConfigured()) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Firebase is not configured yet');
  }

  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication token');
  }

  const db = getDb();
  const profileSnap = await db.collection('profiles').doc(decoded.uid).get();
  if (!profileSnap.exists) {
    throw new AppError(401, 'UNAUTHORIZED', 'User profile not found');
  }

  const profile = profileSnap.data()!;
  if (profile.is_suspended) {
    throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
  }

  return {
    id: decoded.uid,
    email: decoded.email ?? '',
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
