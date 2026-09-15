/**
 * 备份格式的测试
 *
 * 这块的测试重点是**防御性**：导入会写进用户的数据库，
 * 一个半损坏的文件如果被放进去，坏的是他仅有的学习记录。
 * 所以宁可报错拒绝，也不要「尽力而为地导入一半」。
 *
 * 另外一条是**隐私**：备份文件里绝不能有 API Key（见 core/backup.ts 的说明）。
 */

import { describe, expect, it } from 'vitest';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  countCredentials,
  describeBackup,
  makeBackup,
  parseBackup,
  type MakeBackupInput,
} from './backup';
import type { BoardEvent } from './types';

function event(id: string): BoardEvent {
  return {
    id,
    boardId: 'b1',
    sessionId: 's1',
    seq: 1,
    actor: 'user',
    kind: 'ink.clear',
    payload: null,
    createdAt: 1000,
    deviceId: 'dev',
    synced: 0,
  } as BoardEvent;
}

function baseInput(): MakeBackupInput {
  return {
    boards: [
      { id: 'b1', userId: 'local', title: '板', createdAt: 1, updatedAt: 2, archived: 0 },
    ],
    sessions: [],
    events: [event('e1')],
    attachments: [],
    meta: [
      { key: 'deviceId', value: 'dev-abc' },
      { key: 'channels', value: [] },
    ],
    now: new Date(2026, 8, 15, 13, 0).getTime(),
    appVersion: '0.1.0',
  };
}

describe('makeBackup', () => {
  it('打包出正确格式的备份', () => {
    const backup = makeBackup(baseInput());
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.data.events).toHaveLength(1);
    expect(backup.data.boards).toHaveLength(1);
  });

  it('★ 凭据不进备份 —— 这是产品最核心的承诺「Key 不出设备」', () => {
    const input = baseInput();
    // meta 在 MakeBackupInput 里是只读数组，测试里换成一个可变的副本
    const mutable: MakeBackupInput = {
      ...input,
      meta: [...input.meta, { key: 'credential:ch-1', value: { type: 'api_key', key: 'sk-secret' } }],
    };

    const backup = makeBackup(mutable);

    const keys = backup.data.meta.map((m) => m.key);
    expect(keys).not.toContain('credential:ch-1');
    // 整个文件序列化之后也不该出现那个密钥
    expect(JSON.stringify(backup)).not.toContain('sk-secret');
    // 但其它设置要留着
    expect(keys).toContain('deviceId');
    expect(keys).toContain('channels');
  });

  it('countCredentials 能告诉界面「有几条 Key 没被导出」', () => {
    expect(
      countCredentials([
        { key: 'deviceId' },
        { key: 'credential:a', value: { type: 'api_key', key: 'x' } },
        { key: 'credential:b', value: { type: 'api_key', key: 'y' } },
      ]),
    ).toBe(2);
  });

  it('★ 删掉的渠道不该还算作「你填了 N 个 Key」', () => {
    // 删渠道时凭据是被写成 null，而不是删掉那一行
    expect(
      countCredentials([
        { key: 'credential:gone', value: null },
        { key: 'credential:alive', value: { type: 'api_key', key: 'x' } },
      ]),
    ).toBe(1);
  });
});

describe('parseBackup —— 正常路径', () => {
  it('自己导出的能读回来', () => {
    const backup = makeBackup(baseInput());
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.data.events).toHaveLength(1);
    expect(parsed.appVersion).toBe('0.1.0');
  });
});

describe('parseBackup —— 防御性', () => {
  it('★ 不是 JSON', () => {
    expect(() => parseBackup('这不是 json')).toThrow(BackupError);
    expect(() => parseBackup('这不是 json')).toThrow(/不是一个备份文件/);
  });

  it('★ 是 JSON 但不是本 App 的备份', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow(/不是本 App 的备份/);
    expect(() => parseBackup(JSON.stringify({ format: 'something-else', version: 1 }))).toThrow(
      /不是本 App 的备份/,
    );
  });

  it('★ 版本比当前新 —— 要明确告诉用户去升级，而不是硬着头皮读', () => {
    const backup = makeBackup(baseInput());
    const future = { ...backup, version: BACKUP_VERSION + 5 };
    expect(() => parseBackup(JSON.stringify(future))).toThrow(/更新的版本/);
  });

  it('缺 data', () => {
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }))).toThrow(
      /缺少 data/,
    );
  });

  it('events 不是数组', () => {
    const bad = { format: BACKUP_FORMAT, version: 1, data: { events: 'nope' } };
    expect(() => parseBackup(JSON.stringify(bad))).toThrow(/缺少 events/);
  });

  it('★ 事件缺关键字段 —— 必须拒绝，不能"尽力而为地导入一半"', () => {
    const bad = {
      format: BACKUP_FORMAT,
      version: 1,
      data: { events: [{ id: 'e1', boardId: 'b1' }], boards: [], sessions: [], attachments: [], meta: [] },
    };
    expect(() => parseBackup(JSON.stringify(bad))).toThrow(/第 1 条事件缺少字段 seq/);
  });

  it('★ 报错信息是给人看的，不是堆栈术语', () => {
    try {
      parseBackup('{}');
      expect.unreachable('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupError);
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/undefined|null|TypeError/);
      expect(msg.length).toBeGreaterThan(6);
    }
  });

  it('缺少的可选字段用默认值补上，不炸', () => {
    const minimal = {
      format: BACKUP_FORMAT,
      version: 1,
      data: { events: [], boards: [], sessions: [], attachments: [], meta: [] },
    };
    const parsed = parseBackup(JSON.stringify(minimal));
    expect(parsed.exportedAt).toBe(0);
    expect(parsed.appVersion).toBe('未知');
  });
});

describe('文件名与摘要', () => {
  it('文件名带日期，方便用户分辨', () => {
    expect(backupFileName(new Date(2026, 8, 15, 13, 0).getTime())).toBe('共写白板-备份-2026-09-15.json');
  });

  it('摘要说清里面有多少东西（导入前让用户确认没选错）', () => {
    const text = describeBackup(makeBackup(baseInput()));
    expect(text).toContain('1 块板');
    expect(text).toContain('1 条事件');
    expect(text).toContain('导出时间');
  });
});
