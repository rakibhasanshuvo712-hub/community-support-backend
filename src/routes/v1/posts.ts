import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { getDb, newId } from '../../lib/mongo.js';
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

  const db = await getDb();
  const [claim, contrib] = await Promise.all([
    db.collection('claims').findOne({
      post_id: postId,
      claimant_id: userId,
      status: { $in: ['accepted', 'completed'] },
    }),
    db.collection('contributions').findOne({
      post_id: postId,
      contributor_id: userId,
      status: { $in: ['pledged', 'confirmed'] },
    }),
  ]);

  return Boolean(claim || contrib);
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
      const db = await getDb();

      const filter: Record<string, unknown> = {
        status: query.status ? query.status : { $in: ['active', 'fulfilled'] },
      };
      if (query.post_type) filter.post_type = query.post_type;
      if (query.donation_type) filter.donation_type = query.donation_type;
      if (query.urgency) filter.urgency = query.urgency;
      if (query.category_id) filter.category_id = query.category_id;
      if (query.category_slug) filter.category_id = query.category_slug;
      if (query.city) filter.location_city = { $regex: query.city, $options: 'i' };
      if (query.q) {
        const rx = { $regex: query.q, $options: 'i' };
        filter.$or = [{ title: rx }, { description: rx }, { location_city: rx }];
      }

      const allMatching = await db
        .collection('posts')
        .find(filter, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(200)
        .toArray();

      if (query.sort === 'urgent') {
        const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        allMatching.sort((a, b) => (rank[String(a.urgency)] ?? 9) - (rank[String(b.urgency)] ?? 9));
      } else if (query.sort === 'relevant') {
        allMatching.sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0));
      }

      const total = allMatching.length;
      const offset = (query.page - 1) * query.limit;
      const paged = allMatching.slice(offset, offset + query.limit);

      const [cats, profiles, images] = await Promise.all([
        db.collection('categories').find({}, { projection: { _id: 0 } }).toArray(),
        db
          .collection('profiles')
          .find(
            { id: { $in: paged.map((p) => String(p.author_id)) } },
            { projection: { _id: 0, id: 1, full_name: 1, location_city: 1 } }
          )
          .toArray(),
        db
          .collection('post_images')
          .find(
            { post_id: { $in: paged.map((p) => String(p.id)) } },
            { projection: { _id: 0 } }
          )
          .sort({ sort_order: 1 })
          .toArray(),
      ]);

      const catMap = new Map(cats.map((c) => [String(c.id), c]));
      const profMap = new Map(profiles.map((p) => [String(p.id), p]));
      const baseUrl = `${request.protocol}://${request.headers.host}`;

      const posts = paged.map((post) => {
        const postImgs = images
          .filter((img) => img.post_id === post.id)
          .map((img) => ({
            id: img.id,
            sort_order: img.sort_order,
            url: `${baseUrl}/api/v1/files/${String(img.file_id)}`,
          }));
        return {
          ...post,
          author: profMap.get(String(post.author_id)) ?? null,
          category: catMap.get(String(post.category_id)) ?? null,
          images: postImgs,
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
      const db = await getDb();
      const [rows, cats] = await Promise.all([
        db
          .collection('posts')
          .find({ author_id: userId, status: { $ne: 'removed' } }, { projection: { _id: 0 } })
          .sort({ created_at: -1 })
          .toArray(),
        db.collection('categories').find({}, { projection: { _id: 0 } }).toArray(),
      ]);
      const catMap = new Map(cats.map((c) => [String(c.id), c]));
      return {
        posts: rows.map((p) => ({
          ...p,
          category: catMap.get(String(p.category_id)) ?? null,
        })),
      };
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

      const db = await getDb();
      const category = await db.collection('categories').findOne({ id: body.category_id });
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

      const now = new Date().toISOString();
      const postId = newId();
      const post = {
        id: postId,
        author_id: userId,
        post_type: body.post_type,
        donation_type: body.donation_type,
        category_id: body.category_id,
        title: sanitizeText(body.title),
        description: sanitizeText(body.description),
        quantity: body.quantity ?? null,
        unit: body.unit ? sanitizeText(body.unit) : null,
        amount: body.amount ?? null,
        currency: body.currency.toUpperCase(),
        location_city: sanitizeText(body.location_city),
        location_area: body.location_area ? sanitizeText(body.location_area) : null,
        urgency: body.urgency,
        status: 'active',
        safety_acknowledged: body.safety_acknowledged,
        expires_at: body.expires_at ?? null,
        view_count: 0,
        created_at: now,
        updated_at: now,
      };

      await db.collection('posts').insertOne({ ...post });

      if (body.exact_handover_address || body.contact_phone || body.contact_note) {
        await db.collection('post_private_details').insertOne({
          post_id: postId,
          exact_handover_address: body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null,
          contact_phone: body.contact_phone ? sanitizeText(body.contact_phone) : null,
          contact_note: body.contact_note ? sanitizeText(body.contact_note) : null,
          updated_at: now,
        });
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
      const db = await getDb();
      const post = await db.collection('posts').findOne({ id }, { projection: { _id: 0 } });
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const isOwnerOrAdmin =
        request.authUser?.id === post.author_id || request.authUser?.role === 'admin';
      if (!['active', 'fulfilled'].includes(String(post.status)) && !isOwnerOrAdmin) {
        throw new AppError(404, 'NOT_FOUND', 'Post not available');
      }

      void db.collection('posts').updateOne({ id }, { $inc: { view_count: 1 } });

      const [author, category, rawImages] = await Promise.all([
        db
          .collection('profiles')
          .findOne(
            { id: String(post.author_id) },
            { projection: { _id: 0, id: 1, full_name: 1, bio: 1, location_city: 1, location_area: 1 } }
          ),
        db.collection('categories').findOne({ id: String(post.category_id) }, { projection: { _id: 0 } }),
        db
          .collection('post_images')
          .find({ post_id: id }, { projection: { _id: 0 } })
          .sort({ sort_order: 1 })
          .toArray(),
      ]);

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      const images = rawImages.map((img) => ({
        id: img.id,
        sort_order: img.sort_order,
        url: `${baseUrl}/api/v1/files/${String(img.file_id)}`,
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
        const [priv, docs] = await Promise.all([
          db.collection('post_private_details').findOne({ post_id: id }, { projection: { _id: 0 } }),
          db.collection('private_documents').find({ post_id: id }, { projection: { _id: 0 } }).toArray(),
        ]);
        privateDetails = priv ?? null;
        privateDocuments = docs.map((d) => ({
          id: d.id,
          file_name: d.file_name,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
          signed_url: `${baseUrl}/api/v1/files/${String(d.file_id)}?token=${signFileToken(String(d.file_id))}`,
          created_at: d.created_at,
        }));
      }

      let monetarySummary: { pledged_total: number; confirmed_total: number } | null = null;
      if (post.donation_type === 'money') {
        const contribs = await db
          .collection('contributions')
          .find({ post_id: id, status: { $in: ['pledged', 'confirmed'] } })
          .toArray();
        const pledged = contribs
          .filter((c) => c.status === 'pledged')
          .reduce((sum, c) => sum + Number(c.amount || 0), 0);
        const confirmed = contribs
          .filter((c) => c.status === 'confirmed')
          .reduce((sum, c) => sum + Number(c.amount || 0), 0);
        monetarySummary = { pledged_total: pledged, confirmed_total: confirmed };
      }

      return {
        post: {
          ...post,
          author,
          category,
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

      const db = await getDb();
      const existing = await db.collection('posts').findOne({ id });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only edit your own posts');
      }
      if (existing.status === 'removed' && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'Removed posts cannot be edited');
      }

      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updated_at: now };
      if (body.title !== undefined) updates.title = sanitizeText(body.title);
      if (body.description !== undefined) updates.description = sanitizeText(body.description);
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.unit !== undefined) updates.unit = body.unit ? sanitizeText(body.unit) : null;
      if (body.amount !== undefined) updates.amount = body.amount;
      if (body.currency !== undefined) updates.currency = body.currency.toUpperCase();
      if (body.location_city !== undefined) updates.location_city = sanitizeText(body.location_city);
      if (body.location_area !== undefined) updates.location_area = body.location_area ? sanitizeText(body.location_area) : null;
      if (body.urgency !== undefined) updates.urgency = body.urgency;
      if (body.status !== undefined) updates.status = body.status;
      if (body.expires_at !== undefined) updates.expires_at = body.expires_at;

      await db.collection('posts').updateOne({ id }, { $set: updates });

      if (
        body.exact_handover_address !== undefined ||
        body.contact_phone !== undefined ||
        body.contact_note !== undefined
      ) {
        const privSet: Record<string, unknown> = { updated_at: now };
        if (body.exact_handover_address !== undefined) {
          privSet.exact_handover_address = body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null;
        }
        if (body.contact_phone !== undefined) {
          privSet.contact_phone = body.contact_phone ? sanitizeText(body.contact_phone) : null;
        }
        if (body.contact_note !== undefined) {
          privSet.contact_note = body.contact_note ? sanitizeText(body.contact_note) : null;
        }
        await db.collection('post_private_details').updateOne(
          { post_id: id },
          { $set: privSet, $setOnInsert: { post_id: id } },
          { upsert: true }
        );
      }

      if (body.status && body.status !== existing.status) {
        const claims = await db
          .collection('claims')
          .find({ post_id: id, status: { $in: ['pending', 'accepted'] } })
          .toArray();
        for (const c of claims) {
          await createNotification({
            userId: String(c.claimant_id),
            type: 'post_status_changed',
            title: 'Post status updated',
            body: `"${String(existing.title)}" is now marked as ${body.status}.`,
            link: `/posts/${id}`,
          });
        }
      }

      const updated = await db.collection('posts').findOne({ id }, { projection: { _id: 0 } });
      return { post: updated };
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
      const db = await getDb();
      const existing = await db.collection('posts').findOne({ id });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only delete your own posts');
      }
      await db.collection('posts').deleteOne({ id });
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
      const db = await getDb();
      const post = await db.collection('posts').findOne({ id });
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

      const fileId = newId();
      const now = new Date().toISOString();
      await db.collection('file_blobs').insertOne({
        id: fileId,
        owner_id: userId,
        bucket: 'post-images',
        file_name: file.filename || 'image',
        mime_type: file.mimetype,
        size_bytes: buffer.length,
        data: buffer,
        created_at: now,
      });

      const count = await db.collection('post_images').countDocuments({ post_id: id });
      const imgId = newId();
      await db.collection('post_images').insertOne({
        id: imgId,
        post_id: id,
        file_id: fileId,
        sort_order: count,
        created_at: now,
      });

      const baseUrl = `${request.protocol}://${request.headers.host}`;
      return reply.status(201).send({
        image: {
          id: imgId,
          sort_order: count,
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
      const db = await getDb();
      const post = await db.collection('posts').findOne({ id });
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
      const fileId = newId();
      const now = new Date().toISOString();
      await db.collection('file_blobs').insertOne({
        id: fileId,
        owner_id: userId,
        bucket: 'private-documents',
        file_name: safeName,
        mime_type: file.mimetype,
        size_bytes: buffer.length,
        data: buffer,
        created_at: now,
      });

      const docRecord = {
        id: newId(),
        post_id: id,
        uploader_id: userId,
        file_id: fileId,
        file_name: safeName,
        mime_type: file.mimetype,
        size_bytes: buffer.length,
        created_at: now,
      };
      await db.collection('private_documents').insertOne({ ...docRecord });

      return reply.status(201).send({ document: docRecord });
    }
  );
}
