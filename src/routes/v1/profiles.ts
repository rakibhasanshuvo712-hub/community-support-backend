import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
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
      const profRes = await dbQuery(
        `SELECT id, full_name, avatar_file_id, bio, location_city, location_area, created_at
         FROM profiles WHERE id = $1 AND is_suspended = FALSE`,
        [id]
      );

      const profile = profRes.rows[0];
      if (!profile) {
        throw new AppError(404, 'NOT_FOUND', 'Profile not found');
      }

      const countRes = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM posts WHERE author_id = $1 AND status IN ('active', 'fulfilled')`,
        [id]
      );

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const avatarSignedUrl = profile.avatar_file_id
        ? `${baseUrl}/api/v1/files/${profile.avatar_file_id}`
        : null;

      return {
        profile: {
          ...profile,
          avatar_signed_url: avatarSignedUrl,
          public_posts_count: Number(countRes.rows[0]?.count ?? 0),
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

      await dbQuery(
        `UPDATE profiles
         SET full_name = COALESCE($1, full_name),
             bio = COALESCE($2, bio),
             preferred_language = COALESCE($3, preferred_language),
             location_city = COALESCE($4, location_city),
             location_area = COALESCE($5, location_area),
             updated_at = NOW()
         WHERE id = $6`,
        [
          body.full_name !== undefined ? sanitizeText(body.full_name) : null,
          body.bio !== undefined ? (body.bio ? sanitizeText(body.bio) : null) : null,
          body.preferred_language ?? null,
          body.location_city !== undefined ? (body.location_city ? sanitizeText(body.location_city) : null) : null,
          body.location_area !== undefined ? (body.location_area ? sanitizeText(body.location_area) : null) : null,
          userId,
        ]
      );

      if (body.phone !== undefined || body.exact_address !== undefined) {
        await dbQuery(
          `INSERT INTO profile_contacts (user_id, phone, exact_address)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE
           SET phone = COALESCE($2, profile_contacts.phone),
               exact_address = COALESCE($3, profile_contacts.exact_address),
               updated_at = NOW()`,
          [
            userId,
            body.phone !== undefined ? (body.phone ? sanitizeText(body.phone) : null) : null,
            body.exact_address !== undefined ? (body.exact_address ? sanitizeText(body.exact_address) : null) : null,
          ]
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

      const blobRes = await dbQuery<{ id: string }>(
        `INSERT INTO file_blobs (owner_id, bucket, file_name, mime_type, size_bytes, data)
         VALUES ($1, 'avatars', $2, $3, $4, $5)
         RETURNING id`,
        [userId, file.filename || 'avatar', file.mimetype, buffer.length, buffer]
      );

      const fileId = blobRes.rows[0]!.id;
      await dbQuery('UPDATE profiles SET avatar_file_id = $1, updated_at = NOW() WHERE id = $2', [
        fileId,
        userId,
      ]);

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      return {
        avatar_url: fileId,
        avatar_signed_url: `${baseUrl}/api/v1/files/${fileId}`,
      };
    }
  );
}
