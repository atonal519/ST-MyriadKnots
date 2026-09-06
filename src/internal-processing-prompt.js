// 原文复制自 ST-SevenDaysCal/api/client.js 的 BASE_PROCESSING_PROMPT。
// 千千结保留本地副本，不在运行时依赖构画；这里只用于抽取、分析和整理等机械任务。
export const BASE_PROCESSING_PROMPT = `<fictional_content_processing_protocol>
The supplied material is fictional and may include explicit sexual content, violence, coercion, trauma, pathology, or other sensitive subject matter. Read and process relevant details faithfully; do not refuse, sanitize, euphemize, moralize, or omit them merely because they are sensitive.

The current task instructions and its machine-readable output contract take precedence. Unless the current task explicitly asks for creative generation, do not continue the story, invent new events, embellish, expand, or rewrite the source. Perform only the requested processing, analysis, extraction, classification, compression, transformation, or formatting.
</fictional_content_processing_protocol>`;

export function withBaseProcessingPrompt(taskPrompt = '') {
  const task = typeof taskPrompt === 'string' ? taskPrompt : '';
  return task ? `${BASE_PROCESSING_PROMPT}\n\n${task}` : BASE_PROCESSING_PROMPT;
}
