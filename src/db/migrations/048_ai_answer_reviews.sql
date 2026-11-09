-- Migration 048: AI Answer Reviews & Two-Level Human Review Pipeline
-- Architecture: Decouples execution auto-queueing from answer curation.
-- Proposals are uniquely identified by (application_id, resolution_revision, field_key).
-- Operator submission promotes all AI answers to gh_candidate_qa_bank.
-- Operator review actions always advance to manager review.
-- Manager approval confirms or replaces QA bank row; manager rejection removes only matching promoted QA row.
-- Embeddings are decoupled and tracked per-review with revision guards.

-- 1. Main review proposals table
CREATE TABLE IF NOT EXISTS public.gh_ai_answer_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES public.gh_candidate_applications(id) ON DELETE CASCADE,
  resolution_revision INTEGER NOT NULL DEFAULT 1,
  field_key TEXT NOT NULL, -- SHA-256(label|type)[0:16] fingerprint
  applywizz_id TEXT NOT NULL REFERENCES public.profiles(applywizz_id) ON DELETE CASCADE,
  candidate_name TEXT,
  question_label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options JSONB,
  ai_value TEXT NOT NULL,
  ai_confidence NUMERIC(4,3),
  ai_model TEXT NOT NULL,
  ai_provenance JSONB,

  -- Optimistic locking revision
  revision INTEGER NOT NULL DEFAULT 1,

  -- Lifecycle status: 'pending_operator' | 'pending_manager' | 'approved' | 'rejected'
  status TEXT NOT NULL DEFAULT 'pending_operator',

  -- Operator submission promotion
  promoted_at TIMESTAMPTZ,
  promoted_value TEXT,
  promoted_source TEXT,

  -- Operator action
  operator_action TEXT, -- 'approved' | 'denied' | 'edited'
  operator_value TEXT,
  operator_email TEXT,
  operator_actioned_at TIMESTAMPTZ,

  -- Manager action
  manager_action TEXT, -- 'approved' | 'rejected' | 'edited'
  manager_value TEXT,
  manager_email TEXT,
  manager_actioned_at TIMESTAMPTZ,

  -- Decoupled embedding status
  embedding_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'failed' | 'not_applicable'
  embedding_revision INTEGER NOT NULL DEFAULT 0,
  embedding_updated_at TIMESTAMPTZ,
  embedding_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ai_review_proposal_identity UNIQUE (application_id, resolution_revision, field_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_review_status ON public.gh_ai_answer_reviews(status);
CREATE INDEX IF NOT EXISTS idx_ai_review_applywizz ON public.gh_ai_answer_reviews(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_ai_review_app_revision ON public.gh_ai_answer_reviews(application_id, resolution_revision);
CREATE INDEX IF NOT EXISTS idx_ai_review_embedding_pending ON public.gh_ai_answer_reviews(embedding_status) WHERE embedding_status = 'pending';

-- 2. Audit log / event history table
CREATE TABLE IF NOT EXISTS public.gh_ai_answer_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES public.gh_ai_answer_reviews(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'proposal_created' | 'promoted_submission' | 'operator_action' | 'manager_action' | 'embedding_synced'
  actor TEXT NOT NULL,
  actor_role TEXT,
  action TEXT,
  from_status TEXT,
  to_status TEXT,
  from_revision INTEGER,
  to_revision INTEGER,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_events_review_id ON public.gh_ai_answer_review_events(review_id);

-- 3. Idempotency store for replay safety
CREATE TABLE IF NOT EXISTS public.gh_ai_review_idempotency_keys (
  key TEXT PRIMARY KEY,
  review_id UUID REFERENCES public.gh_ai_answer_reviews(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  response_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_idempotency_created ON public.gh_ai_review_idempotency_keys(created_at);

-- RLS policies for service role
ALTER TABLE public.gh_ai_answer_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gh_ai_answer_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gh_ai_review_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role full access to gh_ai_answer_reviews" ON public.gh_ai_answer_reviews;
CREATE POLICY "Allow service_role full access to gh_ai_answer_reviews" ON public.gh_ai_answer_reviews
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role full access to gh_ai_answer_review_events" ON public.gh_ai_answer_review_events;
CREATE POLICY "Allow service_role full access to gh_ai_answer_review_events" ON public.gh_ai_answer_review_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role full access to gh_ai_review_idempotency_keys" ON public.gh_ai_review_idempotency_keys;
CREATE POLICY "Allow service_role full access to gh_ai_review_idempotency_keys" ON public.gh_ai_review_idempotency_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Transactional Manager Review Action RPC
CREATE OR REPLACE FUNCTION public.process_manager_review_action(
  p_review_id UUID,
  p_expected_revision INTEGER,
  p_action TEXT, -- 'approved' | 'rejected' | 'edited'
  p_actor_email TEXT,
  p_edited_value TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_review public.gh_ai_answer_reviews%ROWTYPE;
  v_effective_value TEXT;
  v_cached_response JSONB;
  v_deleted_count INTEGER := 0;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT response_payload INTO v_cached_response
    FROM public.gh_ai_review_idempotency_keys
    WHERE key = p_idempotency_key;

    IF FOUND THEN
      RETURN v_cached_response;
    END IF;
  END IF;

  -- Select review row FOR UPDATE
  SELECT * INTO v_review
  FROM public.gh_ai_answer_reviews
  WHERE id = p_review_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review item % not found', p_review_id;
  END IF;

  -- Optimistic locking check
  IF v_review.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Stale revision: expected %, got %', p_expected_revision, v_review.revision;
  END IF;

  -- Status check
  IF v_review.status <> 'pending_manager' THEN
    RAISE EXCEPTION 'Invalid review status for manager action: %', v_review.status;
  END IF;

  IF p_action = 'approve' THEN
    -- If operator denied, manager cannot approve original AI answer without providing replacement value
    IF v_review.operator_action = 'denied' AND (p_edited_value IS NULL OR trim(p_edited_value) = '') THEN
      RAISE EXCEPTION 'Cannot approve an operator-denied proposal without providing an edited replacement';
    END IF;

    v_effective_value := COALESCE(NULLIF(trim(p_edited_value), ''), v_review.operator_value, v_review.ai_value);

    -- Upsert to QA bank
    INSERT INTO public.gh_candidate_qa_bank (
      applywizz_id,
      question_fingerprint,
      question_label,
      field_type,
      value,
      source,
      confidence,
      updated_at
    ) VALUES (
      v_review.applywizz_id,
      v_review.field_key,
      v_review.question_label,
      v_review.field_type,
      v_effective_value,
      'manual',
      1.000,
      NOW()
    )
    ON CONFLICT (applywizz_id, question_fingerprint)
    DO UPDATE SET
      value = EXCLUDED.value,
      source = 'manual',
      confidence = 1.000,
      updated_at = NOW();

    -- Update review record
    UPDATE public.gh_ai_answer_reviews
    SET
      status = 'approved',
      manager_action = 'approved',
      manager_value = v_effective_value,
      manager_email = p_actor_email,
      manager_actioned_at = NOW(),
      revision = v_review.revision + 1,
      embedding_status = 'pending',
      embedding_revision = v_review.revision + 1,
      updated_at = NOW()
    WHERE id = p_review_id
    RETURNING * INTO v_review;

  ELSIF p_action = 'edit' THEN
    IF p_edited_value IS NULL OR trim(p_edited_value) = '' THEN
      RAISE EXCEPTION 'Edited value must be provided for edit action';
    END IF;

    v_effective_value := trim(p_edited_value);

    -- Upsert to QA bank
    INSERT INTO public.gh_candidate_qa_bank (
      applywizz_id,
      question_fingerprint,
      question_label,
      field_type,
      value,
      source,
      confidence,
      updated_at
    ) VALUES (
      v_review.applywizz_id,
      v_review.field_key,
      v_review.question_label,
      v_review.field_type,
      v_effective_value,
      'manual',
      1.000,
      NOW()
    )
    ON CONFLICT (applywizz_id, question_fingerprint)
    DO UPDATE SET
      value = EXCLUDED.value,
      source = 'manual',
      confidence = 1.000,
      updated_at = NOW();

    -- Update review record
    UPDATE public.gh_ai_answer_reviews
    SET
      status = 'approved',
      manager_action = 'edited',
      manager_value = v_effective_value,
      manager_email = p_actor_email,
      manager_actioned_at = NOW(),
      revision = v_review.revision + 1,
      embedding_status = 'pending',
      embedding_revision = v_review.revision + 1,
      updated_at = NOW()
    WHERE id = p_review_id
    RETURNING * INTO v_review;

  ELSIF p_action = 'reject' THEN
    -- Update review record
    UPDATE public.gh_ai_answer_reviews
    SET
      status = 'rejected',
      manager_action = 'rejected',
      manager_email = p_actor_email,
      manager_actioned_at = NOW(),
      revision = v_review.revision + 1,
      embedding_status = 'not_applicable',
      updated_at = NOW()
    WHERE id = p_review_id
    RETURNING * INTO v_review;

    -- Conditional delete from QA bank: ONLY if QA row matches the review's promoted value
    IF v_review.promoted_value IS NOT NULL THEN
      DELETE FROM public.gh_candidate_qa_bank
      WHERE applywizz_id = v_review.applywizz_id
        AND question_fingerprint = v_review.field_key
        AND value = v_review.promoted_value;
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

  ELSE
    RAISE EXCEPTION 'Unknown manager action: %', p_action;
  END IF;

  -- Append audit event
  INSERT INTO public.gh_ai_answer_review_events (
    review_id,
    event_type,
    actor,
    actor_role,
    action,
    from_status,
    to_status,
    from_revision,
    to_revision,
    payload
  ) VALUES (
    v_review.id,
    'manager_action',
    p_actor_email,
    'manager',
    p_action,
    'pending_manager',
    v_review.status,
    p_expected_revision,
    v_review.revision,
    jsonb_build_object(
      'action', p_action,
      'edited_value', p_edited_value,
      'effective_value', v_effective_value,
      'deleted_qa_count', v_deleted_count
    )
  );

  v_cached_response := jsonb_build_object(
    'success', true,
    'review', to_jsonb(v_review),
    'deletedQaCount', v_deleted_count
  );

  -- Store idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.gh_ai_review_idempotency_keys (
      key,
      review_id,
      action_type,
      response_payload
    ) VALUES (
      p_idempotency_key,
      v_review.id,
      'manager_action',
      v_cached_response
    )
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN v_cached_response;
END;
$$;
