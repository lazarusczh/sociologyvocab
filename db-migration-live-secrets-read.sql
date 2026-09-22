-- ============================================
-- 术语可见性：轮次「结算之后」对全班开放
--
-- 背景：live_round_secrets 原本只有教师可读（防止 term_id 泄漏 = 送答案）。
-- 但文档要求「本轮结束前不公布答案，结束后显示本轮正确答案（讲评价值）」，
-- 学生端总得能拿到那个词。
--
-- 做法：再加一条「仅当该轮 state = settled 时可读」的策略。
-- 轮次进行中学生依旧读不到；一结算立刻可读，且不需要教师端转发答案。
--
-- 幂等，可重复执行。
-- ============================================

drop policy if exists "live_round_secrets_read_settled" on public.live_round_secrets;

create policy "live_round_secrets_read_settled" on public.live_round_secrets
  for select using (
    exists (
      select 1
      from public.live_spell_rounds r
      where r.id = live_round_secrets.round_id
        and r.state = 'settled'
    )
  );
