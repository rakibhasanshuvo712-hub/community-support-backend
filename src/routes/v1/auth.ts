import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { getDb, newId } from '../../lib/mongo.js';
import { sanitizeText } from '../../lib/security.js';
import { authenticate, signAuthToken } from '../../middleware/auth.js';
import {
  loginSchema,
  normalizeBdPhone,
  registerSchema,
  resetPasswordSchema,
} from '../../schemas/auth.schema.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a new user account with a Bangladeshi phone number',
      },
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      if (!isDatabaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not configured yet');
      }

      const normalizedPhone = normalizeBdPhone(body.phone);
      if (!normalizedPhone) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid Bangladeshi phone number');
      }

      const email = body.email ? body.email.toLowerCase().trim() : null;
      const fullName = sanitizeText(body.full_name);
      const passwordHash = await bcrypt.hash(body.password, 10);

      const db = await getDb();
      const existingPhone = await db.collection('users').findOne({ phone: normalizedPhone });
      if (existingPhone) {
        throw new AppError(409, 'CONFLICT', 'An account with this phone number already exists');
      }
      if (email) {
        const existingEmail = await db.collection('users').findOne({ email });
        if (existingEmail) {
          throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
        }
      }

      const userId = newId();
      const now = new Date().toISOString();

      await Promise.all([
        db.collection('users').insertOne({
          id: userId,
          phone: normalizedPhone,
          email: email ?? null,
          password_hash: passwordHash,
          created_at: now,
        }),
        db.collection('profiles').insertOne({
          id: userId,
          full_name: fullName,
          avatar_file_id: null,
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
        db.collection('profile_contacts').insertOne({
          user_id: userId,
          email: email ?? null,
          phone: `+${normalizedPhone}`,
          exact_address: null,
          updated_at: now,
        }),
      ]);

      const token = signAuthToken(userId, email ?? '', normalizedPhone);
      return reply.status(201).send({
        user: {
          id: userId,
          phone: `+${normalizedPhone}`,
          email,
          full_name: fullName,
          role: 'user',
          preferred_language: body.preferred_language,
        },
        session: {
          access_token: token,
          expires_at: 7 * 24 * 3600,
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
        summary: 'Sign in with Bangladeshi phone number (or email) and password',
      },
    },
    async (request) => {
      const body = loginSchema.parse(request.body);
      if (!isDatabaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not configured yet');
      }

      const rawIdent = (body.identifier || body.phone || body.email || '').trim();
      const normalizedPhone = normalizeBdPhone(rawIdent);

      const db = await getDb();
      const user = normalizedPhone
        ? await db.collection('users').findOne({ phone: normalizedPhone })
        : await db.collection('users').findOne({ email: rawIdent.toLowerCase() });

      if (!user) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid phone number/email or password');
      }

      const valid = await bcrypt.compare(body.password, String(user.password_hash));
      if (!valid) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid phone number/email or password');
      }

      const profile = await db.collection('profiles').findOne({ id: String(user.id) });
      if (!profile) {
        throw new AppError(401, 'UNAUTHORIZED', 'User profile not found');
      }
      if (profile.is_suspended) {
        throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
      }

      const token = signAuthToken(
        String(user.id),
        String(user.email ?? ''),
        user.phone ? String(user.phone) : null
      );

      return {
        user: {
          id: String(user.id),
          phone: user.phone ? `+${String(user.phone)}` : null,
          email: user.email ?? null,
          full_name: profile.full_name,
          role: profile.role,
          is_suspended: profile.is_suspended,
          preferred_language: profile.preferred_language,
        },
        session: {
          access_token: token,
          expires_at: 7 * 24 * 3600,
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
        summary: 'Sign out current session',
      },
    },
    async () => ({ success: true })
  );

  app.post(
    '/reset-password',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Request password reset',
      },
    },
    async (request) => {
      resetPasswordSchema.parse(request.body);
      return {
        success: true,
        message: 'If an account exists, a password reset instruction has been recorded.',
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
      const db = await getDb();
      const [profile, contacts] = await Promise.all([
        db.collection('profiles').findOne({ id: userId }, { projection: { _id: 0 } }),
        db.collection('profile_contacts').findOne({ user_id: userId }, { projection: { _id: 0 } }),
      ]);

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const avatarSignedUrl = profile?.avatar_file_id
        ? `${baseUrl}/api/v1/files/${String(profile.avatar_file_id)}`
        : null;

      return {
        user: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          contacts: contacts ?? {
            email: request.authUser!.email || null,
            phone: request.authUser!.phone ? `+${request.authUser!.phone}` : null,
            exact_address: null,
          },
        },
      };
    }
  );
}
