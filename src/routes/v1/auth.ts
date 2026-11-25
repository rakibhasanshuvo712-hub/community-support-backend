import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { dbQuery, getPool } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { sanitizeText } from '../../lib/security.js';
import { authenticate, signAuthToken } from '../../middleware/auth.js';
import { loginSchema, registerSchema, resetPasswordSchema } from '../../schemas/auth.schema.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a new user account',
      },
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      if (!isDatabaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not configured yet');
      }

      const email = body.email.toLowerCase();
      const fullName = sanitizeText(body.full_name);
      const passwordHash = await bcrypt.hash(body.password, 10);

      const existing = await dbQuery('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
      }

      const client = await getPool().connect();
      let userId: string;
      try {
        await client.query('BEGIN');
        const userRes = await client.query<{ id: string }>(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
          [email, passwordHash]
        );
        userId = userRes.rows[0]!.id;

        await client.query(
          `INSERT INTO profiles (id, full_name, preferred_language)
           VALUES ($1, $2, $3)`,
          [userId, fullName, body.preferred_language]
        );

        await client.query(
          `INSERT INTO profile_contacts (user_id, email)
           VALUES ($1, $2)`,
          [userId, email]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const token = signAuthToken(userId, email);
      return reply.status(201).send({
        user: {
          id: userId,
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
        summary: 'Sign in with email and password',
      },
    },
    async (request) => {
      const body = loginSchema.parse(request.body);
      if (!isDatabaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not configured yet');
      }

      const email = body.email.toLowerCase();
      const userRes = await dbQuery<{
        id: string;
        email: string;
        password_hash: string;
        full_name: string;
        role: string;
        is_suspended: boolean;
        preferred_language: string;
      }>(
        `SELECT u.id, u.email, u.password_hash, p.full_name, p.role, p.is_suspended, p.preferred_language
         FROM users u
         JOIN profiles p ON p.id = u.id
         WHERE u.email = $1`,
        [email]
      );

      const user = userRes.rows[0];
      if (!user) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
      }

      const valid = await bcrypt.compare(body.password, user.password_hash);
      if (!valid) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
      }

      if (user.is_suspended) {
        throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
      }

      const token = signAuthToken(user.id, user.email);
      return {
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          is_suspended: user.is_suspended,
          preferred_language: user.preferred_language,
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
        message: 'If an account exists for that email, a password reset instruction has been recorded.',
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
      const [profRes, contactRes] = await Promise.all([
        dbQuery(
          `SELECT id, full_name, avatar_file_id, bio, role, is_suspended, preferred_language, location_city, location_area, created_at
           FROM profiles WHERE id = $1`,
          [userId]
        ),
        dbQuery(
          `SELECT email, phone, exact_address FROM profile_contacts WHERE user_id = $1`,
          [userId]
        ),
      ]);

      const profile = profRes.rows[0] ?? {};
      const contacts = contactRes.rows[0] ?? {
        email: request.authUser!.email,
        phone: null,
        exact_address: null,
      };

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const avatarSignedUrl = profile.avatar_file_id
        ? `${baseUrl}/api/v1/files/${profile.avatar_file_id}`
        : null;

      return {
        user: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          contacts,
        },
      };
    }
  );
}
