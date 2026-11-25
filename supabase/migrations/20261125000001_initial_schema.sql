-- Initial Schema for Donation & Community Support Platform
-- Note: Platform NEVER holds, collects, or processes money, and NEVER stores bank/card/PIN/OTP data.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Private schema for internal security helpers (never exposed via PostgREST)
CREATE SCHEMA IF NOT EXISTS private;

-- 1. Profiles (publicly safe user metadata; private contact info is in profile_contacts)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 2 AND 120),
  avatar_url TEXT,
  bio TEXT CHECK (char_length(bio) <= 1000),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_reason TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'bn')),
  location_city TEXT CHECK (char_length(location_city) <= 100),
  location_area TEXT CHECK (char_length(location_area) <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Private Contact Details (strictly protected, never exposed in public queries)
CREATE TABLE public.profile_contacts (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  email TEXT,
  phone TEXT CHECK (char_length(phone) <= 30),
  exact_address TEXT CHECK (char_length(exact_address) <= 300),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Categories
CREATE TABLE public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name_en TEXT NOT NULL,
  name_bn TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'package',
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  restriction_note_en TEXT,
  restriction_note_bn TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Posts (donation offers and help requests)
CREATE TABLE public.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL CHECK (post_type IN ('donation_offer', 'help_request')),
  donation_type TEXT NOT NULL CHECK (donation_type IN ('money', 'item', 'service')),
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 5 AND 180),
  description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 10 AND 5000),
  quantity NUMERIC(12, 2) CHECK (quantity IS NULL OR quantity > 0),
  unit TEXT CHECK (char_length(unit) <= 40),
  amount NUMERIC(14, 2) CHECK (amount IS NULL OR amount > 0),
  currency TEXT NOT NULL DEFAULT 'BDT' CHECK (char_length(currency) BETWEEN 3 AND 6),
  location_city TEXT NOT NULL CHECK (char_length(trim(location_city)) BETWEEN 2 AND 100),
  location_area TEXT CHECK (char_length(location_area) <= 100),
  urgency TEXT NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'fulfilled', 'closed', 'removed')),
  safety_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Post Private Handover Details (only visible to owner, accepted participants, or admin)
CREATE TABLE public.post_private_details (
  post_id UUID PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  exact_handover_address TEXT CHECK (char_length(exact_handover_address) <= 300),
  contact_phone TEXT CHECK (char_length(contact_phone) <= 30),
  contact_note TEXT CHECK (char_length(contact_note) <= 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Post Images (stored in private bucket; served via signed URLs)
CREATE TABLE public.post_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Private Supporting Documents (stored in private bucket; signed URLs for authorized users only)
CREATE TABLE public.private_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Claims (for item & service offers/requests)
CREATE TABLE public.claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  claimant_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('offer_to_donate', 'request_item')),
  message TEXT CHECK (char_length(message) <= 1000),
  quantity_offered NUMERIC(12, 2) CHECK (quantity_offered IS NULL OR quantity_offered > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'completed')),
  donor_confirmed_handover BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_confirmed_handover BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate active (pending/accepted) claims by the same user on the same post
CREATE UNIQUE INDEX idx_claims_unique_active_per_user
  ON public.claims(post_id, claimant_id)
  WHERE status IN ('pending', 'accepted');

-- 9. Monetary Contributions (direct donor-to-recipient pledges; platform NEVER holds money)
CREATE TABLE public.contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'BDT' CHECK (char_length(currency) BETWEEN 3 AND 6),
  note TEXT CHECK (char_length(note) <= 1000),
  status TEXT NOT NULL DEFAULT 'pledged' CHECK (status IN ('pledged', 'confirmed', 'cancelled')),
  donor_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_confirmed_requires_both_parties CHECK (
    status <> 'confirmed' OR (donor_confirmed = TRUE AND recipient_confirmed = TRUE)
  )
);

