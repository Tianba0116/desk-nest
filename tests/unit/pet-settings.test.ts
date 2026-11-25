import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PetSettingsFile, PetSettingsService } from '../../src/main/desktop/pet-settings';
import { DEFAULT_PET_SETTINGS, petWindowSize } from '../../src/shared/contracts/pet-settings';

describe('PetSettingsService', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pet-settings-'));
    file = join(dir, 'pet-settings.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('没有文件时使用默认值', () => {
    expect(new PetSettingsService(new PetSettingsFile(file)).value).toEqual(DEFAULT_PET_SETTINGS);
  });

  it('修改后保存，重新加载得到相同的值', () => {
    new PetSettingsService(new PetSettingsFile(file)).update({ size: 'large', reducedMotion: true });
    expect(new PetSettingsService(new PetSettingsFile(file)).value).toEqual({
      ...DEFAULT_PET_SETTINGS,
      size: 'large',
      reducedMotion: true,
    });
  });

  it('只在值变化时通知', () => {
    const service = new PetSettingsService(new PetSettingsFile(file));
    const seen: string[] = [];
    service.onChange((next) => seen.push(next.size));
    service.update({ size: 'medium' });
    service.update({ size: 'small' });
    expect(seen).toEqual(['small']);
  });

  it('拒绝非法值', () => {
    const service = new PetSettingsService(new PetSettingsFile(file));
    expect(() => service.update({ size: 'huge' as never })).toThrow();
    expect(service.value.size).toBe('medium');
  });

  it('文件中单个字段无效时只回退该字段', () => {
    writeFileSync(file, JSON.stringify({ version: 1, settings: { size: 'huge', reducedMotion: true } }));
    expect(new PetSettingsService(new PetSettingsFile(file)).value).toEqual({
      ...DEFAULT_PET_SETTINGS,
      reducedMotion: true,
    });
  });
});

describe('petWindowSize', () => {
  it('三档尺寸', () => {
    expect(petWindowSize('small')).toEqual({ width: 120, height: 120 });
    expect(petWindowSize('medium')).toEqual({ width: 160, height: 160 });
    expect(petWindowSize('large')).toEqual({ width: 208, height: 208 });
  });
});
