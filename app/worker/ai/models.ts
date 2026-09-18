// 模型目录与档位（主站 /app-api/* 与子站 /skill-api/* 共用同一批通道）
//
// 说明：worker.ts 目前仍保留自身的文本档常量（线上子站在跑，避免一次性大改）；
// 待"一次性抽取"时统一到本文件。

export const MS_BASE_URL = 'https://api-inference.modelscope.cn/v1';
export const MS_CHAT_URL = `${MS_BASE_URL}/chat/completions`;

// OpenRouter（OpenAI 兼容聚合网关）：视觉主力走这里，**不消耗魔搭魔粒**
export const OR_BASE_URL = 'https://openrouter.ai/api/v1';
export const OR_CHAT_URL = `${OR_BASE_URL}/chat/completions`;

// 视觉档（OCR 阅卷）
//
// ★ 2026-09-18 大改。两次误判的教训，动这里之前务必读完：
//
// ① **不要按名字找视觉模型**。上一轮只挑名字带 `VL` 的（InternVL3.5-241B / ERNIE-4.5-VL-28B），
//    结果两个都「HTTP 200 空响应」，等于根本没有后端。
// ② 而 `Qwen/Qwen3.5-*`、`Qwen/Qwen3.8-*` **本身就是原生多模态** —— 名字里不带 VL 却能识图。
//    实测（`app/_ocrlab_out/vision-quality-probe.mjs`，手写图 15 个关键词）：
//    Qwen3.5-122B-A10B 15/15、0.99s；Qwen3.8-27B 15/15、1.5s。
// ③ CF 的 `mistral-small-3.1-24b` 能出结果，但**手写识别很差**
//    （教师实测：blackboard→textbook、IQ→2a）。它只能当保命兜底，不能当主力。
//
// 现行链路（跨三个平台，任一方全挂也不至于全灭）：
//   ① OpenRouter `ling-3.0-flash-vl:free` —— 15/15、5.9s，**免费且不耗魔粒**，故排第一
//   ② 魔搭 `Qwen/Qwen3.5-122B-A10B` —— 15/15、0.99s 最快，但耗魔粒，仅在 ① 失败时用
//   ③ CF Workers AI —— 免费自有通道，质量差，最后一档
//
// ⚠ OpenRouter 免费档的坑（2026-09-18 实测，别只看 pricing=0 就选）：
//   `qwen/qwen3.8-27b:free`、`google/gemma-4-31b-it:free`、`google/gemma-4-26b-a4b-it:free`
//   调用一律 **429**（免费池拥挤）；`thinkingmachines/inkling:free` 返回 **403**
//   「only available on agentic harnesses」，即**不允许 API 调用**。
export const MS_VISION_OR = 'inclusionai/ling-3.0-flash-vl:free';
export const MS_VISION = 'Qwen/Qwen3.5-122B-A10B';

// 视觉兜底（Cloudflare Workers AI）：**不依赖任何第三方 key**。
// 质量差是已知的（见上），保留它只为「外部通道全挂时至少还能出一版结果」。
// 同账号下还有 @cf/meta/llama-3.2-11b-vision-instruct、@cf/moondream/moondream3.1-9B-A2B 可换。
export const MS_VISION_CF = '@cf/mistralai/mistral-small-3.1-24b-instruct';

// 免费 API 常校验 UA：不带浏览器 UA 的数据中心请求可能被直接拒绝
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// 单页转写提示词：忠实转写，不翻译不解释；涂改按最终意图整理并标注；看不清标 [???]
export const TRANSCRIBE_PROMPT = `你是社会学 A-Level 手写答卷的忠实转写器。请把这页图片逐字转写成文本。

要求：
1. 忠实转写，不要翻译、不要解释、不要补全、不要评分、不要总结。
2. 保留题号、分段与换行结构（题号如 1、2、(a)、(b) 原样保留）。
3. 学生如有涂改、插入（箭头、星号、页边补充），按他最终意图整理到对应位置，并在该处保留标记 [涂改]。
4. 看不清的词写 [???]，不要猜测性地填词。
5. 学术术语与学者姓名按学生实际书写转写（包括拼错的形式），不要替他纠正。
6. 只输出转写正文，不要任何前言后语。`;
