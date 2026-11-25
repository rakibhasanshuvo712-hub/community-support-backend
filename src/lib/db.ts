import bcrypt from 'bcryptjs';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { env, isDatabaseConfigured } from '../config/env.js';

let pool: Pool | null = null;
let migratedPromise: Promise<void> | null = null;

export const DEFAULT_CATEGORIES = [
  { id: 'food', slug: 'food', name_en: 'Food & Groceries', name_bn: 'খাবার ও নিত্যপণ্য', icon: 'utensils', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 1 },
  { id: 'clothes', slug: 'clothes', name_en: 'Clothes & Blankets', name_bn: 'পোশাক ও কম্বল', icon: 'shirt', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 2 },
  { id: 'books', slug: 'books', name_en: 'Books & Study', name_bn: 'বই ও শিক্ষা উপকরণ', icon: 'book-open', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 3 },
  { id: 'furniture', slug: 'furniture', name_en: 'Furniture', name_bn: 'আসবাবপত্র', icon: 'armchair', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 4 },
  { id: 'electronics', slug: 'electronics', name_en: 'Electronics', name_bn: 'ইলেকট্রনিক্স', icon: 'laptop', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 5 },
  {
    id: 'medicine',
    slug: 'medicine',
    name_en: 'Medicine & Medical Aid',
    name_bn: 'ওষুধ ও চিকিৎসা সহায়তা',
    icon: 'pill',
    is_restricted: true,
    restriction_note_en: 'Safety Notice: Only sealed, non-expired, legal over-the-counter items or verified prescriptions may be shared. Never share controlled substances.',
    restriction_note_bn: 'নিরাপত্তা নির্দেশনা: শুধুমাত্র মেয়াদোত্তীর্ণ নয় এমন সিল করা অনুমোদিত ওষুধ বা যাচাইকৃত প্রেসক্রিপশনভিত্তিক সহায়তা শেয়ার করুন। নিষিদ্ধ বা নিয়ন্ত্রিত ওষুধ শেয়ার করা সম্পূর্ণ নিষিদ্ধ।',
    sort_order: 6,
  },
  { id: 'household', slug: 'household', name_en: 'Household Items', name_bn: 'গৃহস্থালি সামগ্রী', icon: 'home', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 7 },
  { id: 'education', slug: 'education', name_en: 'Educational Materials', name_bn: 'শিক্ষা ও প্রশিক্ষণ', icon: 'graduation-cap', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 8 },
  { id: 'financial-aid', slug: 'financial-aid', name_en: 'Direct Financial Support', name_bn: 'সরাসরি আর্থিক সহায়তা', icon: 'hand-coins', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 9 },
  { id: 'volunteer-help', slug: 'volunteer-help', name_en: 'Non-Material & Volunteer Help', name_bn: 'স্বেচ্ছাসেবক ও অন্যান্য সহায়তা', icon: 'heart-handshake', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 10 },
  { id: 'other', slug: 'other', name_en: 'Other Useful Items', name_bn: 'অন্যান্য প্রয়োজনীয় সামগ্রী', icon: 'package', is_restricted: false, restriction_note_en: null, restriction_note_bn: null, sort_order: 11 },
];

export function getPool(): Pool {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    const cleanUrl = env.DATABASE_URL.replace(/([?&])sslmode=[^&]+&?/i, '$1').replace(/[?&]$/, '');
    pool = new Pool({
      connectionString: cleanUrl,
      ssl: { rejectUnauthorized: false },
      max: 10,
    });
  }
  return pool;
}

