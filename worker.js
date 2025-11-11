const AMAZONQ_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com';

const SSO_OIDC_ENDPOINT = 'https://oidc.us-east-1.amazonaws.com';

const STREAMING_USER_AGENT_HINTS = [
  'claudecode',
  'claude code',
  'claude-code',
  'anthropic/ide',
  'anthropic-ide',
  'anthropic-client',
  'amazon q developer',
  'amazonq-ide',
];

const DEFAULT_CONFIG = {
  logging: {
    enabled: true,
    level: 'INFO',
    logRequests: true,
    logResponses: true,
    logTokenRefresh: true,
    maxLogLength: 500,
  },
  performance: {
    streamChunkSize: 1024,
    bufferMaxSize: 10240,
    tokenRefreshMarginSeconds: 300,
  },
  ssl: {
    verifyOidc: true,
  },
};

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

const upperLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
  #threshold = 1;
  #enabled = true;
  #logRequests = true;
  #logResponses = true;
  #logTokenRefresh = true;
  #maxLength = 500;

  constructor(config) {
    this.configure(config);
  }

  configure(config) {
    if (!config) return;
    this.#enabled = config.enabled ?? true;
    this.#logRequests = config.logRequests ?? true;
    this.#logResponses = config.logResponses ?? true;
    this.#logTokenRefresh = config.logTokenRefresh ?? true;
    this.#maxLength = config.maxLogLength ?? 500;
    const level = config.level?.toUpperCase?.() || 'INFO';
    const index = upperLogLevels.indexOf(level);
    this.#threshold = index >= 0 ? index : 1;
  }

  #shouldLog(levelIndex) {
    return this.#enabled && levelIndex >= this.#threshold;
  }

  debug(message, ...args) {
    if (this.#shouldLog(0)) console.log(`[DEBUG] ${message}`, ...args);
  }

  info(message, ...args) {
    if (this.#shouldLog(1)) console.log(`[INFO] ${message}`, ...args);
  }

  warn(message, ...args) {
    if (this.#shouldLog(2)) console.warn(`[WARN] ${message}`, ...args);
  }

  error(message, ...args) {
    if (this.#shouldLog(3)) console.error(`[ERROR] ${message}`, ...args);
  }

  requestsEnabled() {
    return this.#logRequests && this.#enabled;
  }

  responsesEnabled() {
    return this.#logResponses && this.#enabled;
  }

  tokenRefreshEnabled() {
    return this.#logTokenRefresh && this.#enabled;
  }

  maxLength() {
    return this.#maxLength;
  }
}

const logger = new Logger(DEFAULT_CONFIG.logging);

const parseJson = async (request) => {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    logger.error('请求 JSON 解析失败', err);
    throw new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
};

const normalizeStreamFlag = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return !!value;
  if (typeof value === 'string') {
    const val = value.trim().toLowerCase();
    if (!val) return null;
    if (['true', '1', 'yes', 'on', 'sse', 'stream', 'delta'].includes(val)) return true;
    if (['false', '0', 'no', 'off'].includes(val)) return false;
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['type', 'mode', 'format', 'value', 'enabled']) {
      if (key in value) {
        const normalized = normalizeStreamFlag(value[key]);
        if (normalized !== null) return normalized;
      }
    }
    return null;
  }
  return !!value;
};

const parseBool = (value) => {
  if (value === undefined || value === null) return null;
  const val = `${value}`.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'off'].includes(val)) return false;
  return null;
};

