const DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const MAX_MEDIA_BYTES = 7_000_000;
const MAX_DURATION_SECONDS = 300;

const FORMATS = new Map([
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/aac', 'aac'], ['audio/amr', 'amr'],
  ['audio/ogg', 'ogg'], ['audio/opus', 'opus'], ['audio/webm', 'webm'], ['audio/flac', 'flac'],
  ['video/mp4', 'mp4'], ['video/quicktime', 'mov'], ['video/webm', 'webm'],
  ['video/x-matroska', 'mkv'], ['video/x-msvideo', 'avi'], ['video/x-flv', 'flv']
]);
const EXTENSIONS = new Map([
  ['wav', 'wav'], ['mp3', 'mp3'], ['m4a', 'm4a'], ['aac', 'aac'], ['amr', 'amr'],
  ['ogg', 'ogg'], ['opus', 'opus'], ['webm', 'webm'], ['flac', 'flac'], ['mp4', 'mp4'],
  ['mov', 'mov'], ['mkv', 'mkv'], ['avi', 'avi'], ['flv', 'flv']
]);

export class MediaTranscriptionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MediaTranscriptionError';
    this.code = code;
    this.status = status;
  }
}

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function formatFor(input) {
  const mime = text(input.mime_type, 120).toLowerCase().split(';')[0];
  const extension = text(input.filename, 240).toLowerCase().split('.').pop();
  const format = FORMATS.get(mime) || EXTENSIONS.get(extension);
  if (!format) throw new MediaTranscriptionError('UNSUPPORTED_MEDIA_TYPE', '仅支持常见语音和短视频格式。');
  const kind = mime.startsWith('video/') || ['mp4', 'mov', 'mkv', 'avi', 'flv'].includes(extension) ? 'video' : 'audio';
  return { mime: mime || `${kind}/${format}`, format, kind };
}

function decodeBase64(value) {
  const source = text(value, 12_000_000).replace(/\s+/g, '');
  if (!source || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw new MediaTranscriptionError('INVALID_MEDIA_DATA', '文件内容不是有效的 Base64 数据。');
  const bytes = Buffer.from(source, 'base64');
  if (!bytes.length) throw new MediaTranscriptionError('EMPTY_MEDIA', '语音或视频文件为空。');
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaTranscriptionError('MEDIA_TOO_LARGE', '当前演练版单个文件需小于 7 MB。', 413);
  return { source, bytes };
}

function endpoint(baseUrl) {
  const base = text(baseUrl, 1000).replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return base.endsWith('/generation') ? base : `${base}/services/aigc/multimodal-generation/generation`;
}

export function createDashScopeTranscriber(options = {}) {
  const apiKey = text(options.apiKey, 2000);
  if (!apiKey) throw new TypeError('DashScope API key is required');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const url = endpoint(options.baseUrl);
  const model = text(options.model, 160) || DEFAULT_MODEL;
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(options.timeoutMs) || 90_000));

  return async function transcribeMedia(input = {}) {
    const filename = text(input.filename, 240);
    if (!filename) throw new MediaTranscriptionError('MEDIA_FILENAME_REQUIRED', '请选择语音或视频文件。');
    const duration = input.duration_seconds === undefined || input.duration_seconds === null ? null : Number(input.duration_seconds);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS)) {
      throw new MediaTranscriptionError('MEDIA_DURATION_UNSUPPORTED', '当前支持不超过 5 分钟的语音或短视频。');
    }
    const { mime, format, kind } = formatFor(input);
    const { source, bytes } = decodeBase64(input.data_base64);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-dashscope-sse': 'disable'
        },
        body: JSON.stringify({
          model,
          input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${source}` } }] }] },
          parameters: {
            format,
            keep_dialect: false,
            language_hints: ['zh', 'yue'],
            vocabulary: { '被保险人': 5, '受益人': 5, '现金价值': 5, '年金': 5, '保单': 5, '太平洋保险': 5, '蛮好的人生': 5 }
          }
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== 'object') {
        throw new MediaTranscriptionError('ASR_UPSTREAM_ERROR', '语音识别服务暂时无法完成请求。', 502);
      }
      const transcript = text(payload.output?.text, 20_000);
      if (!transcript) throw new MediaTranscriptionError('ASR_EMPTY_RESULT', '没有识别出可确认的文字，请销售直接试听原文件。', 422);
      return {
        status: 'review_required',
        transcript,
        filename,
        media_kind: kind,
        mime_type: mime,
        byte_size: bytes.length,
        duration_seconds: Number(payload.usage?.duration) || duration,
        model,
        provider_request_id: text(payload.request_id, 200) || null,
        needs_human_review: true,
        review_hints: ['核对金额、年龄和日期', '核对否定表达', '核对人物归属', '疾病、核保、理赔及投诉内容必须转人工判断']
      };
    } catch (error) {
      if (error instanceof MediaTranscriptionError) throw error;
      if (error?.name === 'AbortError') throw new MediaTranscriptionError('ASR_TIMEOUT', '语音识别超时，请稍后重试或直接试听。', 504);
      throw new MediaTranscriptionError('ASR_UNREACHABLE', '暂时无法连接语音识别服务。', 502);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const __test = { formatFor, decodeBase64, endpoint, MAX_MEDIA_BYTES, MAX_DURATION_SECONDS };