-- 10. Conversations
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Conversation Participants
CREATE TABLE public.conversation_participants (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

-- 12. Messages
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 3000),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Notifications
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'new_offer',
    'new_request',
    'offer_accepted',
    'offer_rejected',
    'new_message',
    'contribution_confirmed',
    'post_status_changed',
    'moderation'
  )),
  title TEXT NOT NULL CHECK (char_length(title) <= 200),
  body TEXT NOT NULL CHECK (char_length(body) <= 1000),
  link TEXT CHECK (char_length(link) <= 300),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Reports
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'user')),
  target_post_id UUID REFERENCES public.posts(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 150),
  details TEXT CHECK (char_length(details) <= 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_report_target CHECK (
    (target_type = 'post' AND target_post_id IS NOT NULL) OR
    (target_type = 'user' AND target_user_id IS NOT NULL)
  )
);

-- 15. Moderation Actions
CREATE TABLE public.moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'suspend_user',
    'unsuspend_user',
    'remove_post',
    'restore_post',
    'resolve_report',
    'dismiss_report'
  )),
  target_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL,
  report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_posts_status_created ON public.posts(status, created_at DESC);
CREATE INDEX idx_posts_author ON public.posts(author_id, created_at DESC);
CREATE INDEX idx_posts_category_status ON public.posts(category_id, status);
CREATE INDEX idx_posts_type_donation_status ON public.posts(post_type, donation_type, status);
CREATE INDEX idx_posts_urgency_status ON public.posts(urgency, status);
CREATE INDEX idx_posts_location_city ON public.posts(lower(location_city));
CREATE INDEX idx_post_images_post ON public.post_images(post_id, sort_order);
CREATE INDEX idx_private_docs_post ON public.private_documents(post_id);
CREATE INDEX idx_claims_post_status ON public.claims(post_id, status);
CREATE INDEX idx_claims_claimant ON public.claims(claimant_id, created_at DESC);
CREATE INDEX idx_contributions_post_status ON public.contributions(post_id, status);
CREATE INDEX idx_contributions_contributor ON public.contributions(contributor_id, created_at DESC);
CREATE INDEX idx_conv_participants_user ON public.conversation_participants(user_id);
CREATE INDEX idx_messages_conversation_created ON public.messages(conversation_id, created_at ASC);
CREATE INDEX idx_notifications_user_unread ON public.notifications(user_id, is_read, created_at DESC);
CREATE INDEX idx_reports_status_created ON public.reports(status, created_at DESC);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_profile_contacts_updated_at BEFORE UPDATE ON public.profile_contacts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_posts_updated_at BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_post_private_details_updated_at BEFORE UPDATE ON public.post_private_details
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_claims_updated_at BEFORE UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_contributions_updated_at BEFORE UPDATE ON public.contributions
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- Auto-create profile & profile_contacts on auth.users signup
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''), split_part(NEW.email, '@', 1), 'Community Member'),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profile_contacts (user_id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();

-- Transactional helper: Accept a claim safely with row locking to prevent race conditions
CREATE OR REPLACE FUNCTION public.accept_claim_tx(p_claim_id UUID, p_owner_id UUID)
RETURNS public.claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim public.claims;
  v_post public.posts;
BEGIN
  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLAIM_NOT_FOUND';
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = v_claim.post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POST_NOT_FOUND';
  END IF;

  IF v_post.author_id <> p_owner_id THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF v_post.status <> 'active' THEN
    RAISE EXCEPTION 'POST_NOT_ACTIVE';
  END IF;

  IF v_claim.status <> 'pending' THEN
    RAISE EXCEPTION 'CLAIM_NOT_PENDING';
  END IF;

  UPDATE public.claims
  SET status = 'accepted'
  WHERE id = p_claim_id
  RETURNING * INTO v_claim;

  RETURN v_claim;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_claim_tx(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_claim_tx(UUID, UUID) TO service_role;