export async function ensureSchemaMigrated(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (migratedPromise) return migratedPromise;

  migratedPromise = (async () => {
    const p = getPool();
    await p.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        avatar_file_id UUID,
        bio TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
        suspended_reason TEXT,
        preferred_language TEXT NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'bn')),
        location_city TEXT,
        location_area TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS profile_contacts (
        user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        email TEXT,
        phone TEXT,
        exact_address TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name_en TEXT NOT NULL,
        name_bn TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'package',
        is_restricted BOOLEAN NOT NULL DEFAULT FALSE,
        restriction_note_en TEXT,
        restriction_note_bn TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        post_type TEXT NOT NULL CHECK (post_type IN ('donation_offer', 'help_request')),
        donation_type TEXT NOT NULL CHECK (donation_type IN ('money', 'item', 'service')),
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        quantity NUMERIC(12, 2),
        unit TEXT,
        amount NUMERIC(14, 2),
        currency TEXT NOT NULL DEFAULT 'BDT',
        location_city TEXT NOT NULL,
        location_area TEXT,
        urgency TEXT NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'fulfilled', 'closed', 'removed')),
        safety_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMPTZ,
        view_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS post_private_details (
        post_id UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
        exact_handover_address TEXT,
        contact_phone TEXT,
        contact_note TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS file_blobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        bucket TEXT NOT NULL CHECK (bucket IN ('post-images', 'private-documents', 'avatars')),
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS post_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        file_id UUID NOT NULL REFERENCES file_blobs(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS private_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        uploader_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        file_id UUID NOT NULL REFERENCES file_blobs(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS claims (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        claimant_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        claim_type TEXT NOT NULL CHECK (claim_type IN ('offer_to_donate', 'request_item')),
        message TEXT,
        quantity_offered NUMERIC(12, 2),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'completed')),
        donor_confirmed_handover BOOLEAN NOT NULL DEFAULT FALSE,
        recipient_confirmed_handover BOOLEAN NOT NULL DEFAULT FALSE,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_unique_active_per_user
        ON claims(post_id, claimant_id)
        WHERE status IN ('pending', 'accepted');

      CREATE TABLE IF NOT EXISTS contributions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        contributor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL DEFAULT 'BDT',
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pledged' CHECK (status IN ('pledged', 'confirmed', 'cancelled')),
        donor_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        recipient_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_confirmed_both CHECK (
          status <> 'confirmed' OR (donor_confirmed = TRUE AND recipient_confirmed = TRUE)
        )
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        last_read_at TIMESTAMPTZ,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        link TEXT,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('post', 'user', 'dispute')),
        target_post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
        target_user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
        claim_id UUID,
        contribution_id UUID,
        reason TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
        resolution_note TEXT,
        resolved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS moderation_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
        action_type TEXT NOT NULL,
        target_user_id UUID,
        target_post_id UUID,
        report_id UUID,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const cat of DEFAULT_CATEGORIES) {
      await p.query(
        `INSERT INTO categories (id, slug, name_en, name_bn, icon, is_restricted, restriction_note_en, restriction_note_bn, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          cat.id,
          cat.slug,
          cat.name_en,
          cat.name_bn,
          cat.icon,
          cat.is_restricted,
          cat.restriction_note_en,
          cat.restriction_note_bn,
          cat.sort_order,
        ]
      );
    }

    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      const adminEmail = env.ADMIN_EMAIL.toLowerCase().trim();
      const existingAdmin = await p.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [adminEmail]);
      if (existingAdmin.rows.length === 0) {
        const hash = await bcrypt.hash(env.ADMIN_PASSWORD, 10);
        const uRes = await p.query<{ id: string }>(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
          [adminEmail, hash]
        );
        const adminId = uRes.rows[0]!.id;
        await p.query(
          `INSERT INTO profiles (id, full_name, role) VALUES ($1, 'Platform Administrator', 'admin')`,
          [adminId]
        );
        await p.query(
          `INSERT INTO profile_contacts (user_id, email) VALUES ($1, $2)`,
          [adminId, adminEmail]
        );
      } else {
        await p.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [existingAdmin.rows[0]!.id]);
      }
    }
  })().catch((err) => {
    migratedPromise = null;
    throw err;
  });

  return migratedPromise;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  await ensureSchemaMigrated();
  return getPool().query<T>(text, params);
}
