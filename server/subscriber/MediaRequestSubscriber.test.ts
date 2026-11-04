import type { Tag } from '@server/api/servarr/base';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import type { InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const settings = getSettings();
const originalRadarr = settings.radarr;
const originalSonarr = settings.sonarr;

afterEach(() => {
  mock.restoreAll();
  settings.radarr = originalRadarr;
  settings.sonarr = originalSonarr;
  cacheManager.getCache('tmdb').flush();
});

/** Sends a request through the real subscriber and API clients with an in-memory transport. */
async function sendRequest(
  type: MediaType,
  displayName: string,
  existingTags: Tag[],
  { userId = 1, tags = [90], tagRequests = true } = {}
) {
  const configuredTags = [...tags];
  const server: RadarrSettings & SonarrSettings = {
    id: 0,
    name: 'Test server',
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test',
    useSsl: false,
    isDefault: true,
    is4k: false,
    activeDirectory: '/media',
    activeProfileId: 1,
    activeProfileName: 'HD',
    tags,
    tagRequests,
    syncEnabled: false,
    preventSearch: true,
    overrideRule: [],
    minimumAvailability: 'released',
    seriesType: 'standard',
    animeSeriesType: 'anime',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
  };
  settings.radarr = [server];
  settings.sonarr = [server];

  const media = Object.assign(new Media(), {
    id: 10,
    tmdbId: 100,
    tvdbId: 200,
    mediaType: type,
    status: MediaStatus.PENDING,
  });
  const request = Object.assign(new MediaRequest(), {
    id: 20,
    type,
    is4k: false,
    status: MediaRequestStatus.APPROVED,
    media,
    requestedBy: new User({ id: userId, displayName }),
    seasons: [{ seasonNumber: 1 }],
  });
  const persisted = Promise.withResolvers<void>();
  const repository = {
    findOne: async () => media,
    save: async () => {
      persisted.resolve();
      return media;
    },
  };
  mock.method(
    dataSource.manager,
    'getRepository',
    (() => repository) as unknown as typeof dataSource.manager.getRepository
  );

  const createdLabels: string[] = [];
  const sentTags: number[][] = [];
  let tagReads = 0;
  const client = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      let data: unknown;
      if (config.method === 'get' && config.url === '/tag') {
        tagReads++;
        data = existingTags;
      } else if (config.method === 'post' && config.url === '/tag') {
        const { label } = JSON.parse(config.data) as { label: string };
        createdLabels.push(label);
        data = { id: 42, label };
      } else if (config.method === 'get' && config.url === '/movie/100') {
        data = { id: 100, title: 'Test movie', release_date: '2026-01-01' };
      } else if (config.method === 'get' && config.url === '/tv/100') {
        data = {
          id: 100,
          name: 'Test series',
          external_ids: { tvdb_id: 200 },
          keywords: { results: [] },
        };
      } else if (
        config.method === 'get' &&
        (config.url === '/movie/lookup' || config.url === '/series/lookup')
      ) {
        data = [{ seasons: [{ seasonNumber: 1, monitored: false }] }];
      } else if (
        config.method === 'post' &&
        (config.url === '/movie' || config.url === '/series')
      ) {
        const body = JSON.parse(config.data) as { tags: number[] };
        sentTags.push(body.tags);
        data = { id: 50, titleSlug: 'test-title' };
      } else {
        throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      }
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  mock.method(axios, 'create', () => client);

  const subscriber = new MediaRequestSubscriber();
  if (type === MediaType.MOVIE) {
    await subscriber.sendToRadarr(request, dataSource.manager);
  } else {
    await subscriber.sendToSonarr(request, dataSource.manager);
  }
  await persisted.promise;
  await setImmediate();
  assert.equal(request.status, MediaRequestStatus.APPROVED);
  assert.equal(sentTags.length, 1);
  assert.deepEqual(server.tags, configuredTags);

  return { createdLabels, sentTags: sentTags[0], tagReads };
}

for (const [method, type] of [
  ['sendToRadarr', MediaType.MOVIE],
  ['sendToSonarr', MediaType.TV],
] as const) {
  describe(`${method} username-only request tags`, { timeout: 5000 }, () => {
    it(`${method}_shouldReuseRenamedTagWithoutMatchingPrefixes`, async () => {
      // setup
      const tags = [
        { id: 40, label: '1-Pim' },
        { id: 41, label: 'pim-other' },
        { id: 42, label: 'pim' },
      ];

      // execute
      const result = await sendRequest(type, 'Pim', tags);

      // verify
      assert.deepEqual(result.createdLabels, []);
      assert.deepEqual(result.sentTags, [90, 42]);
    });

    for (const [userId, displayName, expectedLabel] of [
      [8, 'sanne', 'sanne'],
      [17, 'Élodie van Dijk!', 'Elodie-van-Dijk'],
      [23, '1-the-man', '1-the-man'],
    ] as const) {
      it(`${method}_shouldCreateUsernameOnlyTagForUser${userId}`, async () => {
        // setup
        const tags = [{ id: 40, label: `${userId}-${expectedLabel}` }];

        // execute
        const result = await sendRequest(type, displayName, tags, { userId });

        // verify
        assert.deepEqual(result.createdLabels, [expectedLabel]);
        assert.deepEqual(result.sentTags, [90, 42]);
      });
    }

    it(`${method}_shouldNotDuplicateConfiguredUserTag`, async () => {
      // setup
      const tags = [{ id: 42, label: 'sanne' }];

      // execute
      const result = await sendRequest(type, 'sanne', tags, { tags: [90, 42] });

      // verify
      assert.deepEqual(result.createdLabels, []);
      assert.deepEqual(result.sentTags, [90, 42]);
    });

    for (const [displayName, tagRequests] of [
      ['sanne', false],
      ['✨', true],
    ] as const) {
      it(`${method}_shouldSkipTaggingFor${tagRequests ? 'EmptyLabel' : 'DisabledSetting'}`, async () => {
        // setup
        const tags = [{ id: 42, label: 'sanne' }];

        // execute
        const result = await sendRequest(type, displayName, tags, {
          tagRequests,
        });

        // verify
        assert.equal(result.tagReads, 0);
        assert.deepEqual(result.createdLabels, []);
        assert.deepEqual(result.sentTags, [90]);
      });
    }
  });
}
