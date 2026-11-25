import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb, getSignedReadUrl, uploadBufferToStorage } from '../../lib/firebase.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { updateProfileSchema } from '../../schemas/auth.schema.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export async function profileRoutes(app: FastifyInstance): Promise<void> {
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
      const db = getDb();
      const snap = await db.collection('profiles').doc(id).get();

      if (!snap.exists || snap.data()?.is_suspended) {
        throw new AppError(404, 'NOT_FOUND', 'Profile not found');
      }

      const p = snap.data()!;
      const avatarSignedUrl = p.avatar_url ? await getSignedReadUrl(String(p.avatar_url)) : null;

      const postsSnap = await db
        .collection('posts')
        .where('author_id', '==', id)
        .where('status', 'in', ['active', 'fulfilled'])
        .get();

      return {
        profile: {
          id: snap.id,
          full_name: p.full_name,
          avatar_url: p.avatar_url ?? null,
          avatar_signed_url: avatarSignedUrl,
          bio: p.bio ?? null,
          location_city: p.location_city ?? null,
          location_area: p.location_area ?? null,
          created_at: p.created_at,
          public_posts_count: postsSnap.size,
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

      const db = getDb();
      const now = new Date().toISOString();
      const profileUpdate: Record<string, unknown> = { updated_at: now };

      if (body.full_name !== undefined) profileUpdate.full_name = sanitizeText(body.full_name);
      if (body.bio !== undefined) profileUpdate.bio = body.bio ? sanitizeText(body.bio) : null;
      if (body.preferred_language !== undefined) profileUpdate.preferred_language = body.preferred_language;
      if (body.location_city !== undefined) profileUpdate.location_city = body.location_city ? sanitizeText(body.location_city) : null;
      if (body.location_area !== undefined) profileUpdate.location_area = body.location_area ? sanitizeText(body.location_area) : null;

      await db.collection('profiles').doc(userId).set(profileUpdate, { merge: true });

      const contactUpdate: Record<string, unknown> = { user_id: userId, updated_at: now };
      if (body.phone !== undefined) contactUpdate.phone = body.phone ? sanitizeText(body.phone) : null;
      if (body.exact_address !== undefined) contactUpdate.exact_address = body.exact_address ? sanitizeText(body.exact_address) : null;

      await db.collection('profile_contacts').doc(userId).set(contactUpdate, { merge: true });
      return { success: true };
    }
  );

  app.post(
    '/me/avatar',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Profiles'],
        summary: 'Upload profile avatar photo to Firebase Storage',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const file = await request.file();
      if (!file) throw new AppError(400, 'BAD_REQUEST', 'No file uploaded');
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Only JPEG, PNG, and WebP images are allowed');
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_AVATAR_BYTES) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Avatar image must be 2MB or smaller');
      }

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const storagePath = `avatars/${userId}/avatar.${ext}`;

      await uploadBufferToStorage(storagePath, buffer, file.mimetype);
      await getDb().collection('profiles').doc(userId).update({
        avatar_url: storagePath,
        updated_at: new Date().toISOString(),
      });

      const signedUrl = await getSignedReadUrl(storagePath);
      return {
        avatar_url: storagePath,
        avatar_signed_url: signedUrl,
      };
    }
  );
}
