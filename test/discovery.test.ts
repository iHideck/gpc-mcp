import { describe, expect, it } from 'vitest';
import { apiMethodIds, specViolations } from './discovery.ts';

const PUBLISHER = 'https://androidpublisher.googleapis.com';
const APP = '/androidpublisher/v3/applications/com.example.app';

function publisher(pathAndQuery: string): URL {
  return new URL(pathAndQuery, PUBLISHER);
}

describe('specViolations', () => {
  it('仕様どおりのリクエストは通す', () => {
    expect(specViolations('POST', publisher(`${APP}/edits`), {})).toEqual([]);
    expect(
      specViolations(
        'POST',
        publisher(`${APP}/edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`),
      ),
    ).toEqual([]);
    expect(
      specViolations('PUT', publisher(`${APP}/edits/e1/tracks/production`), {
        track: 'production',
        releases: [
          {
            status: 'inProgress',
            userFraction: 0.1,
            versionCodes: ['12'],
            releaseNotes: [{ language: 'ja-JP', text: '直した' }],
          },
        ],
      }),
    ).toEqual([]);
    expect(specViolations('GET', publisher(`${APP}/tracks/production/releases`))).toEqual([]);
    expect(
      specViolations(
        'GET',
        new URL('https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=1000'),
      ),
    ).toEqual([]);
  });

  it('メディアの送信は、本文を照らさず、パスと引数だけを照らす', () => {
    expect(
      specViolations(
        'POST',
        publisher(`/upload${APP}/edits/e1/listings/ja-JP/phoneScreenshots?uploadType=media`),
      ),
    ).toEqual([]);
    expect(
      specViolations(
        'POST',
        publisher(`/upload${APP}/edits/e1/listings/ja-JP/screenshots?uploadType=media`),
      ),
    ).toEqual(['引数 imageType に screenshots は使えません']);
  });

  it('仕様に無い操作を挙げる', () => {
    expect(specViolations('GET', publisher(`${APP}/edit`))).toEqual([
      `GET ${APP}/edit は、仕様に無い操作です`,
    ]);
    expect(specViolations('PATCH', publisher(`${APP}/edits`))).toEqual([
      `PATCH ${APP}/edits は、仕様に無い操作です`,
    ]);
  });

  it('仕様に無い引数と値を挙げる', () => {
    expect(
      specViolations(
        'POST',
        publisher(`${APP}/edits/e1:commit?changesInReview=1&changesNotSentForReview=yes`),
      ),
    ).toEqual([
      'POST /androidpublisher/v3/applications/{packageName}/edits/{editId}:commit に、引数 changesInReview はありません',
      '引数 changesNotSentForReview は真偽値です',
    ]);
    expect(
      specViolations('POST', publisher(`${APP}/edits/e1:commit?changesInReviewBehavior=CANCEL`)),
    ).toEqual(['引数 changesInReviewBehavior に CANCEL は使えません']);
  });

  it('本文の、仕様に無い名前と値・違う型を挙げる', () => {
    expect(
      specViolations('PUT', publisher(`${APP}/edits/e1/tracks/production`), {
        track: 'production',
        releases: [
          {
            status: 'live',
            versionCodes: '12',
            userFraction: '0.1',
            releaseNote: [],
          },
        ],
      }),
    ).toEqual([
      '本文.releases[0].status に "live" は使えません',
      '本文.releases[0].versionCodes は配列です',
      '本文.releases[0].userFraction は数です',
      '本文.releases[0].releaseNote は、仕様にありません',
    ]);
  });

  it('本文を受け取らない操作への本文と、本文が要る操作の欠けた本文を挙げる', () => {
    expect(specViolations('POST', publisher(`${APP}/edits/e1:commit`), {})).toEqual([
      'POST /androidpublisher/v3/applications/{packageName}/edits/{editId}:commit は、本文を受け取りません',
    ]);
    expect(specViolations('PUT', publisher(`${APP}/edits/e1/details`))).toEqual([
      'PUT /androidpublisher/v3/applications/{packageName}/edits/{editId}/details には、本文が要ります',
    ]);
  });

  it('仕様で deprecated の引数を使うと挙げる', () => {
    expect(
      specViolations(
        'POST',
        publisher(
          `/upload${APP}/edits/e1/bundles?uploadType=media&ackBundleInstallationWarning=true`,
        ),
      ),
    ).toEqual(['引数 ackBundleInstallationWarning は、仕様で deprecated です']);
  });
});

describe('Google Play の API に無い操作', () => {
  it('審査の取り下げと、マネージド公開の公開の操作は、まだ API に無い', () => {
    // 名前が増えたら、Google が操作を足したかもしれない。ツールを作る
    expect(
      apiMethodIds().filter((id) => /\.(edits|applications)\..*(cancel|publish|submit)/i.test(id)),
    ).toEqual([]);
  });
});
