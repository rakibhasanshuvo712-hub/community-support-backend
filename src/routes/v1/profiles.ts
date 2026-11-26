import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb, newId } from '../../lib/mongo.js';
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
      const db = await getDb();
      const profile = await db.collection('profiles').findOne(
        { id, is_suspended: false },
        {
          projection: {
            _id: 0,
            id: 1,
            full_name: 1,
            avatar_file_id: 1,
            bio: 1,
            location_city: 1,
            location_area: 1,
            created_at: 1,
          },
        }
      );

      if (!profile) {
        throw new AppError(404, 'NOT_FOUND', 'Profile not found');
      }

      const publicPostsCount = await db.collection('posts').countDocuments({
        author_id: id,
        status: { $in: ['active', 'fulfilled'] },
      });

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const avatarSignedUrl = profile.avatar_file_id
        ? `${baseUrl}/api/v1/files/${String(profile.avatar_file_id)}`
        : null;

      return {
        profile: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          public_posts_count: publicPostsCount,
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

      const db = await getDb();
      const now = new Date().toISOString();
      const profileSet: Record<string, unknown> = { updated_at: now };
      if (body.full_name !== undefined) profileSet.full_name = sanitizeText(body.full_name);
      if (body.bio !== undefined) profileSet.bio = body.bio ? sanitizeText(body.bio) : null;
      if (body.preferred_language !== undefined) profileSet.preferred_language = body.preferred_language;
      if (body.location_city !== undefined) profileSet.location_city = body.location_city ? sanitizeText(body.location_city) : null;
      if (body.location_area !== undefined) profileSet.location_area = body.location_area ? sanitizeText(body.location_area) : null;

      await db.collection('profiles').updateOne({ id: userId }, { $set: profileSet });

      if (body.phone !== undefined || body.exact_address !== undefined) {
        const contactSet: Record<string, unknown> = { updated_at: now };
        if (body.phone !== undefined) contactSet.phone = body.phone ? sanitizeText(body.phone) : null;
        if (body.exact_address !== undefined) contactSet.exact_address = body.exact_address ? sanitizeText(body.exact_address) : null;
        await db.collection('profile_contacts').updateOne(
          { user_id: userId },
          { $set: contactSet, $setOnInsert: { user_id: userId } },
          { upsert: true }
        );
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
        summary: 'Upload profile avatar photo',
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

      const db = await getDb();
      const fileId = newId();
      await db.collection('file_blobs').insertOne({
        id: fileId,
        owner_id: userId,
        bucket: 'avatars',
        file_name: file.filename || 'avatar',
        mime_type: file.mimetype,
        size_bytes: buffer.length,
        data: buffer,
        created_at: new Date().toISOString(),
      });

      await db.collection('profiles').updateOne(
        { id: userId },
        { $set: { avatar_file_id: fileId, updated_at: new Date().toISOString() } }
      );

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      return {
        avatar_url: fileId,
        avatar_signed_url: `${baseUrl}/api/v1/files/${fileId}`,
      };
    }
  );
}
