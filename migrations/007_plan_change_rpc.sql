-- Migration 007: apply_plan_change RPC for Pro<->Enterprise plan switching
--
-- Atomically reads the current plan and credits, determines the credit direction
-- (upgrade / downgrade / same-plan), and writes the new plan + adjusted credits
-- in a single transaction using FOR UPDATE to prevent concurrent race conditions.
--
-- Returns: the new credits value after the change.
--
-- Credit rules:
--   Upgrade  (e.g. pro → enterprise): reset to full allotment (p_new_allotment)
--   Downgrade (e.g. enterprise → pro):  min(current_remaining, p_new_allotment)
--   Same plan (idempotent re-delivery): credits unchanged

CREATE OR REPLACE FUNCTION apply_plan_change(
  p_user_id     uuid,
  p_new_plan    text,
  p_new_allotment int
) RETURNS int AS $$
DECLARE
  v_old_plan text;
  v_credits  int;
  v_old      int;
  v_new      int;
  v_result   int;
BEGIN
  SELECT plan, credits
    INTO v_old_plan, v_credits
    FROM profiles
   WHERE id = p_user_id
     FOR UPDATE;

  -- Ordinal rank: enterprise=2, pro=1, anything else=0
  v_old := CASE v_old_plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;
  v_new := CASE p_new_plan  WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;

  IF v_new > v_old THEN
    v_result := p_new_allotment;                    -- upgrade: full allotment
  ELSIF v_new < v_old THEN
    v_result := LEAST(v_credits, p_new_allotment);  -- downgrade: keep unused credits up to new cap
  ELSE
    v_result := v_credits;                          -- same plan: no change
  END IF;

  UPDATE profiles
     SET plan    = p_new_plan,
         credits = v_result
   WHERE id = p_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Verification
SELECT proname, pronargs FROM pg_proc WHERE proname = 'apply_plan_change';
