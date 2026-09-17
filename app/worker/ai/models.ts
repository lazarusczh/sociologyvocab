// 模型目录与档位（主站 /app-api/* 与子站 /skill-api/* 共用同一批通道）
//
// 说明：worker.ts 目前仍保留自身的文本档常量（线上子站在跑，避免一次性大改）；
// 待"一次性抽取"时统一到本文件。

export const MS_BASE_URL = 'https://api-inference.modelscope.cn/v1';
export const MS_CHAT_URL = `${MS_BASE_URL}/chat/completions`;

// 视觉档（OCR 阅卷）
//
// ★ 2026-09-17 更换模型 id：原 `Qwen/Qwen3-VL-235B-A22B-Instruct` 与 `Qwen/Qwen3-VL-8B-Instruct`
//   已被魔搭下架 —— 调用一律 400 `Model id : ... , has no provider supported`，
//   并且 `Qwen/Qwen3-*` **整个系列**都不在该账号的可见模型列表里（魔搭已换代到 Qwen3.5）。
//   现改用账号实测可调用的两个：主力 InternVL3.5-241B，降级 ERNIE-4.5-VL-28B。
//   换模型前先用 `node scripts/ms-models.mjs` 对照账号**实际**可用列表，不要照抄任何记忆里的旧 id。
export const MS_VISION = 'OpenGVLab/InternVL3_5-241B-A28B';
export const MS_VISION_FALLBACK = 'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT';

// 视觉兜底（Cloudflare Workers AI）：**完全不依赖魔搭**。
// 2026-09-17 实测魔搭账号里仅有的两个可见视觉模型都「HTTP 200 但内容为空」
// （用自造图片测过，见 scripts/ms-vision-check.mjs），OCR 等于全灭，
// 故补一条自有通道。选它是因官方示例支持直接传 data URL，改动最小；
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