const resolveOidcVerifyOption = (config, envObj) => {
  const caBundle =
    envObj?.AMAZONQ_CA_BUNDLE ||
    envObj?.AWS_CA_BUNDLE ||
    envObj?.REQUESTS_CA_BUNDLE ||
    config.ssl?.ca_bundle ||
    config.ssl?.caBundle;

  if (caBundle) {
    return caBundle;
  }

  const disableVerify = parseBool(
    envObj?.DISABLE_AMAZONQ_SSL_VERIFY || envObj?.DISABLE_OIDC_SSL_VERIFY || envObj?.DISABLE_SSL_VERIFY,
  );
  if (disableVerify) {
    logger.warn('OIDC token 请求已禁用 SSL 验证，仅建议在调试环境中使用。');
    return false;
  }

  const envVerify = parseBool(envObj?.AMAZONQ_SSL_VERIFY || envObj?.OIDC_SSL_VERIFY);
  if (envVerify !== null) {
    return envVerify;
  }

  return Boolean(config.ssl?.verify_oidc ?? config.ssl?.verify ?? true);
};

const TOKEN_KEY = 'amazonq-credentials';

class AmazonQAuthManager {
  #kv;
  #config;
  #env;
  #accessToken = null;
  #tokenExpiry = null;
  #credentials;

  constructor(kv, config, envObj) {
    this.#kv = kv;
    this.#config = config;
    this.#env = envObj;
  }

  async loadCredentials() {
    if (this.#kv) {
      const stored = await this.#kv.get(TOKEN_KEY, { type: 'json' });
      if (stored) {
        if (stored.access_token) {
          this.#accessToken = stored.access_token;
          if (logger.tokenRefreshEnabled()) {
            logger.info(`从 KV 加载 access_token (长度: ${this.#accessToken.length})`);
          }
        }
        if (stored.token_expiry) {
          this.#tokenExpiry = new Date(stored.token_expiry);
        }
        this.#credentials = stored;
        return stored;
      }
    }

    const configCredentials = this.#env?.AMAZONQ_CREDENTIALS;
    if (configCredentials) {
      try {
        const parsed = JSON.parse(configCredentials);
        if (parsed.access_token) {
          this.#accessToken = parsed.access_token;
          if (logger.tokenRefreshEnabled()) {
            logger.info(`从环境变量加载 access_token (长度: ${this.#accessToken.length})`);
          }
        }
        if (parsed.token_expiry) {
          this.#tokenExpiry = new Date(parsed.token_expiry);
        }
        this.#credentials = parsed;
        return parsed;
      } catch (err) {
        logger.error('解析 AMAZONQ_CREDENTIALS 失败', err);
      }
    }

    this.#credentials = {};
    return {};
  }

  async getCredentials() {
    if (!this.#credentials) {
      this.#credentials = await this.loadCredentials();
    }
    return this.#credentials;
  }

  async setCredentials(credentials) {
    this.#credentials = { ...credentials };
    if (credentials.access_token) {
      this.#accessToken = credentials.access_token;
    }
    if (credentials.token_expiry) {
      this.#tokenExpiry = new Date(credentials.token_expiry);
    }
    if (this.#kv) {
      await this.#kv.put(TOKEN_KEY, JSON.stringify(this.#credentials));
    }
  }

  async refreshAccessToken() {
    const credentials = await this.getCredentials();

    if (credentials.access_token && this.#accessToken !== credentials.access_token) {
      this.#accessToken = credentials.access_token;
      if (logger.tokenRefreshEnabled()) {
        logger.info(`凭证中存在 access_token，长度: ${this.#accessToken.length}`);
      }
      return this.#accessToken;
    }

    if (!credentials.refresh_token) {
      throw new Error('未设置 refresh_token');
    }

    const clientId = credentials.client_id || credentials.clientId;
    const clientSecret = credentials.client_secret || credentials.clientSecret;
    const refreshToken = credentials.refresh_token || credentials.refreshToken;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('client_id/client_secret/refresh_token 缺失，无法刷新 token');
    }

    const payload = {
      grantType: 'refresh_token',
      refreshToken,
      clientId,
      clientSecret,
    };

