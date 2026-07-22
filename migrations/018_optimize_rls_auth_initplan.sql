-- Cache auth.uid() once per statement in ownership RLS policies.
--
-- This preserves every policy name, command, role, and ownership predicate.
-- Wrapping auth.uid() in a scalar SELECT lets PostgreSQL use an initPlan
-- instead of re-evaluating the function for every candidate row.

ALTER POLICY "usage_logs: insert own"
  ON public.usage_logs
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "usage_logs: select own"
  ON public.usage_logs
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "prompts: select own"
  ON public.prompts
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "prompts: insert own"
  ON public.prompts
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "prompts: delete own"
  ON public.prompts
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "reference_images: select own"
  ON public.reference_images
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "reference_images: insert own"
  ON public.reference_images
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "purchases: select own"
  ON public.purchases
  USING ((SELECT auth.uid()) = user_id);

-- Post-deploy verification:
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('usage_logs', 'prompts', 'reference_images', 'purchases')
-- ORDER BY tablename, policyname;
