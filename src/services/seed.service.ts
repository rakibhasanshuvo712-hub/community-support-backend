import { getDb } from '../lib/firebase.js';

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

let seededOnce = false;

export async function ensureCategoriesSeeded(): Promise<void> {
  if (seededOnce) return;
  const db = getDb();
  const existing = await db.collection('categories').limit(1).get();
  if (existing.empty) {
    const batch = db.batch();
    for (const cat of DEFAULT_CATEGORIES) {
      batch.set(db.collection('categories').doc(cat.id), cat);
    }
    await batch.commit();
  }
  seededOnce = true;
}
