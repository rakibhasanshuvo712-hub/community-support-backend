import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
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

async function signPostImages(images: Array<{ id: string; storage_path: string; sort_order: number }>) {
  if (!images || images.length === 0) return [];
  const signed = await Promise.all(
    images.map(async (img) => {
      const { data } = await supabaseAdmin.storage
        .from('post-images')
        .createSignedUrl(img.storage_path, 3600);
      return {
        id: img.id,
        sort_order: img.sort_order,
        url: data?.signedUrl ?? null,
      };
    })
  );
  return signed.sort((a, b) => a.sort_order - b.sort_order);
}

async function isAuthorizedForPrivatePostDetails(postId: string, authorId: string, userId?: string, role?: string): Promise<boolean> {
  if (!userId) return false;
  if (userId === authorId || role === 'admin') return true;

  const [{ data: claim }, { data: contribution }] = await Promise.all([
    supabaseAdmin
      .from('claims')
      .select('id')
      .eq('post_id', postId)
      .eq('claimant_id', userId)
      .in('status', ['accepted', 'completed'])
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('contributions')
      .select('id')
      .eq('post_id', postId)
      .eq('contributor_id', userId)
      .in('status', ['pledged', 'confirmed'])
      .limit(1)
      .maybeSingle(),
  ]);

  return Boolean(claim || contribution);
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  // List & search posts with filters and pagination
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
      const query = listPostsQuerySchema.parse(request.query);
      const from = (query.page - 1) * query.limit;
      const to = from + query.limit - 1;

      let categoryId = query.category_id;
      if (!categoryId && query.category_slug) {
        const { data: cat } = await supabaseAdmin
          .from('categories')
          .select('id')
          .eq('slug', query.category_slug)
          .maybeSingle();
        if (cat) {
          categoryId = cat.id;
        } else {
          return { posts: [], pagination: { page: query.page, limit: query.limit, total: 0, total_pages: 0 } };
        }
      }

      let dbQuery = supabaseAdmin
        .from('posts')
        .select(
          `
          id, author_id, post_type, donation_type, category_id, title, description,
          quantity, unit, amount, currency, location_city, location_area, urgency,
          status, safety_acknowledged, expires_at, view_count, created_at, updated_at,
          author:profiles!posts_author_id_fkey(id, full_name, avatar_url, location_city),
          category:categories!posts_category_id_fkey(id, slug, name_en, name_bn, icon, is_restricted),
          images:post_images(id, storage_path, sort_order)
        `,
          { count: 'exact' }
        );

      if (query.status) {
        dbQuery = dbQuery.eq('status', query.status);
      } else {
        dbQuery = dbQuery.in('status', ['active', 'fulfilled']);
      }

      if (query.post_type) dbQuery = dbQuery.eq('post_type', query.post_type);
      if (query.donation_type) dbQuery = dbQuery.eq('donation_type', query.donation_type);
      if (query.urgency) dbQuery = dbQuery.eq('urgency', query.urgency);
      if (categoryId) dbQuery = dbQuery.eq('category_id', categoryId);
      if (query.city) dbQuery = dbQuery.ilike('location_city', `%${query.city}%`);
      if (query.q) {
        const safeQ = query.q.replace(/[%_,]/g, '');
        dbQuery = dbQuery.or(`title.ilike.%${safeQ}%,description.ilike.%${safeQ}%,location_city.ilike.%${safeQ}%`);
      }

      if (query.sort === 'urgent') {
        dbQuery = dbQuery.order('urgency', { ascending: true }).order('created_at', { ascending: false });
      } else if (query.sort === 'relevant') {
        dbQuery = dbQuery.order('view_count', { ascending: false }).order('created_at', { ascending: false });
      } else {
        dbQuery = dbQuery.order('created_at', { ascending: false });
      }

      const { data, error, count } = await dbQuery.range(from, to);

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch posts');
      }

      const posts = await Promise.all(
        (data ?? []).map(async (post) => ({
          ...post,
          images: await signPostImages((post.images as Array<{ id: string; storage_path: string; sort_order: number }>) ?? []),
        }))
      );

      const total = count ?? 0;
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

  // Get current user's posts
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
      const { data, error } = await supabaseAdmin
        .from('posts')
        .select(
          `
          id, author_id, post_type, donation_type, category_id, title, description,
          quantity, unit, amount, currency, location_city, location_area, urgency,
          status, safety_acknowledged, expires_at, view_count, created_at, updated_at,
          category:categories!posts_category_id_fkey(id, slug, name_en, name_bn, icon, is_restricted),
          images:post_images(id, storage_path, sort_order)
        `
        )
        .eq('author_id', userId)
        .neq('status', 'removed')
        .order('created_at', { ascending: false });

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch your posts');
      }

      const posts = await Promise.all(
        (data ?? []).map(async (post) => ({
          ...post,
          images: await signPostImages((post.images as Array<{ id: string; storage_path: string; sort_order: number }>) ?? []),
        }))
      );

      return { posts };
    }
  );

  // Create a post (published immediately after validation)
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

      const { data: category, error: catError } = await supabaseAdmin
        .from('categories')
        .select('id, slug, is_restricted')
        .eq('id', body.category_id)
        .single();

      if (catError || !category) {
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

      const { data: post, error: insertError } = await supabaseAdmin
        .from('posts')
        .insert({
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
        })
        .select()
        .single();

      if (insertError || !post) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to create post');
      }

      if (body.exact_handover_address || body.contact_phone || body.contact_note) {
        await supabaseAdmin.from('post_private_details').upsert({
          post_id: post.id,
          exact_handover_address: body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null,
          contact_phone: body.contact_phone ? sanitizeText(body.contact_phone) : null,
          contact_note: body.contact_note ? sanitizeText(body.contact_note) : null,
        });
      }

      return reply.status(201).send({ post });
    }
  );

  // Get post details (publicly safe; private contact details & docs gated)
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
      const { data: post, error } = await supabaseAdmin
        .from('posts')
        .select(
          `
          id, author_id, post_type, donation_type, category_id, title, description,
          quantity, unit, amount, currency, location_city, location_area, urgency,
          status, safety_acknowledged, expires_at, view_count, created_at, updated_at,
          author:profiles!posts_author_id_fkey(id, full_name, avatar_url, bio, location_city, location_area),
          category:categories!posts_category_id_fkey(id, slug, name_en, name_bn, icon, is_restricted, restriction_note_en, restriction_note_bn),
          images:post_images(id, storage_path, sort_order)
        `
        )
        .eq('id', id)
        .single();

      if (error || !post) {
        throw new AppError(404, 'NOT_FOUND', 'Post not found');
      }

      const isOwnerOrAdmin =
        request.authUser?.id === post.author_id || request.authUser?.role === 'admin';

      if (!['active', 'fulfilled'].includes(post.status) && !isOwnerOrAdmin) {
        throw new AppError(404, 'NOT_FOUND', 'Post not available');
      }

      // Increment view count asynchronously
      void supabaseAdmin
        .from('posts')
        .update({ view_count: (post.view_count ?? 0) + 1 })
        .eq('id', id);

      const signedImages = await signPostImages(
        (post.images as Array<{ id: string; storage_path: string; sort_order: number }>) ?? []
      );

      // Private contact & documents ONLY if authorized
      const authorizedForPrivate = await isAuthorizedForPrivatePostDetails(
        id,
        post.author_id,
        request.authUser?.id,
        request.authUser?.role
      );

      let privateDetails: Record<string, unknown> | null = null;
      let privateDocuments: Array<Record<string, unknown>> = [];

      if (authorizedForPrivate) {
        const [{ data: priv }, { data: docs }] = await Promise.all([
          supabaseAdmin
            .from('post_private_details')
            .select('exact_handover_address, contact_phone, contact_note')
            .eq('post_id', id)
            .maybeSingle(),
          supabaseAdmin
            .from('private_documents')
            .select('id, file_name, mime_type, size_bytes, storage_path, created_at')
            .eq('post_id', id),
        ]);

        privateDetails = priv ?? null;
        if (docs && docs.length > 0) {
          privateDocuments = await Promise.all(
            docs.map(async (doc) => {
              const { data: signed } = await supabaseAdmin.storage
                .from('private-documents')
                .createSignedUrl(doc.storage_path, 900);
              return {
                id: doc.id,
                file_name: doc.file_name,
                mime_type: doc.mime_type,
                size_bytes: doc.size_bytes,
                signed_url: signed?.signedUrl ?? null,
                created_at: doc.created_at,
              };
            })
          );
        }
      }

      // Aggregate monetary pledged/confirmed summary without exposing personal donor details
      let monetarySummary: { pledged_total: number; confirmed_total: number } | null = null;
      if (post.donation_type === 'money') {
        const { data: contribs } = await supabaseAdmin
          .from('contributions')
          .select('amount, status')
          .eq('post_id', id)
          .in('status', ['pledged', 'confirmed']);

        const pledgedTotal = (contribs ?? [])
          .filter((c) => c.status === 'pledged')
          .reduce((sum, c) => sum + Number(c.amount), 0);
        const confirmedTotal = (contribs ?? [])
          .filter((c) => c.status === 'confirmed')
          .reduce((sum, c) => sum + Number(c.amount), 0);

        monetarySummary = {
          pledged_total: pledgedTotal,
          confirmed_total: confirmedTotal,
        };
      }

      return {
        post: {
          ...post,
          images: signedImages,
          monetary_summary: monetarySummary,
          can_view_private_details: authorizedForPrivate,
          private_details: privateDetails,
          private_documents: privateDocuments,
        },
      };
    }
  );

  // Update own post
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

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('posts')
        .select('id, author_id, status, title')
        .eq('id', id)
        .single();

      if (fetchErr || !existing) {
        throw new AppError(404, 'NOT_FOUND', 'Post not found');
      }
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only edit your own posts');
      }
      if (existing.status === 'removed' && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'Removed posts cannot be edited');
      }

      const updateFields: Record<string, unknown> = {};
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

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('posts')
        .update(updateFields)
        .eq('id', id)
        .select()
        .single();

      if (updateErr) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to update post');
      }

      if (
        body.exact_handover_address !== undefined ||
        body.contact_phone !== undefined ||
        body.contact_note !== undefined
      ) {
        await supabaseAdmin.from('post_private_details').upsert({
          post_id: id,
          ...(body.exact_handover_address !== undefined
            ? { exact_handover_address: body.exact_handover_address ? sanitizeText(body.exact_handover_address) : null }
            : {}),
          ...(body.contact_phone !== undefined
            ? { contact_phone: body.contact_phone ? sanitizeText(body.contact_phone) : null }
            : {}),
          ...(body.contact_note !== undefined
            ? { contact_note: body.contact_note ? sanitizeText(body.contact_note) : null }
            : {}),
        });
      }

      // Notify active participants if status changed
      if (body.status && body.status !== existing.status) {
        const { data: claims } = await supabaseAdmin
          .from('claims')
          .select('claimant_id')
          .eq('post_id', id)
          .in('status', ['pending', 'accepted']);

        for (const c of claims ?? []) {
          await createNotification({
            userId: c.claimant_id,
            type: 'post_status_changed',
            title: 'Post status updated',
            body: `"${existing.title}" is now marked as ${body.status}.`,
            link: `/posts/${id}`,
          });
        }
      }

      return { post: updated };
    }
  );

  // Delete own post
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

      const { data: existing } = await supabaseAdmin
        .from('posts')
        .select('id, author_id')
        .eq('id', id)
        .single();

      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Post not found');
      }
      if (existing.author_id !== userId && request.authUser!.role !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'You can only delete your own posts');
      }

      const { error } = await supabaseAdmin.from('posts').delete().eq('id', id);
      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to delete post');
      }

      return { success: true };
    }
  );

  // Upload post image to private bucket
  app.post<{ Params: { id: string } }>(
    '/:id/images',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Posts'],
        summary: 'Upload an image for a post (private storage, served via signed URL)',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const { data: post } = await supabaseAdmin
        .from('posts')
        .select('id, author_id')
        .eq('id', id)
        .single();

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

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const storagePath = `${userId}/${id}/${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabaseAdmin.storage
        .from('post-images')
        .upload(storagePath, buffer, { contentType: file.mimetype });

      if (uploadErr) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to upload image');
      }

      const { data: imageRecord, error: dbErr } = await supabaseAdmin
        .from('post_images')
        .insert({ post_id: id, storage_path: storagePath })
        .select()
        .single();

      if (dbErr || !imageRecord) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to save image metadata');
      }

      const { data: signed } = await supabaseAdmin.storage
        .from('post-images')
        .createSignedUrl(storagePath, 3600);

      return reply.status(201).send({
        image: {
          id: imageRecord.id,
          sort_order: imageRecord.sort_order,
          url: signed?.signedUrl ?? null,
        },
      });
    }
  );

  // Upload private supporting document
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

      const { data: post } = await supabaseAdmin
        .from('posts')
        .select('id, author_id')
        .eq('id', id)
        .single();

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
      const storagePath = `${userId}/${id}/${Date.now()}-${safeName}`;

      const { error: uploadErr } = await supabaseAdmin.storage
        .from('private-documents')
        .upload(storagePath, buffer, { contentType: file.mimetype });

      if (uploadErr) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to upload document');
      }

      const { data: docRecord, error: dbErr } = await supabaseAdmin
        .from('private_documents')
        .insert({
          post_id: id,
          uploader_id: userId,
          storage_path: storagePath,
          file_name: safeName,
          mime_type: file.mimetype,
          size_bytes: buffer.length,
        })
        .select()
        .single();

      if (dbErr || !docRecord) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to save document metadata');
      }

      return reply.status(201).send({ document: docRecord });
    }
  );
}
