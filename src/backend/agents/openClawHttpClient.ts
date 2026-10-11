export interface OpenClawAsyncTaskHandle {
  taskId: string;
  status: string;
}

export interface OpenClawTaskStatus {
  status: string;
  result?: string;
}

export interface OpenClawHttpClient {
  invokeShort(prompt: string, signal: AbortSignal): Promise<string>;
  invokeLongAsync(prompt: string): Promise<OpenClawAsyncTaskHandle>;
  pollStatus(taskId: string): Promise<OpenClawTaskStatus>;
}

export interface MakeOpenClawHttpClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = 'http://127.0.0.1:18789';

export function makeOpenClawHttpClient(opts: MakeOpenClawHttpClientOptions = {}): OpenClawHttpClient | null {
  const token = (opts.token ?? process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN ?? '').trim();
  if (!token) return null;

  const baseUrl = normalizeBaseUrl(opts.baseUrl ?? process.env.RODRIGO_OPENCLAW_GATEWAY_URL ?? DEFAULT_BASE_URL);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delegatedResults = new Map<string, string>();

  async function postCompletion(prompt: string, signal?: AbortSignal): Promise<JsonObject> {
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });

    const payload = await readPayload(response);
    if (!response.ok) {
      throw new Error(`Gateway OpenClaw respondeu HTTP ${response.status}${describePayload(payload)}`);
    }
    if (!isJsonObject(payload)) {
      throw new Error('Gateway OpenClaw respondeu em formato inválido (JSON esperado).');
    }
    return payload;
  }

  return {
    async invokeShort(prompt: string, signal: AbortSignal): Promise<string> {
      const payload = await postCompletion(prompt, signal);
      const text = extractText(payload);
      if (!text) {
        throw new Error('Gateway OpenClaw não retornou conteúdo textual na resposta.');
      }
      return text;
    },

    async invokeLongAsync(prompt: string): Promise<OpenClawAsyncTaskHandle> {
      const payload = await postCompletion(prompt);
      const taskId = readString(payload.taskId) ?? readString(payload.id);
      const status = readString(payload.status);
      if (taskId) {
        return { taskId, status: status ?? 'pending' };
      }

      // Fallback honesto quando o gateway não diferencia "long task":
      // mesma chamada real, tratada como já concluída e armazenada localmente para pollStatus.
      const text = extractText(payload);
      if (!text) {
        throw new Error('Gateway OpenClaw não retornou taskId nem resultado textual para tarefa longa.');
      }
      const delegatedId = `delegated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      delegatedResults.set(delegatedId, text);
      return { taskId: delegatedId, status: 'completed' };
    },

    async pollStatus(taskId: string): Promise<OpenClawTaskStatus> {
      const delegated = delegatedResults.get(taskId);
      if (delegated) {
        return { status: 'completed', result: delegated };
      }

      const payload = await postCompletion(`status ${taskId}`);
      const status = readString(payload.status);
      if (status) {
        return {
          status,
          result: readString(payload.result) ?? extractText(payload) ?? undefined
        };
      }

      const text = extractText(payload);
      if (text) {
        const parsed = parseJsonObject(text);
        if (parsed) {
          const parsedStatus = readString(parsed.status);
          if (parsedStatus) {
            return {
              status: parsedStatus,
              result: readString(parsed.result) ?? undefined
            };
          }
        }
        return { status: 'completed', result: text };
      }

      throw new Error('Gateway OpenClaw não expôs status consultável para esta tarefa.');
    }
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractText(payload: JsonObject): string | null {
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (isJsonObject(first)) {
      const message = first.message;
      if (isJsonObject(message)) {
        const content = message.content;
        if (typeof content === 'string' && content.trim()) return content.trim();
      }
    }
  }

  const result = payload.result;
  if (typeof result === 'string' && result.trim()) return result.trim();
  return null;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describePayload(payload: unknown): string {
  if (isJsonObject(payload)) {
    if (isJsonObject(payload.error) && typeof payload.error.message === 'string') {
      return ` (${payload.error.message})`;
    }
    if (typeof payload.message === 'string') {
      return ` (${payload.message})`;
    }
  }
  if (typeof payload === 'string' && payload.trim()) {
    return ` (${payload.trim()})`;
  }
  return '';
}
