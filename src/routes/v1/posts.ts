import type { FastifyInstance } from 'fastify';
import { isFirebaseConfigured } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { getDb, getSignedReadUrl, uploadBufferToStorage } from '../../lib/firebase.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import {
  createPostSchema,
  listPostsQuerySchema,
  updatePostSchema,
} from '../../schemas/posts.schema.js';
import { createNotification } from '../../services/notifications.service.js';
import { ensureCategoriesSeeded } from '../../services/seed.service.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

interface StoredImage {
  id: string;
  storage_path: string;
  sort_order: number;
}

async function signPostImages(images: StoredImage[]) {
  if (!images || images.length === 0) return [];
  const signed = await Promise.all(
    images.map(async (img) => ({
      id: img.id,
      sort_order: img.sort_order,
      url: await getSignedReadUrl(img.storage_path),
    }))
  );
  return signed.sort((a, b) => a.sort_order - b.sort_order);
}

async function isAuthorizedForPrivatePostDetails(
  postId: string,
  authorId: string,
  userId?: string,
  role?: string
): Promise<boolean> {
  if (!userId) return false;
  if (userId === authorId || role === 'admin') return true;

  const db = getDb();
  const [claimsSnap, contribSnap] = await Promise.all([
    db
      .collection('claims')
      .where('post_id', '==', postId)
      .where('claimant_id', '==', userId)
      .where('status', 'in', ['accepted', 'completed'])
      .limit(1)
      .get(),
    db
      .collection('contributions')
      .where('post_id', '==', postId)
      .where('contributor_id', '==', userId)
      .where('status', 'in', ['pledged', 'confirmed'])
      .limit(1)
      .get(),
  ]);

  return !claimsSnap.empty || !contribSnap.empty;
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
      if (!isFirebaseConfigured()) {
        return {
          posts: [],
          pagination: { page: 1, limit: 12, total: 0, total_pages: 0 },
        };
      }

      await ensureCategoriesSeeded();
      const query = listPostsQuerySchema.parse(request.query);
      const db = getDb();

      const snap = await db
        .collection('posts')
        .where('status', 'in', query.status ? [query.status] : ['active', 'fulfilled'])
        .orderBy('created_at', 'desc')
        .limit(200)
        .get();

      let items = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));

      if (query.post_type) items = items.filter((p) => p.post_type === query.post_type);
      if (query.donation_type) items = items.filter((p) => p.donation_type === query.donation_type);
      if (query.urgency) items = items.filter((p) => p.urgency === query.urgency);
      if (query.category_id) items = items.filter((p) => p.category_id === query.category_id);
      if (query.category_slug) items = items.filter((p) => p.category_id === query.category_slug);
      if (query.city) {
        const c = query.city.toLowerCase();
        items = items.filter((p) => String(p.location_city || '').toLowerCase().includes(c));
      }
      if (query.q) {
        const qLower = query.q.toLowerCase();
        items = items.filter(
          (p) =>
            String(p.title || '').toLowerCase().includes(qLower) ||
            String(p.description || '').toLowerCase().includes(qLower) ||
            String(p.location_city || '').toLowerCase().includes(qLower)
        );
      }

      if (query.sort === 'urgent') {
        const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        items.sort((a, b) => (rank[String(a.urgency)] ?? 9) - (rank[String(b.urgency)] ?? 9));
      } else if (query.sort === 'relevant') {
        items.sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0));
      }

      const total = items.length;
      const start = (query.page - 1) * query.limit;
      const paged = items.slice(start, start + query.limit);

      const catSnap = await db.collection('categories').get();
      const catMap = new Map(catSnap.docs.map((c) => [c.id, { id: c.id, ...c.data() }]));

      const posts = await Promise.all(
        paged.map(async (post) => ({
          ...post,
          category: catMap.get(String(post.category_id)) ?? null,
          images: await signPostImages((post.images as StoredImage[]) ?? []),
        }))
      );

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
      const db = getDb();
      const snap = await db
        .collection('posts')
        .where('author_id', '==', userId)
        .orderBy('created_at', 'desc')
        .get();

      const catSnap = await db.collection('categories').get();
      const catMap = new Map(catSnap.docs.map((c) => [c.id, { id: c.id, ...c.data() }]));

      const posts = await Promise.all(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>))
          .filter((p) => p.status !== 'removed')
          .map(async (post) => ({
            ...post,
            category: catMap.get(String(post.category_id)) ?? null,
            images: await signPostImages((post.images as StoredImage[]) ?? []),
          }))
      );

      return { posts };
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

      await ensureCategoriesSeeded();
      const db = getDb();
      const catSnap = await db.collection('categories').doc(body.category_id).get();
      if (!catSnap.exists) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid category selected');
      }

      const category = catSnap.data()!;
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
      const postRef = db.collection('posts').doc();
      const postDoc = {
        id: postRef.id,
        author_id: userId,
        author: {
          id: userId,
          full_name: request.authUser!.full_name,
        },
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
        images: [],
        created_at: now,
        updated_at: now,
      };

      await postRef.set(postDoc);

      if (body.exact_handover_address || body.contact_phone || body.contact_note) {
        await db.collection('post_private_details').doc(postRef.id).set({
          post_id: postRef.id,
          exact_handover_address: body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null,
          contact_phone: body.contact_phone ? sanitizeText(body.contact_phone) : null,
          contact_note: body.contact_note ? sanitizeText(body.contact_note) : null,
          updated_at: now,
        });
      }

      return reply.status(201).send({ post: postDoc });
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
      if (!isFirebaseConfigured()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Firebase is not configured yet');
      }

      const { id } = request.params;
      const db = getDb();
      const snap = await db.collection('posts').doc(id).get();

      if (!snap.exists) {
        throw new AppError(404, 'NOT_FOUND', 'Post not found');
      }

      const post = { id: snap.id, ...snap.data() } as Record<string, unknown>;
      const isOwnerOrAdmin =
        request.authUser?.id === post.author_id || request.authUser?.role === 'admin';

      if (!['active', 'fulfilled'].includes(String(post.status)) && !isOwnerOrAdmin) {
        throw new AppError(404, 'NOT_FOUND', 'Post not available');
      }

      void db
        .collection('posts')
        .doc(id)
        .update({ view_count: Number(post.view_count || 0) + 1 });

      const [catSnap, authorSnap, signedImages] = await Promise.all([
        db.collection('categories').doc(String(post.category_id)).get(),
        db.collection('profiles').doc(String(post.author_id)).get(),
        signPostImages((post.images as StoredImage[]) ?? []),
      ]);

      const authorizedForPrivate = await isAuthorizedForPrivatePostDetails(
        id,
        String(post.author_id),
        request.authUser?.id,
        request.authUser?.role
      );

      let privateDetails: Record<string, unknown> | null = null;
      let privateDocuments: Array<Record<string, unknown>> = [];

      if (authorizedForPrivate) {
        const [privSnap, docsSnap] = await Promise.all([
          db.collection('post_private_details').doc(id).get(),
          db.collection('private_documents').where('post_id', '==', id).get(),
        ]);
        privateDetails = privSnap.exists ? (privSnap.data() as Record<string, unknown>) : null;
        privateDocuments = await Promise.all(
          docsSnap.docs.map(async (d) => {
            const docData = d.data();
            return {
              id: d.id,
              file_name: docData.file_name,
              mime_type: docData.mime_type,
              size_bytes: docData.size_bytes,
              signed_url: await getSignedReadUrl(String(docData.storage_path), 900),
              created_at: docData.created_at,
            };
          })
        );
      }

      let monetarySummary: { pledged_total: number; confirmed_total: number } | null = null;
      if (post.donation_type === 'money') {
        const contribsSnap = await db
          .collection('contributions')
          .where('post_id', '==', id)
          .where('status', 'in', ['pledged', 'confirmed'])
          .get();

        const pledgedTotal = contribsSnap.docs
          .filter((d) => d.data().status === 'pledged')
          .reduce((sum, d) => sum + Number(d.data().amount || 0), 0);
        const confirmedTotal = contribsSnap.docs
          .filter((d) => d.data().status === 'confirmed')
          .reduce((sum, d) => sum + Number(d.data().amount || 0), 0);

        monetarySummary = { pledged_total: pledgedTotal, confirmed_total: confirmedTotal };
      }

      return {
        post: {
          ...post,
          category: catSnap.exists ? { id: catSnap.id, ...catSnap.data() } : null,
          author: authorSnap.exists
            ? {
                id: authorSnap.id,
                full_name: authorSnap.data()?.full_name,
                location_city: authorSnap.data()?.location_city ?? null,
              }
            : post.author,
          images: signedImages,
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

      const db = getDb();
      const postRef = db.collection('posts').doc(id);
      const snap = await postRef.get();
      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const existing = snap.data()!;
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only edit your own posts');
      }
      if (existing.status === 'removed' && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'Removed posts cannot be edited');
      }

      const now = new Date().toISOString();
      const updateFields: Record<string, unknown> = { updated_at: now };
      if (body.title !== undefined) updateFields.title = sanitizeText(body.title);
      if (body.description !== undefined) updateFields.description = sanitizeText(body.description);
      if (body.quantity !== undefined) updateFields.quantity = body.quantity;
      if (body.unit !== undefined) updateFields.unit = body.unit ? sanitizeText(body.unit) : null;
      if (body.amount !== undefined) updateFields.amount = body.amount;
      if (body.currency !== undefined) updateFields.currency = body.currency.toUpperCase();
      if (body.location_city !== undefined) updateFields.location_city = sanitizeText(body.location_city);
      if (body.location_area !== undefined) updateFields.location_area = body.location_area ? sanitizeText(body.location_area) : null;
      if (body.urgency !== undefined) updateFields.urgency = body.urgency;
      if (body.status !== undefined) updateFields.status = body.status;
      if (body.expires_at !== undefined) updateFields.expires_at = body.expires_at;

      await postRef.update(updateFields);

      if (
        body.exact_handover_address !== undefined ||
        body.contact_phone !== undefined ||
        body.contact_note !== undefined
      ) {
        await db.collection('post_private_details').doc(id).set(
          {
            post_id: id,
            updated_at: now,
            ...(body.exact_handover_address !== undefined
              ? { exact_handover_address: body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null }
              : {}),
            ...(body.contact_phone !== undefined
              ? { contact_phone: body.contact_phone ? sanitizeText(body.contact_phone) : null }
              : {}),
            ...(body.contact_note !== undefined
              ? { contact_note: body.contact_note ? sanitizeText(body.contact_note) : null }
              : {}),
          },
          { merge: true }
        );
      }

      if (body.status && body.status !== existing.status) {
        const claimsSnap = await db
          .collection('claims')
          .where('post_id', '==', id)
          .where('status', 'in', ['pending', 'accepted'])
          .get();

        for (const c of claimsSnap.docs) {
          await createNotification({
            userId: String(c.data().claimant_id),
            type: 'post_status_changed',
            title: 'Post status updated',
            body: `"${existing.title}" is now marked as ${body.status}.`,
            link: `/posts/${id}`,
          });
        }
      }

      const updatedSnap = await postRef.get();
      return { post: { id: updatedSnap.id, ...updatedSnap.data() } };
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
      const db = getDb();
      const postRef = db.collection('posts').doc(id);
      const snap = await postRef.get();

      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (snap.data()!.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only delete your own posts');
      }

      await postRef.delete();
      return { success: true };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/:id/images',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Upload an image for a post to private Firebase Storage',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const db = getDb();
      const postRef = db.collection('posts').doc(id);
      const postSnap = await postRef.get();

      if (!postSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (postSnap.data()!.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the post owner can upload images');
      }

      const file = await request.file();
      if (!file) throw new AppError(400, 'BAD_REQUEST', 'No image file provided');
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Only JPEG, PNG, and WebP images are allowed');
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Image must be 5MB or smaller');
      }

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const imageId = `${Date.now()}`;
      const storagePath = `post-images/${userId}/${id}/${imageId}.${ext}`;

      await uploadBufferToStorage(storagePath, buffer, file.mimetype);

      const existingImages = (postSnap.data()!.images as StoredImage[]) ?? [];
      const newImage: StoredImage = {
        id: imageId,
        storage_path: storagePath,
        sort_order: existingImages.length,
      };
      await postRef.update({
        images: [...existingImages, newImage],
        updated_at: new Date().toISOString(),
      });

      return reply.status(201).send({
        image: {
          id: newImage.id,
          sort_order: newImage.sort_order,
          url: await getSignedReadUrl(storagePath),
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
      const db = getDb();
      const postSnap = await db.collection('posts').doc(id).get();

      if (!postSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (postSnap.data()!.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the post owner can upload documents');
      }

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
      const storagePath = `private-documents/${userId}/${id}/${Date.now()}-${safeName}`;

      await uploadBufferToStorage(storagePath, buffer, file.mimetype);

      const docRef = db.collection('private_documents').doc();
      const docRecord = {
        id: docRef.id,
        post_id: id,
        uploader_id: userId,
        storage_path: storagePath,
        file_name: safeName,
        mime_type: file.mimetype,
        size_bytes: buffer.length,
        created_at: new Date().toISOString(),
      };
      await docRef.set(docRecord);

      return reply.status(201).send({ document: docRecord });
    }
  );
}
