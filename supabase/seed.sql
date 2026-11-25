-- Seed default donation & community support categories (English & Bengali)
INSERT INTO public.categories (slug, name_en, name_bn, icon, is_restricted, restriction_note_en, restriction_note_bn, sort_order)
VALUES
  ('food', 'Food & Groceries', 'খাবার ও নিত্যপণ্য', 'utensils', FALSE, NULL, NULL, 1),
  ('clothes', 'Clothes & Blankets', 'পোশাক ও কম্বল', 'shirt', FALSE, NULL, NULL, 2),
  ('books', 'Books & Study', 'বই ও শিক্ষা উপকরণ', 'book-open', FALSE, NULL, NULL, 3),
  ('furniture', 'Furniture', 'আসবাবপত্র', 'armchair', FALSE, NULL, NULL, 4),
  ('electronics', 'Electronics', 'ইলেকট্রনিক্স', 'laptop', FALSE, NULL, NULL, 5),
  ('medicine', 'Medicine & Medical Aid', 'ওষুধ ও চিকিৎসা সহায়তা', 'pill', TRUE,
   'Safety Notice: Only sealed, non-expired, legal over-the-counter items or verified prescriptions may be shared. Never share controlled substances.',
   'নিরাপত্তা নির্দেশনা: শুধুমাত্র মেয়াদোত্তীর্ণ নয় এমন সিল করা অনুমোদিত ওষুধ বা যাচাইকৃত প্রেসক্রিপশনভিত্তিক সহায়তা শেয়ার করুন। নিষিদ্ধ বা নিয়ন্ত্রিত ওষুধ শেয়ার করা সম্পূর্ণ নিষিদ্ধ।',
   6),
  ('household', 'Household Items', 'গৃহস্থালি সামগ্রী', 'home', FALSE, NULL, NULL, 7),
  ('education', 'Educational Materials', 'শিক্ষা ও প্রশিক্ষণ', 'graduation-cap', FALSE, NULL, NULL, 8),
  ('financial-aid', 'Direct Financial Support', 'সরাসরি আর্থিক সহায়তা', 'hand-coins', FALSE, NULL, NULL, 9),
  ('volunteer-help', 'Non-Material & Volunteer Help', 'স্বেচ্ছাসেবক ও অন্যান্য সহায়তা', 'heart-handshake', FALSE, NULL, NULL, 10),
  ('other', 'Other Useful Items', 'অন্যান্য প্রয়োজনীয় সামগ্রী', 'package', FALSE, NULL, NULL, 11)
ON CONFLICT (slug) DO UPDATE SET
  name_en = EXCLUDED.name_en,
  name_bn = EXCLUDED.name_bn,
  icon = EXCLUDED.icon,
  is_restricted = EXCLUDED.is_restricted,
  restriction_note_en = EXCLUDED.restriction_note_en,
  restriction_note_bn = EXCLUDED.restriction_note_bn,
  sort_order = EXCLUDED.sort_order;
