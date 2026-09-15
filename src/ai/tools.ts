/**
 * 画布操作 = AI 的工具（技术文档 §4.3）
 *
 * 这是整个项目最重要的一个接口设计：**AI 的输出不是聊天文字，是一组画布操作。**
 *
 * 为什么这么做：
 *   · 操作是**有限的、可审计的、可撤销的**，自由文本不是
 *   · AI 不需要「会写 HTML 之外的东西」——它只需要「会调用工具」
 *   · 渲染、安全、增量更新全部由我们控制
 *
 * ⚠️ 注意这里**没有**「重发整块 HTML」这个工具。那是刻意的：
 *    整块重发会冲掉用户笔迹、把滚动顶回顶部、还白烧 token。
 */

import { Type, type Tool } from '@earendil-works/pi-ai';

export const TOOL_BOARD_WRITE = 'board_write';
export const TOOL_ASK_USER = 'ask_user';
export const TOOL_SEARCH_MATERIALS = 'search_materials';

export const WRITE_OPS = ['append', 'set', 'remove'] as const;

export const boardTools: Tool[] = [
  {
    name: TOOL_BOARD_WRITE,
    description: [
      '在白板上写入或修改内容。',
      '默认用 append 追加到板尾；',
      '要修改已经写过的某一段，用 set 并指定它的 region；',
      '要删掉某一段，用 remove 并指定 region。',
      'html 必须是自包含的 HTML 片段：公式用 MathML，图形用内联 SVG，',
      '样式只用内联 style 属性（<style> 标签会被安全过滤器删掉）。',
      '不要引用任何外部资源（外链图片、字体、脚本），它们会被安全过滤器删掉。',
    ].join(''),
    parameters: Type.Object({
      op: Type.Union(
        [Type.Literal('append'), Type.Literal('set'), Type.Literal('remove')],
        { description: '要做的操作' },
      ),
      region: Type.Optional(
        Type.String({
          description:
            '区域名。op=set / op=remove 时必填；op=append 时建议也给一个，' +
            '这样以后要修改这一段就能用 set 精确替换它，而不用整块重写。',
        }),
      ),
      html: Type.Optional(
        Type.String({ description: 'HTML 片段。op=remove 时省略。' }),
      ),
    }),
  },
  {
    name: TOOL_ASK_USER,
    description:
      '给用户出几个选项让他直接在板上点选，而不是让他打字。' +
      '适合「要不要继续」「用哪种解法」这类分支。出完选项后你就停下来等，不要自己替他选。',
    parameters: Type.Object({
      choices: Type.Array(
        Type.Object({
          id: Type.String({ description: '选项的机器可读标识，短、稳定、无空格' }),
          label: Type.String({ description: '显示给用户看的中文文字' }),
        }),
        { minItems: 2, maxItems: 6 },
      ),
    }),
  },
  {
    name: TOOL_SEARCH_MATERIALS,
    description: [
      '在**用户自己上传的资料**（书、笔记、论文）里检索相关段落。',
      '当用户的问题涉及他上传过的内容、或者你打算引用某本书某段原文时，用它去查。',
      '⚠️ 不要凭记忆编造书里的内容 —— 查不到就如实说没找到。',
      '查到之后，把引用的段落**用 board_write 写到板上**（标明出自哪本书、哪一节），',
      '再在旁边写你的讲解。用户要看到原文，而不是听你转述。',
    ].join(''),
    parameters: Type.Object({
      query: Type.String({ description: '要查什么，用一句自然语言描述，例如「判别式怎么决定根的个数」' }),
    }),
  },
];
