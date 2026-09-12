import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, resilientFetch } from './supabaseFetch';

// 阿里云 Supabase 兼容版（AnalyticDB for PostgreSQL）连接信息与访问策略见 ./supabaseFetch.ts
// （该文件同时被 skill 子站复用，保证两边都用上"直连优先 + 同源代理兜底"）。

// anon 密钥是公开密钥，前端直接使用没问题；service_role 密钥绝不进入前端。
export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: resilientFetch },
});
