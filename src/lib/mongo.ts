import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { MongoClient, type Db } from 'mongodb';
import { env, isDatabaseConfigured } from '../config/env.js';

let client: MongoClient | null = null;
let readyPromise: Promise<void> | null = null;

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

export function newId(): string {
  return crypto.randomUUID();
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!isDatabaseConfigured()) {
    throw new Error('MONGODB_URI is not configured');
  }
  if (!client) {
    client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
  }
  return client;
}

export async function getDb(): Promise<Db> {
  const c = await getMongoClient();
  const db = c.db('community_support');
  await ensureMongoReady(db);
  return db;
}

export async function ensureMongoReady(db: Db): Promise<void> {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    await Promise.all([
      db.collection('users').createIndex({ phone: 1 }, { unique: true, sparse: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true }),
      db.collection('profiles').createIndex({ id: 1 }, { unique: true }),
      db.collection('profile_contacts').createIndex({ user_id: 1 }, { unique: true }),
      db.collection('categories').createIndex({ id: 1 }, { unique: true }),
      db.collection('posts').createIndex({ id: 1 }, { unique: true }),
      db.collection('posts').createIndex({ status: 1, created_at: -1 }),
      db.collection('posts').createIndex({ author_id: 1, created_at: -1 }),
      db.collection('post_private_details').createIndex({ post_id: 1 }, { unique: true }),
      db.collection('post_images').createIndex({ post_id: 1, sort_order: 1 }),
      db.collection('private_documents').createIndex({ post_id: 1 }),
      db.collection('file_blobs').createIndex({ id: 1 }, { unique: true }),
      db.collection('claims').createIndex({ id: 1 }, { unique: true }),
      db.collection('claims').createIndex({ post_id: 1, claimant_id: 1 }),
      db.collection('contributions').createIndex({ id: 1 }, { unique: true }),
      db.collection('conversations').createIndex({ id: 1 }, { unique: true }),
      db.collection('conversations').createIndex({ participant_ids: 1, updated_at: -1 }),
      db.collection('messages').createIndex({ conversation_id: 1, created_at: 1 }),
      db.collection('notifications').createIndex({ user_id: 1, created_at: -1 }),
      db.collection('reports').createIndex({ id: 1 }, { unique: true }),
      db.collection('applink_subscriber_bindings').createIndex({ user_id: 1 }, { unique: true }),
      db.collection('applink_sms_outbox').createIndex({ business_event_key: 1 }, { unique: true }),
      db.collection('applink_sms_outbox').createIndex({ provider_request_id: 1 }),
      db.collection('applink_delivery_reports').createIndex({ dedupe_key: 1 }, { unique: true }),
      db.collection('applink_subscription_events').createIndex({ dedupe_key: 1 }, { unique: true }),
    ]);

    // Seed categories
    for (const cat of DEFAULT_CATEGORIES) {
      await db.collection('categories').updateOne(
        { id: cat.id },
        { $setOnInsert: cat },
        { upsert: true }
      );
    }

    // Seed admin user if configured
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      const adminEmail = env.ADMIN_EMAIL.toLowerCase().trim();
      const existing = await db.collection('users').findOne({ email: adminEmail });
      const now = new Date().toISOString();
      if (!existing) {
        const adminId = newId();
        const hash = await bcrypt.hash(env.ADMIN_PASSWORD, 10);
        await db.collection('users').insertOne({
          id: adminId,
          email: adminEmail,
          phone: null,
          password_hash: hash,
          created_at: now,
        });
        await db.collection('profiles').insertOne({
          id: adminId,
          full_name: 'Platform Administrator',
          avatar_file_id: null,
          bio: null,
          role: 'admin',
          is_suspended: false,
          suspended_reason: null,
          preferred_language: 'en',
          location_city: null,
          location_area: null,
          created_at: now,
          updated_at: now,
        });
        await db.collection('profile_contacts').insertOne({
          user_id: adminId,
          email: adminEmail,
          phone: null,
          exact_address: null,
          updated_at: now,
        });
      } else {
        await db.collection('profiles').updateOne(
          { id: String(existing.id) },
          { $set: { role: 'admin', updated_at: now } }
        );
      }
    }
  })().catch((err) => {
    readyPromise = null;
    throw err;
  });

  return readyPromise;
}
