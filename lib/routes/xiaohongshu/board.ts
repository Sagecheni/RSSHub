import type { Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

import { escapeAttribute, getBoard, sanitizeImageUrl } from './util';

export const route: Route = {
    path: '/board/:board_id',
    categories: ['social-media'],
    example: '/xiaohongshu/board/5db6f79200000000020032df',
    parameters: { board_id: '专辑 ID' },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['xiaohongshu.com/board/:board_id'],
        },
    ],
    name: '专辑',
    maintainers: ['lotosbin'],
    handler,
};

async function handler(ctx) {
    const url = `https://www.xiaohongshu.com/board/${ctx.req.param('board_id')}`;
    const main = await getBoard(url, cache);

    const albumInfo = main.albumInfo;
    const title = albumInfo.name;
    const description = albumInfo.desc;
    const image = sanitizeImageUrl(albumInfo.user.images?.split('?imageView2')[0] || albumInfo.user.images);

    const list = main.notesDetail;
    const resultItem = list.map((item) => {
        const rawCover = item.cover?.url || '';
        const coverUrl = sanitizeImageUrl(rawCover.includes('?imageView2') ? rawCover.split('?imageView2')[0] : rawCover);
        const description = coverUrl ? `<img src="${escapeAttribute(coverUrl)}"><br>${item.title}` : item.title;
        return {
            title: item.title,
            link: `https://www.xiaohongshu.com/discovery/item/${item.id}`,
            description,
            author: item.user.nickname,
            pubDate: timezone(parseDate(item.time), 8),
        };
    });

    return {
        title,
        link: url,
        image,
        item: resultItem,
        description,
    };
}
