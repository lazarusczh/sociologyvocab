import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 阿里云 Supabase 兼容版（AnalyticDB for PostgreSQL）连接信息
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// anon 密钥是公开密钥，前端直接使用没问题；service_role 密钥绝不进入前端。
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
