import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate, optionalAuth, signFileToken } from '../../middleware/auth.js';
import {
  createPostSchema,
  listPostsQuerySchema,
  updatePostSchema,
} from '../../schemas/posts.schema.js';
import { createNotification } from '../../services/notifications.service.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

async function isAuthorizedForPrivatePostDetails(
  postId: string,
  authorId: string,
  userId?: string,
  role?: string
): Promise<boolean> {
  if (!userId) return false;
  if (userId === authorId || role === 'admin') return true;

  const [claimsRes, contribRes] = await Promise.all([
    dbQuery(
      `SELECT id FROM claims WHERE post_id = $1 AND claimant_id = $2 AND status IN ('accepted', 'completed') LIMIT 1`,
      [postId, userId]
    ),
    dbQuery(
      `SELECT id FROM contributions WHERE post_id = $1 AND contributor_id = $2 AND status IN ('pledged', 'confirmed') LIMIT 1`,
      [postId, userId]
    ),
  ]);

  return claimsRes.rows.length > 0 || contribRes.rows.length > 0;
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      preHandler: [optionalAuth],
      schema: {
        tags: ['Posts'],
        summary: 'Search and filter donation offers and help requests',
      },
    },
    async (request) => {
      if (!isDatabaseConfigured()) {
        return {
          posts: [],
          pagination: { page: 1, limit: 12, total: 0, total_pages: 0 },
        };
      }

      const query = listPostsQuerySchema.parse(request.query);
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.status) {
        params.push(query.status);
        conditions.push(`p.status = $${params.length}`);
      } else {
        conditions.push(`p.status IN ('active', 'fulfilled')`);
      }

      if (query.post_type) {
        params.push(query.post_type);
        conditions.push(`p.post_type = $${params.length}`);
      }
      if (query.donation_type) {
        params.push(query.donation_type);
        conditions.push(`p.donation_type = $${params.length}`);
      }
      if (query.urgency) {
        params.push(query.urgency);
        conditions.push(`p.urgency = $${params.length}`);
      }
      if (query.category_id) {
        params.push(query.category_id);
        conditions.push(`p.category_id = $${params.length}`);
      }
      if (query.category_slug) {
        params.push(query.category_slug);
        conditions.push(`c.slug = $${params.length}`);
      }
      if (query.city) {
        params.push(`%${query.city}%`);
        conditions.push(`p.location_city ILIKE $${params.length}`);
      }
      if (query.q) {
        params.push(`%${query.q}%`);
        conditions.push(
          `(p.title ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.location_city ILIKE $${params.length})`
        );
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause =
        query.sort === 'urgent'
          ? `ORDER BY CASE p.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC, p.created_at DESC`
          : query.sort === 'relevant'
            ? `ORDER BY p.view_count DESC, p.created_at DESC`
            : `ORDER BY p.created_at DESC`;

      const countRes = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM posts p JOIN categories c ON c.id = p.category_id ${whereClause}`,
        params
      );
      const total = Number(countRes.rows[0]?.count ?? 0);

      const offset = (query.page - 1) * query.limit;
      const listParams = [...params, query.limit, offset];

      const listRes = await dbQuery(
        `SELECT p.*,
                json_build_object('id', pr.id, 'full_name', pr.full_name, 'location_city', pr.location_city) AS author,
                json_build_object('id', c.id, 'slug', c.slug, 'name_en', c.name_en, 'name_bn', c.name_bn, 'icon', c.icon, 'is_restricted', c.is_restricted) AS category,
                COALESCE(
                  (SELECT json_agg(json_build_object('id', pi.id, 'file_id', pi.file_id, 'sort_order', pi.sort_order) ORDER BY pi.sort_order ASC)
                   FROM post_images pi WHERE pi.post_id = p.id),
                  '[]'::json
                ) AS raw_images
         FROM posts p
         JOIN profiles pr ON pr.id = p.author_id
         JOIN categories c ON c.id = p.category_id
         ${whereClause}
         ${orderClause}
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      );

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const posts = listRes.rows.map((row) => {
        const rawImages = (row.raw_images as Array<{ id: string; file_id: string; sort_order: number }>) ?? [];
        const rest = { ...row };
        delete rest.raw_images;
        return {
          ...rest,
          images: rawImages.map((img) => ({
            id: img.id,
            sort_order: img.sort_order,
            url: `${baseUrl}/api/v1/files/${img.file_id}`,
          })),
        };
      });

      return {
        posts,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          total_pages: Math.ceil(total / query.limit),
        },
      };
    }
  );

  app.get(
    '/mine',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'List all posts created by the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const res = await dbQuery(
        `SELECT p.*,
                json_build_object('id', c.id, 'slug', c.slug, 'name_en', c.name_en, 'name_bn', c.name_bn, 'icon', c.icon, 'is_restricted', c.is_restricted) AS category
         FROM posts p
         JOIN categories c ON c.id = p.category_id
         WHERE p.author_id = $1 AND p.status <> 'removed'
         ORDER BY p.created_at DESC`,
        [userId]
      );
      return { posts: res.rows };
    }
  );

  app.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Create a new donation offer or help request post',
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const body = createPostSchema.parse(request.body);

      assertNoSensitiveFinancialData(
        body.title,
        body.description,
        body.exact_handover_address,
        body.contact_note
      );

      const catRes = await dbQuery<{ id: string; is_restricted: boolean }>(
        'SELECT id, is_restricted FROM categories WHERE id = $1',
        [body.category_id]
      );
      const category = catRes.rows[0];
      if (!category) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid category selected');
      }
      if (category.is_restricted && !body.safety_acknowledged) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'You must acknowledge the medicine safety guidelines before publishing in this category.'
        );
      }
      if (body.donation_type === 'money' && !body.amount) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Target or offered amount is required for monetary posts');
      }

      const insertRes = await dbQuery<{ id: string }>(
        `INSERT INTO posts (
          author_id, post_type, donation_type, category_id, title, description,
          quantity, unit, amount, currency, location_city, location_area,
          urgency, status, safety_acknowledged, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,$15)
        RETURNING *`,
        [
          userId,
          body.post_type,
          body.donation_type,
          body.category_id,
          sanitizeText(body.title),
          sanitizeText(body.description),
          body.quantity ?? null,
          body.unit ? sanitizeText(body.unit) : null,
          body.amount ?? null,
          body.currency.toUpperCase(),
          sanitizeText(body.location_city),
          body.location_area ? sanitizeText(body.location_area) : null,
          body.urgency,
          body.safety_acknowledged,
          body.expires_at ?? null,
        ]
      );

      const post = insertRes.rows[0]!;
      if (body.exact_handover_address || body.contact_phone || body.contact_note) {
        await dbQuery(
          `INSERT INTO post_private_details (post_id, exact_handover_address, contact_phone, contact_note)
           VALUES ($1, $2, $3, $4)`,
          [
            post.id,
            body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null,
            body.contact_phone ? sanitizeText(body.contact_phone) : null,
            body.contact_note ? sanitizeText(body.contact_note) : null,
          ]
        );
      }

      return reply.status(201).send({ post });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [optionalAuth],
      schema: {
        tags: ['Posts'],
        summary: 'Get post details (private contact info excluded unless authorized)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const res = await dbQuery(
        `SELECT p.*,
                json_build_object('id', pr.id, 'full_name', pr.full_name, 'bio', pr.bio, 'location_city', pr.location_city, 'location_area', pr.location_area) AS author,
                json_build_object('id', c.id, 'slug', c.slug, 'name_en', c.name_en, 'name_bn', c.name_bn, 'icon', c.icon, 'is_restricted', c.is_restricted, 'restriction_note_en', c.restriction_note_en, 'restriction_note_bn', c.restriction_note_bn) AS category
         FROM posts p
         JOIN profiles pr ON pr.id = p.author_id
         JOIN categories c ON c.id = p.category_id
         WHERE p.id = $1`,
        [id]
      );

      const post = res.rows[0];
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const isOwnerOrAdmin =
        request.authUser?.id === post.author_id || request.authUser?.role === 'admin';
      if (!['active', 'fulfilled'].includes(String(post.status)) && !isOwnerOrAdmin) {
        throw new AppError(404, 'NOT_FOUND', 'Post not available');
      }

      void dbQuery('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [id]);

      const imgRes = await dbQuery<{ id: string; file_id: string; sort_order: number }>(
        'SELECT id, file_id, sort_order FROM post_images WHERE post_id = $1 ORDER BY sort_order ASC',
        [id]
      );

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const images = imgRes.rows.map((img) => ({
        id: img.id,
        sort_order: img.sort_order,
        url: `${baseUrl}/api/v1/files/${img.file_id}`,
      }));

      const authorizedForPrivate = await isAuthorizedForPrivatePostDetails(
        id,
        String(post.author_id),
        request.authUser?.id,
        request.authUser?.role
      );

      let privateDetails: Record<string, unknown> | null = null;
      let privateDocuments: Array<Record<string, unknown>> = [];

      if (authorizedForPrivate) {
        const [privRes, docsRes] = await Promise.all([
          dbQuery(
            'SELECT exact_handover_address, contact_phone, contact_note FROM post_private_details WHERE post_id = $1',
            [id]
          ),
          dbQuery(
            'SELECT id, file_id, file_name, mime_type, size_bytes, created_at FROM private_documents WHERE post_id = $1',
            [id]
          ),
        ]);
        privateDetails = privRes.rows[0] ?? null;
        privateDocuments = docsRes.rows.map((d) => ({
          id: d.id,
          file_name: d.file_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
          signed_url: `${baseUrl}/api/v1/files/${d.file_id}?token=${signFileToken(String(d.file_id))}`,
          created_at: d.created_at,
        }));
      }

      let monetarySummary: { pledged_total: number; confirmed_total: number } | null = null;
      if (post.donation_type === 'money') {
        const sumRes = await dbQuery<{ status: string; total: string }>(
          `SELECT status, COALESCE(SUM(amount), 0)::text AS total
           FROM contributions
           WHERE post_id = $1 AND status IN ('pledged', 'confirmed')
           GROUP BY status`,
          [id]
        );
        const pledged = Number(sumRes.rows.find((r) => r.status === 'pledged')?.total ?? 0);
        const confirmed = Number(sumRes.rows.find((r) => r.status === 'confirmed')?.total ?? 0);
        monetarySummary = { pledged_total: pledged, confirmed_total: confirmed };
      }

      return {
        post: {
          ...post,
          images,
          monetary_summary: monetarySummary,
          can_view_private_details: authorizedForPrivate,
          private_details: privateDetails,
          private_documents: privateDocuments,
        },
      };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Update, pause, close, or mark fulfilled your own post',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const body = updatePostSchema.parse(request.body);

      assertNoSensitiveFinancialData(
        body.title,
        body.description,
        body.exact_handover_address,
        body.contact_note
      );

      const existingRes = await dbQuery<{ id: string; author_id: string; status: string; title: string }>(
        'SELECT id, author_id, status, title FROM posts WHERE id = $1',
        [id]
      );
      const existing = existingRes.rows[0];
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only edit your own posts');
      }
      if (existing.status === 'removed' && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'Removed posts cannot be edited');
      }

      const updatedRes = await dbQuery(
        `UPDATE posts
         SET title = COALESCE($1, title),
             description = COALESCE($2, description),
             quantity = COALESCE($3, quantity),
             unit = COALESCE($4, unit),
             amount = COALESCE($5, amount),
             currency = COALESCE($6, currency),
             location_city = COALESCE($7, location_city),
             location_area = COALESCE($8, location_area),
             urgency = COALESCE($9, urgency),
             status = COALESCE($10, status),
             expires_at = COALESCE($11, expires_at),
             updated_at = NOW()
         WHERE id = $12
         RETURNING *`,
        [
          body.title !== undefined ? sanitizeText(body.title) : null,
          body.description !== undefined ? sanitizeText(body.description) : null,
          body.quantity ?? null,
          body.unit !== undefined ? (body.unit ? sanitizeText(body.unit) : null) : null,
          body.amount ?? null,
          body.currency ? body.currency.toUpperCase() : null,
          body.location_city !== undefined ? sanitizeText(body.location_city) : null,
          body.location_area !== undefined ? (body.location_area ? sanitizeText(body.location_area) : null) : null,
          body.urgency ?? null,
          body.status ?? null,
          body.expires_at ?? null,
          id,
        ]
      );

      if (
        body.exact_handover_address !== undefined ||
        body.contact_phone !== undefined ||
        body.contact_note !== undefined
      ) {
        await dbQuery(
          `INSERT INTO post_private_details (post_id, exact_handover_address, contact_phone, contact_note)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (post_id) DO UPDATE
           SET exact_handover_address = COALESCE($2, post_private_details.exact_handover_address),
               contact_phone = COALESCE($3, post_private_details.contact_phone),
               contact_note = COALESCE($4, post_private_details.contact_note),
               updated_at = NOW()`,
          [
            id,
            body.exact_handover_address !== undefined ? (body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null) : null,
            body.contact_phone !== undefined ? (body.contact_phone ? sanitizeText(body.contact_phone) : null) : null,
            body.contact_note !== undefined ? (body.contact_note ? sanitizeText(body.contact_note) : null) : null,
          ]
        );
      }

      if (body.status && body.status !== existing.status) {
        const claimsRes = await dbQuery<{ claimant_id: string }>(
          `SELECT claimant_id FROM claims WHERE post_id = $1 AND status IN ('pending', 'accepted')`,
          [id]
        );
        for (const c of claimsRes.rows) {
          await createNotification({
            userId: c.claimant_id,
            type: 'post_status_changed',
            title: 'Post status updated',
            body: `"${existing.title}" is now marked as ${body.status}.`,
            link: `/posts/${id}`,
          });
        }
      }

      return { post: updatedRes.rows[0] };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Delete your own post',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const existingRes = await dbQuery<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1', [id]);
      const existing = existingRes.rows[0];
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only delete your own posts');
      }
      await dbQuery('DELETE FROM posts WHERE id = $1', [id]);
      return { success: true };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/:id/images',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Upload an image for a post',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const postRes = await dbQuery<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1', [id]);
      const post = postRes.rows[0];
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can upload images');

      const file = await request.file();
      if (!file) throw new AppError(400, 'BAD_REQUEST', 'No image file provided');
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Only JPEG, PNG, and WebP images are allowed');
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Image must be 5MB or smaller');
      }

      const blobRes = await dbQuery<{ id: string }>(
        `INSERT INTO file_blobs (owner_id, bucket, file_name, mime_type, size_bytes, data)
         VALUES ($1, 'post-images', $2, $3, $4, $5)
         RETURNING id`,
        [userId, file.filename || 'image', file.mimetype, buffer.length, buffer]
      );
      const fileId = blobRes.rows[0]!.id;

      const imgRes = await dbQuery<{ id: string; sort_order: number }>(
        `INSERT INTO post_images (post_id, file_id, sort_order)
         VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM post_images WHERE post_id = $1))
         RETURNING id, sort_order`,
        [id, fileId]
      );

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      return reply.status(201).send({
        image: {
          id: imgRes.rows[0]!.id,
          sort_order: imgRes.rows[0]!.sort_order,
          url: `${baseUrl}/api/v1/files/${fileId}`,
        },
      });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/:id/documents',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Upload a private supporting document for a post',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const postRes = await dbQuery<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1', [id]);
      const post = postRes.rows[0];
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can upload documents');

      const file = await request.file();
      if (!file) throw new AppError(400, 'BAD_REQUEST', 'No document provided');
      if (!ALLOWED_DOC_TYPES.has(file.mimetype)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Only PDF, JPEG, PNG, and WebP files are allowed');
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_DOC_BYTES) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Document must be 10MB or smaller');
      }

      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const blobRes = await dbQuery<{ id: string }>(
        `INSERT INTO file_blobs (owner_id, bucket, file_name, mime_type, size_bytes, data)
         VALUES ($1, 'private-documents', $2, $3, $4, $5)
         RETURNING id`,
        [userId, safeName, file.mimetype, buffer.length, buffer]
      );
      const fileId = blobRes.rows[0]!.id;

      const docRes = await dbQuery(
        `INSERT INTO private_documents (post_id, uploader_id, file_id, file_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, post_id, uploader_id, file_id, file_name, mime_type, size_bytes, created_at`,
        [id, userId, fileId, safeName, file.mimetype, buffer.length]
      );

      return reply.status(201).send({ document: docRes.rows[0] });
    }
  );
}
