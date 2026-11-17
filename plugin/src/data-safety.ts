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
    throw new Error(`Pass the CSV as an absolute path: ${file}`);
  }
  let csv: string;
  try {
    csv = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the CSV file ${file}.`, { cause: error });
  }
  const header = csv.split('\n', 1)[0] ?? '';
  if (!/question id/i.test(header) || !/response value/i.test(header)) {
    throw new Error(
      `${file} does not look like a Data safety CSV. Use the format that the Data safety page in Play Console exports, with columns such as Question ID and Response value. Nothing was sent.`,
    );
  }
  return csv;
}
