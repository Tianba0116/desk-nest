import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlacementStore } from '../../src/main/desktop/placement-store';

const placement = {
  displayId: 7,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  relX: 0.25,
  relY: 1,
};

describe('PlacementStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pet-placement-'));
    file = join(dir, 'nested', 'pet-placement.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时返回 null', () => {
    expect(new PlacementStore(file).load()).toBeNull();
  });

  it('保存后可以读回，且不留临时文件', () => {
    const store = new PlacementStore(file);
    store.save(placement);
    expect(store.load()).toEqual(placement);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('再次保存覆盖旧值', () => {
    const store = new PlacementStore(file);
    store.save(placement);
    store.save({ ...placement, relX: 0.75 });
    expect(store.load()?.relX).toBe(0.75);
  });

  it.each([
    ['损坏的 JSON', '{"version":1,'],
    ['未知版本', JSON.stringify({ version: 2, placement })],
    ['比例越界', JSON.stringify({ version: 1, placement: { ...placement, relX: 3 } })],
    ['缺字段', JSON.stringify({ version: 1, placement: { displayId: 7 } })],
  ])('%s 时返回 null', (_name, content) => {
    const store = new PlacementStore(file);
    store.save(placement); // 先建出目录
    writeFileSync(file, content, 'utf8');
    expect(store.load()).toBeNull();
  });
});
