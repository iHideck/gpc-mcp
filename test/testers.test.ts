import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { getTesters, setTesters } from '../plugin/src/testers.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const request = { packageName: PACKAGE, track: 'alpha' };
const GROUPS = ['a@googlegroups.com', 'b@googlegroups.com'];

function setup(testers: Record<string, string[]> = {}) {
  const fake = fakePlay({ testers });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

function openSnapshot(fake: ReturnType<typeof setup>['fake']) {
  const [[id] = []] = fake.openEdits();
  return fake.snapshotOf(id ?? '');
}

describe('getTesters', () => {
  it('トラックの Google グループを返す', async () => {
    const { play } = setup({ alpha: GROUPS });

    expect(await getTesters(play, request)).toEqual({
      ...request,
      googleGroups: GROUPS,
      pending: null,
    });
  });

  it('グループが無ければ空を返す', async () => {
    const { play } = setup();

    expect((await getTesters(play, request)).googleGroups).toEqual([]);
  });
});

describe('setTesters', () => {
  it('まだ送っていない変更に入れ、公開中の状態は変えない', async () => {
    const { fake, play } = setup({ alpha: ['old@googlegroups.com'] });

    const result = await setTesters(play, { ...request, googleGroups: GROUPS });

    expect(result.before).toEqual(['old@googlegroups.com']);
    expect(result.after).toEqual(GROUPS);
    expect(result.pending?.changes).toEqual(['alpha のテスターの Google グループを変えた']);
    expect(openSnapshot(fake)?.testers.alpha).toEqual(GROUPS);
    expect(fake.live.testers.alpha).toEqual(['old@googlegroups.com']);
  });

  it('同じグループなら、順番が違っても、何も送らない', async () => {
    const { fake, play } = setup({ alpha: GROUPS });

    const result = await setTesters(play, { ...request, googleGroups: [...GROUPS].reverse() });

    expect(result.pending).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('同じグループを2回渡しても、1つにして送る', async () => {
    const { fake, play } = setup();

    await setTesters(play, { ...request, googleGroups: [GROUPS[0] ?? '', GROUPS[0] ?? ''] });

    expect(openSnapshot(fake)?.testers.alpha).toEqual([GROUPS[0]]);
  });

  it('空を渡すと全部外す', async () => {
    const { fake, play } = setup({ alpha: GROUPS });

    await setTesters(play, { ...request, googleGroups: [] });

    expect(openSnapshot(fake)?.testers.alpha).toEqual([]);
  });
});
