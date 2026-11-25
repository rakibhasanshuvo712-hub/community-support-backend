import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';

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
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication token');
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_suspended')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile) {
    throw new AppError(401, 'UNAUTHORIZED', 'User profile not found');
  }

  if (profile.is_suspended) {
    throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
  }

  return {
    id: profile.id,
    email: data.user.email ?? '',
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
    // Guest fallback when optional auth token is invalid/expired
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
