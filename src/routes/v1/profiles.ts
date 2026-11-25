import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { updateProfileSchema } from '../../schemas/auth.schema.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // Public safe profile (never exposes email, phone, or exact_address)
  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Profiles'],
        summary: 'Get public profile summary (private contacts excluded)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, avatar_url, bio, location_city, location_area, created_at')
        .eq('id', id)
        .eq('is_suspended', false)
        .single();

      if (error || !profile) {
        throw new AppError(404, 'NOT_FOUND', 'Profile not found');
      }

      let avatarSignedUrl: string | null = null;
      if (profile.avatar_url) {
        const { data: signed } = await supabaseAdmin.storage
          .from('avatars')
          .createSignedUrl(profile.avatar_url, 3600);
        avatarSignedUrl = signed?.signedUrl ?? null;
      }

      const { count: postsCount } = await supabaseAdmin
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', id)
        .in('status', ['active', 'fulfilled']);

      return {
        profile: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          public_posts_count: postsCount ?? 0,
        },
      };
    }
  );

  app.patch(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Profiles'],
        summary: 'Update authenticated user profile and private contact details',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const body = updateProfileSchema.parse(request.body);

      assertNoSensitiveFinancialData(body.bio, body.exact_address);

      const profileUpdate: Record<string, unknown> = {};
      if (body.full_name !== undefined) profileUpdate.full_name = sanitizeText(body.full_name);
      if (body.bio !== undefined) profileUpdate.bio = body.bio ? sanitizeText(body.bio) : null;
      if (body.preferred_language !== undefined) profileUpdate.preferred_language = body.preferred_language;
      if (body.location_city !== undefined) profileUpdate.location_city = body.location_city ? sanitizeText(body.location_city) : null;
      if (body.location_area !== undefined) profileUpdate.location_area = body.location_area ? sanitizeText(body.location_area) : null;

      if (Object.keys(profileUpdate).length > 0) {
        const { error } = await supabaseAdmin.from('profiles').update(profileUpdate).eq('id', userId);
        if (error) {
          throw new AppError(500, 'INTERNAL_ERROR', 'Failed to update profile');
        }
      }

      const contactUpdate: Record<string, unknown> = {};
      if (body.phone !== undefined) contactUpdate.phone = body.phone ? sanitizeText(body.phone) : null;
      if (body.exact_address !== undefined) contactUpdate.exact_address = body.exact_address ? sanitizeText(body.exact_address) : null;

      if (Object.keys(contactUpdate).length > 0) {
        const { error } = await supabaseAdmin
          .from('profile_contacts')
          .upsert({ user_id: userId, ...contactUpdate }, { onConflict: 'user_id' });
        if (error) {
          throw new AppError(500, 'INTERNAL_ERROR', 'Failed to update contact details');
        }
      }

      return { success: true };
    }
  );

  app.post(
    '/me/avatar',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Profiles'],
        summary: 'Upload profile avatar photo to private storage',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const file = await request.file();
      if (!file) {
        throw new AppError(400, 'BAD_REQUEST', 'No file uploaded');
      }
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Only JPEG, PNG, and WebP images are allowed');
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_AVATAR_BYTES) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Avatar image must be 2MB or smaller');
      }

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const storagePath = `${userId}/avatar.${ext}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('avatars')
        .upload(storagePath, buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to upload avatar');
      }

      await supabaseAdmin.from('profiles').update({ avatar_url: storagePath }).eq('id', userId);

      const { data: signed } = await supabaseAdmin.storage
        .from('avatars')
        .createSignedUrl(storagePath, 3600);

      return {
        avatar_url: storagePath,
        avatar_signed_url: signed?.signedUrl ?? null,
      };
    }
  );
}
