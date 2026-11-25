import type { FastifyInstance } from 'fastify';
import { env, isFirebaseConfigured } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { getAdminAuth, getDb, getSignedReadUrl } from '../../lib/firebase.js';
import { sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { loginSchema, registerSchema, resetPasswordSchema } from '../../schemas/auth.schema.js';

async function firebaseIdentityToolkit(endpoint: string, payload: Record<string, unknown>) {
  if (!env.FIREBASE_WEB_API_KEY) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'FIREBASE_WEB_API_KEY is not configured');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (data.error as { message?: string } | undefined)?.message || 'Authentication failed';
    throw new AppError(400, 'BAD_REQUEST', errMsg);
  }
  return data;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a new user account with Firebase Auth',
      },
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      if (!isFirebaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Firebase is not configured yet');
      }
      const email = body.email.toLowerCase();
      const fullName = sanitizeText(body.full_name);

      const result = await firebaseIdentityToolkit('signUp', {
        email,
        password: body.password,
        returnSecureToken: true,
      });

      const uid = String(result.localId);
      const idToken = String(result.idToken);
      const refreshToken = String(result.refreshToken);
      const now = new Date().toISOString();

      await getAdminAuth().updateUser(uid, { displayName: fullName });

      const db = getDb();
      await Promise.all([
        db.collection('profiles').doc(uid).set({
          id: uid,
          full_name: fullName,
          avatar_url: null,
          bio: null,
          role: 'user',
          is_suspended: false,
          suspended_reason: null,
          preferred_language: body.preferred_language,
          location_city: null,
          location_area: null,
          created_at: now,
          updated_at: now,
        }),
        db.collection('profile_contacts').doc(uid).set({
          user_id: uid,
          email,
          phone: null,
          exact_address: null,
          updated_at: now,
        }),
      ]);

      return reply.status(201).send({
        user: {
          id: uid,
          email,
          full_name: fullName,
          role: 'user',
          preferred_language: body.preferred_language,
        },
        session: {
          access_token: idToken,
          refresh_token: refreshToken,
          expires_at: Number(result.expiresIn || 3600),
        },
        requires_email_verification: false,
      });
    }
  );

  app.post(
    '/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with email and password via Firebase Auth',
      },
    },
    async (request) => {
      const body = loginSchema.parse(request.body);
      if (!isFirebaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Firebase is not configured yet');
      }
      const result = await firebaseIdentityToolkit('signInWithPassword', {
        email: body.email.toLowerCase(),
        password: body.password,
        returnSecureToken: true,
      });

      const uid = String(result.localId);
      const db = getDb();
      const profileSnap = await db.collection('profiles').doc(uid).get();
      const profile = profileSnap.data();

      if (profile?.is_suspended) {
        throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
      }

      return {
        user: {
          id: uid,
          email: String(result.email || body.email.toLowerCase()),
          ...profile,
        },
        session: {
          access_token: String(result.idToken),
          refresh_token: String(result.refreshToken),
          expires_at: Number(result.expiresIn || 3600),
        },
      };
    }
  );

  app.post(
    '/logout',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Revoke refresh tokens for current user',
      },
    },
    async (request) => {
      await getAdminAuth().revokeRefreshTokens(request.authUser!.id);
      return { success: true };
    }
  );

  app.post(
    '/reset-password',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Send Firebase password reset email',
      },
    },
    async (request) => {
      const body = resetPasswordSchema.parse(request.body);
      if (!isFirebaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Firebase is not configured yet');
      }
      await firebaseIdentityToolkit('sendOobCode', {
        requestType: 'PASSWORD_RESET',
        email: body.email.toLowerCase(),
      });

      return {
        success: true,
        message: 'If an account exists for that email, a password reset link has been sent.',
      };
    }
  );

  app.get(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Get authenticated user profile and private contacts',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const db = getDb();
      const [profileSnap, contactSnap] = await Promise.all([
        db.collection('profiles').doc(userId).get(),
        db.collection('profile_contacts').doc(userId).get(),
      ]);

      const profile = profileSnap.data() ?? {};
      const contacts = contactSnap.data() ?? {
        email: request.authUser!.email,
        phone: null,
        exact_address: null,
      };

      const avatarSignedUrl = profile.avatar_url
        ? await getSignedReadUrl(String(profile.avatar_url))
        : null;

      return {
        user: {
          ...profile,
          id: userId,
          avatar_signed_url: avatarSignedUrl,
          contacts: {
            email: contacts.email ?? request.authUser!.email,
            phone: contacts.phone ?? null,
            exact_address: contacts.exact_address ?? null,
          },
        },
      };
    }
  );
}
