import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { appPath } from './client.ts';
import type { Play } from './edits.ts';

export type SetDataSafetyRequest = { packageName: string; file: string };

export type SetDataSafetyResult = { packageName: string; file: string; rows: number };

export async function setDataSafety(
  { client }: Play,
  { packageName, file }: SetDataSafetyRequest,
): Promise<SetDataSafetyResult> {
  const csv = await readCsv(file);
  await client.post(
    `${appPath(packageName)}/dataSafety`,
    {},
    { safetyLabels: csv },
    // Google の仕様の応答は、中身の無いオブジェクト
    z.unknown(),
  );
  return { packageName, file: basename(file), rows: csv.trim().split('\n').length - 1 };
}

async function readCsv(file: string): Promise<string> {
  if (!isAbsolute(file)) {
    throw new Error(`CSV は、絶対パスで渡してください: ${file}`);
  }
  let csv: string;
  try {
    csv = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`CSV のファイル ${file} を読めません。`, { cause: error });
  }
  const header = csv.split('\n', 1)[0] ?? '';
  if (!/question id/i.test(header) || !/response value/i.test(header)) {
    throw new Error(
      `${file} は、データセーフティの CSV ではないようです。Play Console のデータセーフティの画面から書き出せる形（Question ID・Response value などの列）にしてください。何も送っていません。`,
    );
  }
  return csv;
}
