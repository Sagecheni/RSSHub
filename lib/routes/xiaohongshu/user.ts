import querystring from 'node:querystring';

import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import { getUser, getUserCollect, getUserWithCookie, renderNotesFulltext } from './util';

export const route: Route = {
    path: '/user/:user_id/:category/:routeParams?',
    name: '用户笔记/收藏',
    categories: ['social-media'],
    view: ViewType.Articles,
    maintainers: ['lotosbin', 'howerhe', 'rien7', 'dddaniel1', 'pseudoyu'],
    handler,
    radar: [
        {
            source: ['xiaohongshu.com/user/profile/:user_id'],
            target: '/user/:user_id/notes',
        },
    ],
    example: '/xiaohongshu/user/593032945e87e77791e03696/notes',
    features: {
        antiCrawler: true,
        requirePuppeteer: true,
        requireConfig: [
            {
                name: 'XIAOHONGSHU_COOKIE',
                optional: true,
                description: '小红书 cookie 值，可在网络里面看到。',
            },
        ],
    },
    parameters: {
        user_id: 'user id, length 24 characters',
        category: {
            description: 'category, notes or collect',
            options: [
                {
                    value: 'notes',
                    label: 'notes',
                },
                {
                    value: 'collect',
                    label: 'collect',
                },
            ],
            default: 'notes',
        },
        routeParams: {
            description: 'displayLivePhoto,`/user/:user_id/notes/displayLivePhoto=0`,不限时LivePhoto显示为图片,`/user/:user_id/notes/displayLivePhoto=1`,取值不为0时LivePhoto显示为视频',
            default: '0',
        },
    },
};

async function handler(ctx) {
    const userId = ctx.req.param('user_id');
    const category = ctx.req.param('category');
    const routeParams = querystring.parse(ctx.req.param('routeParams'));
    const displayLivePhoto = !!fallback(undefined, queryToBoolean(routeParams.displayLivePhoto), false);
    const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
    const cookie = config.xiaohongshu.cookie;

    if (cookie && category === 'notes') {
        try {
            const urlNotePrefix = 'https://www.xiaohongshu.com/explore';
            const user = await getUserWithCookie(url);
            const notes = await renderNotesFulltext(user.notes, urlNotePrefix, displayLivePhoto);
            return {
                title: `${user.userPageData.basicInfo.nickname} - 笔记 • 小红书 / RED`,
                description: user.userPageData.basicInfo.desc,
                image: user.userPageData.basicInfo.imageb || user.userPageData.basicInfo.images,
                link: url,
                item: notes,
            };
        } catch {
            // Fallback to normal logic if cookie method fails
            return await getUserFeeds(url, category);
        }
    } else {
        return await getUserFeeds(url, category);
    }
}

async function getUserFeeds(url: string, category: string) {
    const {
        userPageData: { basicInfo, interactions, tags },
        notes,
    } = await getUser(url, cache);
    const collect = category === 'collect' ? await getUserCollect(url, cache) : undefined;

    const title = `${basicInfo.nickname} - 小红书${category === 'notes' ? '笔记' : '收藏'}`;
    const description = `${basicInfo.desc} ${tags.map((t) => t.name).join(' ')} ${interactions.map((i) => `${i.count} ${i.name}`).join(' ')}`;
    const image = basicInfo.imageb || basicInfo.images;

    const renderNote = (notes) =>
        notes.flatMap((n) =>
            n.map(({ id, noteCard }) => ({
                title: noteCard.displayTitle,
                link: new URL(noteCard.noteId || id, url).toString(),
                guid: noteCard.displayTitle,
                description: `<img src ="${noteCard.cover.infoList.pop().url} width="${noteCard.cover.width}" height="${noteCard.cover.height}"><br>${noteCard.displayTitle}`,
                author: noteCard.user.nickname,
                upvotes: noteCard.interactInfo.likedCount,
            }))
        );
    const renderCollect = (collect) => {
        if (!collect) {
            throw new InvalidParameterError('该用户已设置收藏内容不可见');
        }
        if (typeof collect.code === 'number' && collect.code !== 0) {
            throw new Error(JSON.stringify(collect));
        }

        const notes = collect?.data?.notes || collect?.data?.note_list || collect?.notes || collect?.noteList || collect;
        if (!Array.isArray(notes) || notes.length === 0) {
            throw new InvalidParameterError('该用户已设置收藏内容不可见');
        }

        return notes.map((item) => {
            const title = item.display_title || item.title || item.noteCard?.displayTitle || '收藏笔记';
            const noteId = item.note_id || item.noteId || item.noteCard?.noteId || item.id;
            const coverList = item.cover?.info_list || item.cover?.infoList || item.noteCard?.cover?.infoList || [];
            const cover = coverList.length ? coverList[coverList.length - 1].url : item.cover?.url;
            return {
                title,
                link: noteId ? `${url}/${noteId}` : url,
                description: cover ? `<img src ="${cover}"><br>${title}` : title,
                author: item.user?.nickname || item.user?.nickName || item.noteCard?.user?.nickname,
                upvotes: item.interact_info?.likedCount || item.interactInfo?.likedCount,
            };
        });
    };

    return {
        title,
        description,
        image,
        link: url,
        item: category === 'notes' ? renderNote(notes) : renderCollect(collect),
    };
}
