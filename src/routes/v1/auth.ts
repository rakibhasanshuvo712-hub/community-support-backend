import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { sanitizeText } from '../../lib/security.js';
import { supabaseAdmin, supabaseAnon, createSupabaseUserClient } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
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

      const { data, error } = await supabaseAnon.auth.signUp({
        email: body.email.toLowerCase(),
        password: body.password,
        options: {
          data: {
            full_name: sanitizeText(body.full_name),
            preferred_language: body.preferred_language,
          },
        },
      });

      if (error) {
        throw new AppError(400, 'BAD_REQUEST', error.message);
      }

      if (data.user) {
        await supabaseAdmin
          .from('profiles')
          .update({ preferred_language: body.preferred_language })
          .eq('id', data.user.id);
      }

      return reply.status(201).send({
        user: data.user ? { id: data.user.id, email: data.user.email } : null,
        session: data.session
          ? {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
              expires_at: data.session.expires_at,
            }
          : null,
        requires_email_verification: !data.session,
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

      const { data, error } = await supabaseAnon.auth.signInWithPassword({
        email: body.email.toLowerCase(),
        password: body.password,
      });

      if (error || !data.session || !data.user) {
        throw new AppError(401, 'UNAUTHORIZED', error?.message || 'Invalid email or password');
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, is_suspended, preferred_language, avatar_url')
        .eq('id', data.user.id)
        .single();

      if (profile?.is_suspended) {
        throw new AppError(403, 'FORBIDDEN', 'Your account has been suspended');
      }

      return {
        user: {
          id: data.user.id,
          email: data.user.email,
          ...profile,
        },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
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
    async (request) => {
      if (request.accessToken) {
        const userClient = createSupabaseUserClient(request.accessToken);
        await userClient.auth.signOut();
      }
      return { success: true };
    }
  );

  app.post(
    '/reset-password',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Request password reset email',
      },
    },
    async (request) => {
      const body = resetPasswordSchema.parse(request.body);
      const { error } = await supabaseAnon.auth.resetPasswordForEmail(body.email.toLowerCase(), {
        redirectTo: body.redirect_to,
      });

      if (error) {
        throw new AppError(400, 'BAD_REQUEST', error.message);
      }

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
      const [{ data: profile }, { data: contacts }] = await Promise.all([
        supabaseAdmin
          .from('profiles')
          .select('id, full_name, avatar_url, bio, role, is_suspended, preferred_language, location_city, location_area, created_at')
          .eq('id', userId)
          .single(),
        supabaseAdmin
          .from('profile_contacts')
          .select('email, phone, exact_address')
          .eq('user_id', userId)
          .single(),
      ]);

      let avatarSignedUrl: string | null = null;
      if (profile?.avatar_url) {
        const { data: signed } = await supabaseAdmin.storage
          .from('avatars')
          .createSignedUrl(profile.avatar_url, 3600);
        avatarSignedUrl = signed?.signedUrl ?? null;
      }

      return {
        user: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          contacts: contacts ?? { email: request.authUser!.email, phone: null, exact_address: null },
        },
      };
    }
  );
}
