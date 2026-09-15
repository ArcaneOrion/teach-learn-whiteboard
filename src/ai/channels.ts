/**
 * 渠道（模型供应商）注册表
 *
 * 产品定位是 BYOK —— 自己配 Key（产品文档 §3.3 / §18.6）。
 * 同时内置若干**公开的免费渠道**，界面上只暴露名称，让用户零配置就能先跑起来。
 *
 * ⚠️ 界线（产品文档 §18.6）：
 *   · 可以内置**公开的免费渠道** —— 本来就人人可用，没有"秘密"可泄露
 *   · **绝不能内置你自己付费的 Key** —— APK 可解包，泄露后无法撤销（撤销 = 所有用户同时坏掉）、
 *     账单是你的、且多数厂商条款禁止分发 Key
 *   区别的本质：前者泄露的是公开信息，后者泄露的是你的钱。
 *
 * ⚠️ 选内置渠道时的硬约束：**必须挑「浏览器可直连」的那几家**。
 *   实测（技术文档 §7.3）：DeepSeek / 硅基流动 / 智谱 / 通义 / xAI 可以直接从浏览器调；
 *   OpenAI / OpenRouter / Moonshot / Google 会被 CORS 挡住（在安卓 App 里走原生 HTTP 才行）。
 *   如果内置渠道挑了一家浏览器调不通的，开发时会一直失败，而真机上却是好的 —— 极难排查。
 */

import {
  createModels,
  createProvider,
  type CredentialStore,
  type Model,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import type { Store } from '../store/types';

export type ChannelKind = 'user' | 'builtin' | 'demo';

export interface ChannelConfig {
  id: string;
  /** 用户看到的全部信息（内置渠道只暴露名字） */
  name: string;
  baseUrl: string;
  modelIds: string[];
  kind: ChannelKind;
  /** 内置免费渠道恒为 true —— 界面要如实标注，不承诺可用性 */
  unstable: boolean;
}

/** 内置渠道。填的时候必须是**公开可用**的地址。 */
export const BUILTIN_CHANNELS: readonly ChannelConfig[] = [
  // 目前留空 —— 等确定可用的公开免费渠道再往里填。形如：
  //
  // {
  //   id: 'free-a',
  //   name: '免费渠道 A',
  //   baseUrl: 'https://example.invalid/v1',
  //   modelIds: ['some-model'],
  //   kind: 'builtin',
  //   unstable: true,
  // },
];

const CHANNELS_KEY = 'channels';

/** 读出用户配置的渠道 */
export async function loadChannels(store: Store): Promise<ChannelConfig[]> {
  const rows = await store.getMeta<ChannelConfig[]>(CHANNELS_KEY);
  return Array.isArray(rows) ? rows : [];
}

export async function saveChannels(store: Store, channels: readonly ChannelConfig[]): Promise<void> {
  await store.setMeta(CHANNELS_KEY, [...channels]);
}

/** 内置渠道 + 用户渠道 */
export function allChannels(userChannels: readonly ChannelConfig[]): ChannelConfig[] {
  return [...BUILTIN_CHANNELS, ...userChannels];
}

// ── 把渠道变成 pi-ai 的 provider ──────────────────────────────

/**
 * 用户填的模型只有一个 id，其它字段我们给合理的默认值。
 *
 * user 渠道的默认值，单位是 token
 * 这几个数是**猜的**：用户随便填一个模型名时，我们无从知道它的真实窗口大小。
 * 所以取值偏保守 —— 宁可少喂一点上下文，也不要请求被 API 拒绝。
 */
const DEFAULT_CONTEXT_WINDOW = 65_536;
const DEFAULT_MAX_TOKENS = 8_192;

export function makeModel(params: {
  modelId: string;
  channelId: string;
  baseUrl: string;
  supportsVision?: boolean;
}): Model<'openai-completions'> {
  return {
    id: params.modelId,
    name: params.modelId,
    api: 'openai-completions',
    provider: params.channelId,
    baseUrl: params.baseUrl,
    reasoning: false,
    input: params.supportsVision === true ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

export interface ChannelRegistry {
  models: ReturnType<typeof createModels>;
  /** 这个渠道能用吗（配没配 Key。内置/演示渠道不需要 Key） */
  getModel(channelId: string, modelId: string): Model<'openai-completions'> | null;
}

/**
 * 把所有渠道注册成 pi-ai 的 provider。
 *
 * 两类渠道在引擎层是**同一件事** —— 都是 createProvider，只是数据来源不同
 * （一个来自硬编码清单，一个来自用户的数据库）。
 */
export function buildRegistry(
  channels: readonly ChannelConfig[],
  credentials: CredentialStore,
): ChannelRegistry {
  const models = createModels({ credentials });

  for (const channel of channels) {
    const keyless = channel.kind !== 'user';

    models.setProvider(
      createProvider({
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl,
        auth: {
          apiKey: {
            name: `${channel.name} 的 API Key`,
            // 从凭据存储里取用户填的 Key。取不到就返回 undefined，pi-ai 会报「未配置」，
            // 界面据此提示用户去设置 —— 而不是发一个注定 401 的请求
            resolve: async ({ credential, signal }) => {
              signal.throwIfAborted();
              if (keyless) return { auth: {}, source: '内置渠道（无需 Key）' };
              const key = credential?.key;
              if (key === undefined || key === '') return undefined;
              return { auth: { apiKey: key }, source: '你配置的 Key' };
            },
          },
        },
        models: channel.modelIds.map((modelId) =>
          makeModel({ modelId, channelId: channel.id, baseUrl: channel.baseUrl }),
        ),
        api: openAICompletionsApi(),
      }),
    );
  }

  return {
    models,
    getModel(channelId, modelId) {
      try {
        return models.getModel(channelId, modelId) as Model<'openai-completions'> | null;
      } catch {
        return null;
      }
    },
  };
}
