-- Row Level Security (RLS) Policies & Private Storage Configuration

-- Helper functions in private schema (not exposed to PostgREST)
CREATE OR REPLACE FUNCTION private.is_admin(p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_uid AND role = 'admin' AND is_suspended = FALSE
  );
$$;

CREATE OR REPLACE FUNCTION private.is_accepted_participant(p_post_id UUID, p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.claims
    WHERE post_id = p_post_id AND claimant_id = p_uid AND status IN ('accepted', 'completed')
  )
  OR EXISTS (
    SELECT 1 FROM public.contributions
    WHERE post_id = p_post_id AND contributor_id = p_uid AND status IN ('pledged', 'confirmed')
  );
$$;

-- Prevent non-admin/non-service_role from modifying role or suspension status
CREATE OR REPLACE FUNCTION private.protect_profile_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
    OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
  ) THEN
    IF current_setting('request.jwt.claim.role', true) <> 'service_role'
       AND NOT private.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Cannot modify privileged profile fields';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_profile_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.protect_profile_privileged_fields();

-- Enable RLS on all public tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_private_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;

-- 1. profiles
CREATE POLICY "profiles_public_select" ON public.profiles
  FOR SELECT TO anon, authenticated
  USING (is_suspended = FALSE OR (select auth.uid()) = id OR private.is_admin((select auth.uid())));

CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- 2. profile_contacts (strictly private!)
CREATE POLICY "profile_contacts_select" ON public.profile_contacts
  FOR SELECT TO authenticated
  USING (
    (select auth.uid()) = user_id
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "profile_contacts_update" ON public.profile_contacts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- 3. categories (public read-only)
CREATE POLICY "categories_public_select" ON public.categories
  FOR SELECT TO anon, authenticated
  USING (TRUE);

-- 4. posts
CREATE POLICY "posts_select" ON public.posts
  FOR SELECT TO anon, authenticated
  USING (
    status IN ('active', 'fulfilled')
    OR (select auth.uid()) = author_id
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "posts_insert" ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = author_id);

CREATE POLICY "posts_update" ON public.posts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = author_id OR private.is_admin((select auth.uid())))
  WITH CHECK ((select auth.uid()) = author_id OR private.is_admin((select auth.uid())));

CREATE POLICY "posts_delete" ON public.posts
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = author_id OR private.is_admin((select auth.uid())));

-- 5. post_private_details (owner, accepted participants, or admin only)
CREATE POLICY "post_private_details_select" ON public.post_private_details
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_accepted_participant(post_id, (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "post_private_details_insert" ON public.post_private_details
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
  );

CREATE POLICY "post_private_details_update" ON public.post_private_details
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid())));

-- 6. post_images
CREATE POLICY "post_images_select" ON public.post_images
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = post_id AND (p.status IN ('active', 'fulfilled') OR p.author_id = (select auth.uid()))
    )
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "post_images_insert" ON public.post_images
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid())));

CREATE POLICY "post_images_delete" ON public.post_images
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid())));

-- 7. private_documents (strictly owner, accepted participants, or admin)
CREATE POLICY "private_documents_select" ON public.private_documents
  FOR SELECT TO authenticated
  USING (
    uploader_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_accepted_participant(post_id, (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "private_documents_insert" ON public.private_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    uploader_id = (select auth.uid())
    AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
  );

-- 8. claims
CREATE POLICY "claims_select" ON public.claims
  FOR SELECT TO authenticated
  USING (
    claimant_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "claims_insert" ON public.claims
  FOR INSERT TO authenticated
  WITH CHECK (claimant_id = (select auth.uid()));

CREATE POLICY "claims_update" ON public.claims
  FOR UPDATE TO authenticated
  USING (
    claimant_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  )
  WITH CHECK (
    claimant_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

-- 9. contributions
CREATE POLICY "contributions_select" ON public.contributions
  FOR SELECT TO authenticated
  USING (
    contributor_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

CREATE POLICY "contributions_insert" ON public.contributions
  FOR INSERT TO authenticated
  WITH CHECK (contributor_id = (select auth.uid()));

CREATE POLICY "contributions_update" ON public.contributions
  FOR UPDATE TO authenticated
  USING (
    contributor_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  )
  WITH CHECK (
    contributor_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id AND p.author_id = (select auth.uid()))
    OR private.is_admin((select auth.uid()))
  );

-- 10. conversations & participants & messages
CREATE POLICY "conversations_select" ON public.conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = id AND cp.user_id = (select auth.uid())
    )
  );

CREATE POLICY "conversation_participants_select" ON public.conversation_participants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants cp2
      WHERE cp2.conversation_id = conversation_id AND cp2.user_id = (select auth.uid())
    )
  );

CREATE POLICY "messages_select" ON public.messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = conversation_id AND cp.user_id = (select auth.uid())
    )
  );

CREATE POLICY "messages_insert" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = conversation_id AND cp.user_id = (select auth.uid())
    )
  );

-- 11. notifications
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

CREATE POLICY "notifications_update" ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- 12. reports
CREATE POLICY "reports_select" ON public.reports
  FOR SELECT TO authenticated
  USING (reporter_id = (select auth.uid()) OR private.is_admin((select auth.uid())));

CREATE POLICY "reports_insert" ON public.reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = (select auth.uid()));

CREATE POLICY "reports_update_admin" ON public.reports
  FOR UPDATE TO authenticated
  USING (private.is_admin((select auth.uid())))
  WITH CHECK (private.is_admin((select auth.uid())));

-- 13. moderation_actions (admin only)
CREATE POLICY "moderation_actions_admin_select" ON public.moderation_actions
  FOR SELECT TO authenticated
  USING (private.is_admin((select auth.uid())));

CREATE POLICY "moderation_actions_admin_insert" ON public.moderation_actions
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin((select auth.uid())) AND admin_id = (select auth.uid()));

-- Private Storage Buckets (never public URLs; accessed via signed URLs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('post-images', 'post-images', FALSE, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']),
  ('private-documents', 'private-documents', FALSE, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  ('avatars', 'avatars', FALSE, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Storage RLS Policies (upsert requires SELECT + INSERT + UPDATE)
CREATE POLICY "avatars_owner_all" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY "post_images_owner_write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'post-images' AND (storage.foldername(name))[1] = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'post-images' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY "private_docs_owner_write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'private-documents' AND (storage.foldername(name))[1] = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'private-documents' AND (storage.foldername(name))[1] = (select auth.uid())::text);
