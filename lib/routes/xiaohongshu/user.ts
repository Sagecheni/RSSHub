import querystring from 'node:querystring';

import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import { checkCookie, escapeAttribute, getUser, getUserCollect, getUserWithCookie, renderNotesFulltext, sanitizeImageUrl } from './util';

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

    const debugInfo: Record<string, unknown> = {
        category,
        profileUrl: url,
        cookieProvided: Boolean(cookie),
    };

    try {
        if (!cookie) {
            debugInfo.cookieValid = false;
            debugInfo.abortReason = 'missing_cookie';
            throw new InvalidParameterError('访问小红书内容需要配置 XIAOHONGSHU_COOKIE');
        }

        let cookieValid = false;
        try {
            cookieValid = await checkCookie();
            debugInfo.cookieCheckTime = new Date().toISOString();
        } catch (error) {
            debugInfo.cookieValid = false;
            debugInfo.cookieCheckError = error instanceof Error ? error.message : String(error);
            debugInfo.abortReason = 'cookie_check_failed';
            throw new InvalidParameterError('无法验证 XIAOHONGSHU_COOKIE，请稍后再试');
        }

        debugInfo.cookieValid = cookieValid;
        if (!cookieValid) {
            debugInfo.abortReason = 'cookie_invalid';
            throw new InvalidParameterError('当前配置的 XIAOHONGSHU_COOKIE 已失效，请更新后再抓取');
        }

        if (category === 'notes') {
            debugInfo.noteFetchStrategy = 'cookie';
            try {
                const urlNotePrefix = 'https://www.xiaohongshu.com/explore';
                const user = await getUserWithCookie(url);
                const noteGroups = Array.isArray(user.notes) ? user.notes : [];
                const flattenedNotes = typeof noteGroups.flat === 'function' ? noteGroups.flat().filter(Boolean) : noteGroups;
                debugInfo.availableNoteCards = flattenedNotes.length;
                const xsecDetected = flattenedNotes.some((note) => typeof note?.id === 'string' && /[?&]xsec_token=/.test(note.id));
                debugInfo.xsecTokenDetected = xsecDetected;
                if (!xsecDetected) {
                    debugInfo.abortReason = 'missing_xsec_token';
                    const error = new InvalidParameterError('需要先在浏览器中完成登录并访问任意视频笔记，以激活 XIAOHONGSHU_COOKIE 后再抓取');
                    (error as InvalidParameterError & { missingXsecToken?: boolean }).missingXsecToken = true;
                    throw error;
                }
                const notes = await renderNotesFulltext(user.notes, urlNotePrefix, displayLivePhoto);
                debugInfo.noteItemsReturned = notes.length;
                return {
                    title: `${user.userPageData.basicInfo.nickname} - 笔记 • 小红书 / RED`,
                    description: user.userPageData.basicInfo.desc,
                    image: user.userPageData.basicInfo.imageb || user.userPageData.basicInfo.images,
                    link: url,
                    item: notes,
                };
            } catch (error) {
                debugInfo.noteFetchStrategy = 'cookie';
                debugInfo.cookieNotesError = error instanceof Error ? error.message : String(error);
                if ((error as InvalidParameterError & { missingXsecToken?: boolean })?.missingXsecToken) {
                    throw error;
                }
                debugInfo.abortReason = 'cookie_fetch_failed';
                throw error instanceof InvalidParameterError ? error : new InvalidParameterError('使用 XIAOHONGSHU_COOKIE 抓取笔记失败，请检查登录状态或稍后再试');
            }
        }

        debugInfo.noteFetchStrategy = category === 'notes' ? 'puppeteer' : 'collect';
        return await getUserFeeds(url, category);
    } finally {
        ctx.set('json', debugInfo);
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
            n.map(({ id, noteCard }) => {
                const infoList = Array.isArray(noteCard.cover?.infoList) ? noteCard.cover.infoList : [];
                const coverCandidate = infoList.at(-1);
                const coverUrl = sanitizeImageUrl(coverCandidate?.url || coverCandidate?.urlDefault);
                const widthValue = Number(noteCard.cover?.width);
                const heightValue = Number(noteCard.cover?.height);
                const widthAttr = Number.isFinite(widthValue) && widthValue > 0 ? ` width="${widthValue}"` : '';
                const heightAttr = Number.isFinite(heightValue) && heightValue > 0 ? ` height="${heightValue}"` : '';
                const coverHtml = coverUrl ? `<img src="${escapeAttribute(coverUrl)}"${widthAttr}${heightAttr}>` : '';
                return {
                    title: noteCard.displayTitle,
                    link: new URL(noteCard.noteId || id, url).toString(),
                    guid: noteCard.displayTitle,
                    description: coverHtml ? `${coverHtml}<br>${noteCard.displayTitle}` : noteCard.displayTitle,
                    author: noteCard.user.nickname,
                    upvotes: noteCard.interactInfo.likedCount,
                };
            })
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
            const coverCandidate = coverList.length ? coverList.at(-1) : null;
            const cover = sanitizeImageUrl(coverCandidate?.url || coverCandidate?.urlDefault || item.cover?.url);
            return {
                title,
                link: noteId ? `${url}/${noteId}` : url,
                description: cover ? `<img src="${escapeAttribute(cover)}"><br>${title}` : title,
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