    const verifyOption = resolveOidcVerifyOption(this.#config, this.#env);

    if (logger.tokenRefreshEnabled()) {
      logger.info('正在通过 API 刷新 token', {
        clientId: `${clientId}`.slice(0, 8) + '***',
      });
    }

    const response = await fetch(`${SSO_OIDC_ENDPOINT}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      // Cloudflare Workers 不支持自定义 CA bundle，verify=false 也不支持。但保留逻辑。
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error('API 刷新 token 失败', response.status, text);
      throw new Error(`API 刷新 token 失败: ${response.status}`);
    }

    const tokenData = await response.json();
    this.#accessToken = tokenData.accessToken;

    const expiresIn = tokenData.expiresIn ?? 3600;
    const expiry = new Date(Date.now() + expiresIn * 1000 - (this.#config.performance?.tokenRefreshMarginSeconds ?? 300) * 1000);
    this.#tokenExpiry = expiry;

    this.#credentials = {
      ...credentials,
      access_token: this.#accessToken,
      token_expiry: expiry.toISOString(),
    };

    if (this.#kv) {
      await this.#kv.put(TOKEN_KEY, JSON.stringify(this.#credentials));
    }

    if (logger.tokenRefreshEnabled()) {
      logger.info('token 刷新成功', {
        expiresIn,
      });
    }

    return this.#accessToken;
  }

  async getAccessToken() {
    if (!this.#accessToken || (this.#tokenExpiry && Date.now() >= this.#tokenExpiry.getTime())) {
      if (logger.tokenRefreshEnabled()) {
        logger.info('Access token 不存在或已过期，正在自动刷新…');
      }
      return this.refreshAccessToken();
    }
    return this.#accessToken;
  }

  hasAccessToken() {
    return Boolean(this.#accessToken);
  }

  tokenExpiryISO() {
    return this.#tokenExpiry ? this.#tokenExpiry.toISOString() : null;
  }
}

const serializeJson = (value) => JSON.stringify(value, null, 2);

const messagesToContent = (messages) => {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
      const { content } = msg;
      if (Array.isArray(content)) {
        const result = [];
        for (const item of content) {
          if (item && typeof item === 'object' && item.type === 'text') {
            result.push(item.text ?? '');
          }
        }
        return result.join(' ');
      }
      return content ?? '';
    }
  }
  return '';
};

const extractJsonFromBuffer = (buffer, startPattern = '{"content":') => {
  const start = buffer.indexOf(startPattern);
  if (start === -1) {
    return { jsonStr: null, remaining: buffer };
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < buffer.length; i += 1) {
    const char = buffer[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
    }

    if (!inString) {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return {
            jsonStr: buffer.slice(start, i + 1),
            remaining: buffer.slice(i + 1),
          };
        }
      }
    }
  }

  return { jsonStr: null, remaining: buffer };
};

const parseEventStream = (rawResponse) => {
  const buffer = rawResponse || '';
  const contents = [];
  let remaining = buffer;

  while (true) {
    const { jsonStr, remaining: rem } = extractJsonFromBuffer(remaining);
    remaining = rem;
    if (!jsonStr) break;
    try {
      const obj = JSON.parse(jsonStr);
      const text = obj.content;
      if (typeof text === 'string') contents.push(text);
    } catch (err) {
      // ignore
    }
  }

  if (contents.length) {
    return contents.join('');
  }

  const printableLines = [];
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    printableLines.push(trimmed);
  }
  return printableLines.join('\n');
};

const amazonqToOpenaiResponse = (amazonqRawResponse, model, conversationId) => {
  const content = parseEventStream(amazonqRawResponse);
  return {
    id: `chatcmpl-${conversationId.slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
};

const createStreamChunk = ({
  content,
  model,
  chunkType,
  formatType,
  messageId,
  finalText,
}) => {
  if (formatType === 'anthropic') {
    const id = messageId || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    let eventName = '';
    let chunk;

    switch (chunkType) {
      case 'start':
        eventName = 'message_start';
        chunk = {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        break;
      case 'content_start':
        eventName = 'content_block_start';
        chunk = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        };
        break;
      case 'content':
        eventName = 'content_block_delta';
        chunk = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: content },
        };
        break;
      case 'content_end':
        eventName = 'content_block_stop';
        chunk = { type: 'content_block_stop', index: 0 };
        break;
      case 'end':
        eventName = 'message_delta';
        chunk = {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        };
        break;
      case 'stop':
        eventName = 'message_stop';
        chunk = {
          type: 'message_stop',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [
              {
                type: 'text',
                text: finalText || '',
              },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        break;
      default:
        eventName = '';
        chunk = {};
    }

    const prefix = eventName ? `event: ${eventName}\n` : '';
    return `${prefix}data: ${JSON.stringify(chunk)}\n\n`;
  }

  const delta = {};
  if (chunkType === 'start') {
    delta.role = 'assistant';
    delta.content = '';
  } else if (chunkType === 'content') {
    delta.content = content;
  }

  const chunk = {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunkType === 'end' ? 'stop' : null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
};

const inferStreamPreference = ({ body, formatType, request }) => {
  let stream = normalizeStreamFlag(body.stream);

  if (stream === null) {
    stream = normalizeStreamFlag(request.query.get('stream'));
  }

  if (stream === null) {
    for (const key of ['response_mode', 'responseMode', 'response_format', 'responseFormat']) {
      stream = normalizeStreamFlag(body[key]);
      if (stream !== null) break;
    }
  }

  if (stream === null) {
    if (formatType === 'anthropic') {
      stream = true;
    } else {
      const accept = request.headers.get('accept') || '';
      if (accept.toLowerCase().includes('text/event-stream')) {
        stream = true;
      }
    }
  }

  if (stream === null || stream === false) {
    const userAgent = (request.headers.get('user-agent') || '').toLowerCase();
    const clientName =
      (request.headers.get('x-client-app') ||
        request.headers.get('x-app-name') ||
        request.headers.get('x-request-client') ||
        '')
        .toLowerCase();
    const haystack = `${userAgent} ${clientName}`.trim();
    if (haystack) {
      for (const hint of STREAMING_USER_AGENT_HINTS) {
        if (haystack.includes(hint)) {
          logger.debug(`检测到客户端 ${haystack} 需要流式响应，自动启用 stream 模式`);
          stream = true;
          break;
        }
      }
    }
  }

  if (stream === null) return false;
  return stream;
};

const selectModelId = (model) => {
  if (model === 'claude-sonnet-4' || model === 'claude-sonnet-4.5') {
    return model;
  }
  if (model === 'amazon-q') {
    return 'claude-sonnet-4.5';
  }
  return 'claude-sonnet-4.5';
};

const amazonQRequestPayload = ({ message, conversationId, modelId }) => ({
  conversationState: {
    chatTriggerType: 'MANUAL',
    conversationId,
    currentMessage: {
      userInputMessage: {
        content: message,
        images: [],
        modelId,
        origin: 'IDE',
        userInputMessageContext: {
          editorState: {
            useRelevantDocuments: false,
            workspaceFolders: [],
          },
          envState: {
            operatingSystem: 'linux',
          },
        },
      },
    },
    history: [],
  },
});

const fetchAmazonQ = async ({
  authManager,
  message,
  conversationId,
  profileArn,
  modelId,
  stream,
}) => {
  const payload = amazonQRequestPayload({ message, conversationId, modelId });
  const accessToken = await authManager.getAccessToken();
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'x-amzn-codewhisperer-optout': 'false',
  };

  const response = await fetch(`${AMAZONQ_ENDPOINT}/generateAssistantResponse`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (response.status === 403) {
    logger.warn('收到 403 错误，可能是 token 过期，正在自动刷新…');
    try {
      await authManager.refreshAccessToken();
      const retryHeaders = {
        ...headers,
        authorization: `Bearer ${await authManager.getAccessToken()}`,
      };
      return fetch(`${AMAZONQ_ENDPOINT}/generateAssistantResponse`, {
        method: 'POST',
        headers: retryHeaders,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error('刷新 token 失败', err);
      throw err;
    }
  }

  return response;
};

const bufferText = async (resp) => {
  const text = await resp.text();
  return text;
};

const buildAnthropicResponse = ({ model, content }) => ({
  id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: content,
    },
  ],
  model,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
  },
});

const respondWithJson = (data, init = {}) => {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
};

const healthResponse = async (authManager) => {
  const credentials = await authManager.getCredentials();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    has_credentials: Boolean(credentials.refresh_token),
  };
};

const modelsResponse = () => ({
  object: 'list',
  data: [
    {
      id: 'claude-sonnet-4.5',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'anthropic',
    },
    {
      id: 'claude-sonnet-4',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'anthropic',
    },
    {
      id: 'amazon-q',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'amazon',
    },
  ],
});

const indexResponse = () => ({
  message: 'Amazon Q to OpenAI API Bridge',
  version: '2.0.0',
  auth_method: 'OAuth 2.0',
  endpoints: {
    openai_chat: '/v1/chat/completions',
    anthropic_messages: '/v1/messages',
    models: '/v1/models',
    credentials: '/credentials',
    health: '/health',
  },
  default_model: 'claude-sonnet-4.5',
});

const streamAmazonQ = ({ amazonqResponse, model, formatType, bufferLimit }) => {
  const reader = amazonqResponse.body?.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const accumulated = [];
  const limit = bufferLimit || DEFAULT_CONFIG.performance.bufferMaxSize;

  const sendChunk = (controller, chunkType, content = '', options = {}) => {
    controller.enqueue(
      encoder.encode(
        createStreamChunk({
          content,
          model,
          chunkType,
          formatType,
          messageId,
          finalText: options.finalText,
        }),
      ),
    );
  };

  const pushError = (controller, error) => {
    const chunk = { error: { message: error.message || 'stream error', type: 'stream_error' } };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  return new ReadableStream({
    async start(controller) {
      if (!reader) {
        pushError(controller, new Error('Amazon Q 响应不可读'));
        controller.close();
        return;
      }

      try {
        if (formatType === 'anthropic') {
          sendChunk(controller, 'start');
          sendChunk(controller, 'content_start');
        } else {
          sendChunk(controller, 'start');
        }

        let buffer = '';

        const processBuffer = () => {
          while (true) {
            const { jsonStr, remaining } = extractJsonFromBuffer(buffer);
            buffer = remaining;
            if (!jsonStr) break;
            try {
              const obj = JSON.parse(jsonStr);
              if (typeof obj.content === 'string' && obj.content) {
                if (formatType === 'anthropic') {
                  accumulated.push(obj.content);
                  sendChunk(controller, 'content', obj.content);
                } else {
                  sendChunk(controller, 'content', obj.content);
                }
              }
            } catch (err) {
              logger.debug('解析 Amazon Q 流片段失败', err);
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > limit) {
              buffer = buffer.slice(-limit);
            }
            processBuffer();
          }
        }

        buffer += decoder.decode();
        processBuffer();

        if (formatType === 'anthropic') {
          sendChunk(controller, 'content_end');
          sendChunk(controller, 'end');
          sendChunk(controller, 'stop', '', { finalText: accumulated.join('') });
        } else {
          sendChunk(controller, 'end');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }

        controller.close();
      } catch (err) {
        logger.error('流式响应出错', err);
        pushError(controller, err);
        controller.close();
      }
    },
  });
};

export default {
  async fetch(request, envObj, ctx) {
    logger.configure(DEFAULT_CONFIG.logging);

    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    const config = { ...DEFAULT_CONFIG };
    config.performance = {
      ...DEFAULT_CONFIG.performance,
      tokenRefreshMarginSeconds: Number(envObj.TOKEN_REFRESH_MARGIN || DEFAULT_CONFIG.performance.tokenRefreshMarginSeconds),
    };

    const anthropicVersion = envObj.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION;
    const authManager = new AmazonQAuthManager(envObj.AMAZONQ_KV, config, envObj);
    await authManager.loadCredentials();

    try {
      if (url.pathname === '/' && method === 'GET') {
        return respondWithJson(indexResponse());
      }

      if (url.pathname === '/health' && method === 'GET') {
        return respondWithJson(await healthResponse(authManager));
      }

      if (url.pathname === '/v1/models' && method === 'GET') {
        return respondWithJson(modelsResponse());
      }

      if (url.pathname === '/credentials') {
        if (method === 'POST') {
          const credentials = await parseJson(request.clone());
          const fieldAliases = {
            refresh_token: ['refresh_token', 'refreshToken'],
            client_id: ['client_id', 'clientId'],
            client_secret: ['client_secret', 'clientSecret'],
          };
          const normalized = {};
          const missing = [];

          for (const [canonical, aliases] of Object.entries(fieldAliases)) {
            const value = aliases.reduce((acc, key) => acc || credentials[key], null);
            if (!value) {
              missing.push(canonical);
            } else {
              normalized[canonical] = value;
            }
          }

          if (missing.length) {
            return respondWithJson({ error: `缺少必需字段: ${missing.join(', ')}` }, { status: 400 });
          }

          const combined = { ...credentials, ...normalized };
          await authManager.setCredentials(combined);
          return respondWithJson({ message: '凭证设置成功', has_profile_arn: Boolean(combined.profile_arn) });
        }

        if (method === 'GET') {
          const credentials = await authManager.getCredentials();
          return respondWithJson({
            has_credentials: Boolean(credentials.refresh_token),
            has_access_token: authManager.hasAccessToken(),
            token_expiry: authManager.tokenExpiryISO(),
          });
        }
      }

      if ((url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') && method === 'POST') {
        const formatType = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
        const data = await parseJson(request.clone());
        const requestId = `req_${crypto.randomUUID().replace(/-/g, '')}`;

        if (!Array.isArray(data.messages) || !data.messages.length) {
          return respondWithJson({ error: 'messages 参数不能为空' }, { status: 400 });
        }

        const stream = inferStreamPreference({ body: data, formatType, request: { headers: request.headers, query: url.searchParams } });

        const model = data.model || 'claude-sonnet-4.5';
        const conversationId = crypto.randomUUID();
        const message = messagesToContent(data.messages);

        if (!message) {
          return respondWithJson({ error: '无法从消息中提取用户输入' }, { status: 400 });
        }

        const modelId = selectModelId(model);

        const amazonqResponse = await fetchAmazonQ({
          authManager,
          message,
          conversationId,
          profileArn: null,
          modelId,
          stream,
        });

        if (!amazonqResponse.ok) {
          const text = await amazonqResponse.text();
          return respondWithJson(
            {
              error: {
                message: `Amazon Q API 调用失败: ${text}`,
                type: 'amazon_q_error',
                code: 'service_unavailable',
              },
            },
            { status: amazonqResponse.status },
          );
        }

        if (stream) {
          const streamBody = await streamAmazonQ({ amazonqResponse, model, formatType });
          const headers = {
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'content-type': 'text/event-stream; charset=utf-8',
          };
          if (formatType === 'anthropic') {
            headers['anthropic-version'] = anthropicVersion;
            headers['x-request-id'] = requestId;
          }
          return new Response(streamBody, { headers });
        }

        const text = await amazonqResponse.text();
        const openaiResponse = amazonqToOpenaiResponse(text, model, conversationId);

        if (formatType === 'anthropic') {
          const content = openaiResponse.choices[0]?.message?.content || '';
          const anthropicResp = buildAnthropicResponse({ model, content });
          return respondWithJson(anthropicResp, {
            headers: {
              'anthropic-version': anthropicVersion,
              'x-request-id': requestId,
            },
          });
        }

        return respondWithJson(openaiResponse);
      }

      return respondWithJson(
        {
          error: {
            message: 'Not Found',
            type: 'not_found',
          },
        },
        { status: 404 },
      );
    } catch (err) {
      logger.error('处理请求时发生错误', err);
      return respondWithJson(
        {
          error: {
            message: err.message || 'Internal Error',
            type: 'server_error',
            code: 'internal_error',
          },
        },
        { status: 500 },
      );
    }
  },
};
