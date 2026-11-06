-- ============================================================================
-- 修 `regrade_quiz_submissions()`：重判时真正写对 final_score
--
-- 背景（2026-11-03 真实数据实测发现）：
--   旧版 `db-migration-regrade.sql:29-36` 只更新 `score`，`grading` 分两支处理，
--   **两支都是错的**：
--     · 有 penalty 时：`final_score = new_score - penalty`
--       → 把 `bonus`（订正加分）和 `card_bonus`（加分卡）一起丢掉
--     · 无 penalty 时：`else grading`
--       → `final_score` 根本不动，`score` 变了、最终分却还是旧值
--
--   实测（`2a4e1cee-…` AS Socialisation Week 5，把 4 份已订正答卷 score 各 +3）：
--     `50b7db35` score 14→17、bonus 3，最终分应为 20，实际仍是 17
--     `5dc08362` score 17→20、bonus 2，最终分应为 22，实际仍是 19
--     `b206b1bb` 无 bonus，score 16→19，最终分应为 19，实际仍是 16
--
-- 修法（口径由用户 2026-11-06 拍板）：
--   **前端算好 score 与 bonus 一并传入，SQL 只负责落库。**
--   订正加分依赖原始分 S（`correctionBonus(S, M, percent)`），重判改了 score 就要
--   按新 S 重算——这个「跟着变」的判断只有前端做得对（判分逻辑全在 TS：
--   别名 / 单复数 / 学者姓氏 / 拼写容错）。SQL 侧只做算术：
--     final_score = clamp(score − penalty + bonus + card_bonus, 0, M)
--   M 由 `public.quiz_max_points(uuid)` 取（SQL 侧唯一实现，见
--   db-migration-bonus-card-m.sql:27-47）。
--
-- 参数形状：{"<submission_id>": {"score": <int>, "bonus": <int>}}
--   兼容旧形状 {"<submission_id>": <int>}（按 bonus = 0 处理），便于滚动发布期间
--   尚未刷新的客户端不至于直接报错。
--
-- 顺带修：旧版 `v_count := v_count + 1` 是无条件自增，与实际更新行数无关
--   （传了不属于该卷的 id 也会 +1）。改为 `get diagnostics ... row_count`。
--
-- 幂等，可重复执行。
-- ============================================================================

-- ⚠ 参数名必须保留 `p_scores`：PostgREST 按**参数名**绑定，改名会让已安装的旧 APK
--   （缓存着旧 bundle）直接报 PGRST202「找不到函数」。改名换不来任何收益。
create or replace function public.regrade_quiz_submissions(
  p_quiz_id uuid,
  p_scores jsonb
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_role  text;
  v_count integer := 0;   -- 实际更新行数（旧版是无条件 +1，会虚报）
  v_rows  integer := 0;
  v_m     integer;        -- 真实满分（评分点数）
  g       record;
begin
  -- 权限：仅 teacher / developer 可调用
  select r.role into v_role from public.user_roles r where r.user_id = auth.uid();
  if v_role is null or v_role not in ('teacher', 'developer') then
    raise exception 'permission denied';
  end if;

  v_m := coalesce(public.quiz_max_points(p_quiz_id), 0);

  for g in
    select key::uuid as sub_id,
           case
             when jsonb_typeof(value) = 'object' then coalesce((value ->> 'score')::int, 0)
             else value::int
           end as new_score,
           case
             when jsonb_typeof(value) = 'object' then coalesce((value ->> 'bonus')::int, 0)
             else 0
           end as new_bonus
      from jsonb_each(p_scores)
  loop
    update public.quiz_submissions s
       set score = g.new_score,
           grading = case
             -- 原本没有结算、重判也没产生加分 ⇒ 保持 null（不给「无罚分无加分」的卷
             -- 凭空造出 grading 对象，那会让 UI 以为发生过结算）
             when s.grading is null and g.new_bonus = 0 then null
             else jsonb_set(
                    coalesce(s.grading, '{}'::jsonb)
                      || jsonb_build_object('bonus', g.new_bonus),
                    '{final_score}',
                    to_jsonb(greatest(0,
                      -- M 有效才封顶；M=0（空卷）时不封顶，避免把分数清零
                      case when v_m > 0
                        then least(g.new_score
                                   - coalesce((s.grading ->> 'penalty')::int, 0)
                                   + g.new_bonus
                                   + coalesce((s.grading ->> 'card_bonus')::int, 0), v_m)
                        else g.new_score
                             - coalesce((s.grading ->> 'penalty')::int, 0)
                             + g.new_bonus
                             + coalesce((s.grading ->> 'card_bonus')::int, 0)
                      end)))
           end
     where s.id = g.sub_id and s.quiz_id = p_quiz_id;

    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;

  return v_count;
end;
$$;

comment on function public.regrade_quiz_submissions(uuid, jsonb) is
  '重判：前端传入 {submission_id: {score, bonus}}，SQL 只落库并重算 final_score = clamp(score - penalty + bonus + card_bonus, 0, M)。M 取 quiz_max_points()。';
