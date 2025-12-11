import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { load } from 'cheerio';

import { config } from '@/config';
import CaptchaError from '@/errors/types/captcha';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import puppeteer, { getPuppeteerPage } from '@/utils/puppeteer';
import { setCookies } from '@/utils/puppeteer-utils';

// Common headers for requests
const sanitizeCookieString = (cookie?: string) => {
    if (!cookie) {
        return '';
    }
    const forbidden = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
    const segments = cookie
        .split(/;\s*/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
            const eqIndex = segment.indexOf('=');
            if (eqIndex === -1) {
                return null;
            }
            const key = segment.slice(0, eqIndex).trim();
            const value = segment.slice(eqIndex + 1).trim();
            if (!key || forbidden.has(key.toLowerCase())) {
                return null;
            }
            return `${key}=${value}`;
        })
        .filter(Boolean);
    return segments.join('; ');
};

const getHeaders = (cookie?: string) => ({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Host: 'www.xiaohongshu.com',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ...(cookie ? { Cookie: sanitizeCookieString(cookie) } : {}),
});

const shouldDumpCollectHtml = (() => {
    const flag = process.env.XHS_DUMP ?? '';
    return ['1', 'true', 'yes'].includes(flag.toLowerCase());
})();

const COLLECT_NOTE_SELECTOR = '#userPostedFeeds section.note-item';
const COLLECT_API_PATH = '/api/sns/web/v2/note/collect/page';

const isCollectApiRequest = (request) => {
    try {
        return request.url().includes(COLLECT_API_PATH) && request.method() === 'GET';
    } catch {
        return false;
    }
};

const isCollectApiResponse = (response) => {
    try {
        const request = response.request();
        return isCollectApiRequest(request);
    } catch {
        return false;
    }
};

const dumpCollectPage = async (page, stage: string) => {
    if (!shouldDumpCollectHtml) {
        return;
    }
    try {
        const html = await page.content();
        const logsDir = path.join(process.cwd(), 'logs');
        await mkdir(logsDir, { recursive: true });
        const filePath = path.join(logsDir, `xhs-collect-${stage}-${Date.now()}.html`);
        await writeFile(filePath, html, 'utf8');
        logger.warn(`Dumped Xiaohongshu collect page to ${filePath}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`Failed to dump Xiaohongshu collect page: ${message}`);
    }
};

const readInitialStateFromHtml = async (page) => {
    try {
        const html = await page.content();
        const $ = load(html);
        const script = extractInitialState($);
        if (script) {
            return JSON.parse(script);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`Failed to read initial state from HTML: ${message}`);
    }
};

const unwrapVueValue = (value) => (value && typeof value === 'object' && '_rawValue' in value ? value._rawValue : value);

const wrapNotesAsCollect = (notes) => (Array.isArray(notes) && notes.length ? { data: { notes } } : null);

const hasCollectNotes = (collect) => {
    if (!collect) {
        return false;
    }
    const list = collect?.data?.notes || collect?.data?.note_list || collect?.notes || collect?.noteList;
    if (Array.isArray(list)) {
        return list.length > 0;
    }
    return Array.isArray(collect) && collect.length > 0;
};

const extractCollectFromState = (state) => {
    if (!state?.user) {
        return null;
    }
    const userState = state.user;
    const collect = unwrapVueValue(userState.collect);
    if (collect && hasCollectNotes(collect)) {
        return collect;
    }

    const notes = unwrapVueValue(userState.notes);
    if (!Array.isArray(notes)) {
        return null;
    }

    const activeSubTab = unwrapVueValue(userState.activeSubTab);
    if (typeof activeSubTab?.index === 'number') {
        const target = notes[activeSubTab.index];
        const wrapped = wrapNotesAsCollect(target);
        if (wrapped) {
            return wrapped;
        }
    }

    for (const bucket of notes) {
        const wrapped = wrapNotesAsCollect(bucket);
        if (wrapped) {
            return wrapped;
        }
    }

    return null;
};

const scrollCollectList = async (page, maxRounds = 5) => {
    let lastCount = 0;
    try {
        lastCount = await page.evaluate((selector) => document.querySelectorAll(selector).length, COLLECT_NOTE_SELECTOR);
    } catch {
        lastCount = 0;
    }
    for (let i = 0; i < maxRounds; i++) {
        // eslint-disable-next-line no-await-in-loop
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const userPage = document.querySelector('.user-page');
            if (userPage) {
                userPage.scrollTop = userPage.scrollHeight;
            }
        });
        // eslint-disable-next-line no-await-in-loop
        const increased = await page
            .waitForFunction((selector, previous) => document.querySelectorAll(selector).length > previous, { timeout: 5000 }, COLLECT_NOTE_SELECTOR, lastCount)
            .then(
                () => true,
                () => false
            );
        let currentCount = lastCount;
        try {
            // eslint-disable-next-line no-await-in-loop
            currentCount = await page.evaluate((selector) => document.querySelectorAll(selector).length, COLLECT_NOTE_SELECTOR);
        } catch {
            currentCount = lastCount;
        }
        if (!increased || currentCount <= lastCount) {
            break;
        }
        lastCount = currentCount;
    }
    return lastCount;
};

const selectCollectNotes = (collect) => {
    if (!collect) {
        return [];
    }
    if (Array.isArray(collect)) {
        return collect.filter(Boolean);
    }
    const data = collect.data ?? collect;
    if (Array.isArray(data?.notes)) {
        return data.notes.filter(Boolean);
    }
    if (Array.isArray(data?.note_list)) {
        return data.note_list.filter(Boolean);
    }
    if (Array.isArray(collect.notes)) {
        return collect.notes.filter(Boolean);
    }
    if (Array.isArray(collect.noteList)) {
        return collect.noteList.filter(Boolean);
    }
    return [];
};

const mergeCollectSources = (...sources) => {
    const merged = [];
    const seen = new Set();
    for (const source of sources) {
        const notes = selectCollectNotes(source);
        for (const note of notes) {
            if (!note) {
                continue;
            }
            const noteId = note.note_id || note.noteId || note.id;
            if (noteId && seen.has(noteId)) {
                continue;
            }
            if (noteId) {
                seen.add(noteId);
            }
            merged.push(note);
        }
    }
    if (!merged.length) {
        return null;
    }
    return {
        data: {
            notes: merged,
        },
    };
};

const hasMoreCollectFlag = (collect) => {
    if (!collect) {
        return null;
    }
    const data = collect.data ?? collect;
    if (typeof data?.has_more === 'boolean') {
        return data.has_more;
    }
    if (typeof data?.hasMore === 'boolean') {
        return data.hasMore;
    }
    return null;
};

const getUser = (url, cache) =>
    cache.tryGet(
        url,
        async () => {
            const { page, destory } = await getPuppeteerPage(url, {
                onBeforeLoad: async (page) => {
                    await page.setRequestInterception(true);
                    page.on('request', (request) => {
                        request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || request.resourceType() === 'other'
                            ? request.continue()
                            : request.abort();
                    });
                    const cookie = sanitizeCookieString(config.xiaohongshu.cookie);
                    if (cookie) {
                        await page.setExtraHTTPHeaders({
                            Cookie: cookie,
                        });
                        try {
                            await setCookies(page, cookie, '.xiaohongshu.com');
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            logger.debug(`Failed to set cookies in puppeteer for user page: ${message}`);
                        }
                    }
                },
            });
            try {
                logger.http(`Requesting ${url}`);
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                });
                await page.waitForSelector('div.reds-tab-item:nth-child(2), #red-captcha');

                if (await page.$('#red-captcha')) {
                    throw new CaptchaError('小红书风控校验，请稍后再试');
                }

                let initialState = await page.evaluate(() => (window as any).__INITIAL_STATE__);
                if (!initialState?.user) {
                    initialState = await readInitialStateFromHtml(page);
                }

                if (!initialState?.user) {
                    const currentUrl = page.url();
                    if (/passport|login/.test(currentUrl)) {
                        throw new InvalidParameterError('访问用户内容需要配置 XIAOHONGSHU_COOKIE');
                    }
                    throw new InvalidParameterError('无法获取用户数据，请稍后再试');
                }

                let { userPageData, notes } = initialState.user;
                userPageData = userPageData._rawValue || userPageData;
                notes = notes._rawValue || notes;

                return { userPageData, notes };
            } finally {
                await destory();
            }
        },
        config.cache.routeExpire,
        false
    );

const fetchCollectFromHtml = async (url: string) => {
    if (!config.xiaohongshu.cookie) {
        return null;
    }
    try {
        logger.http(`Requesting ${url} via HTTP for collect`);
        const res = await ofetch(url, {
            headers: getHeaders(config.xiaohongshu.cookie),
        });
        const $ = load(res);
        const script = extractInitialState($);
        if (!script) {
            return null;
        }
        const state = JSON.parse(script);
        return extractCollectFromState(state);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`Failed to fetch collect via HTTP: ${message}`);
        return null;
    }
};

const getUserCollect = (url, cache) =>
    cache.tryGet(
        `${url}?tab=fav&subTab=note`,
        async () => {
            const collectUrl = `${url}?tab=fav&subTab=note`;
            const collectFromHttp = await fetchCollectFromHtml(collectUrl);
            if (collectFromHttp && hasMoreCollectFlag(collectFromHttp) === false) {
                return collectFromHttp;
            }
            const { page, destory } = await getPuppeteerPage(collectUrl, {
                onBeforeLoad: async (page) => {
                    await page.setRequestInterception(true);
                    page.on('request', (request) => {
                        request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || request.resourceType() === 'other'
                            ? request.continue()
                            : request.abort();
                    });
                    const cookie = sanitizeCookieString(config.xiaohongshu.cookie);
                    if (cookie) {
                        await page.setExtraHTTPHeaders({
                            Cookie: cookie,
                        });
                        try {
                            await setCookies(page, cookie, '.xiaohongshu.com');
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            logger.debug(`Failed to set cookies in puppeteer for collect page: ${message}`);
                        }
                    }
                },
            });
            let collectResult = collectFromHttp;
            const collectResponsePromises: Array<Promise<void>> = [];
            const collectPayloads: Array<Record<string, unknown>> = [];
            const handleCollectResponse = async (response) => {
                try {
                    const json = await response.json();
                    collectPayloads.push(json);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`Failed to parse collect API response: ${message}`);
                }
            };
            page.on('response', (response) => {
                if (!isCollectApiResponse(response)) {
                    return;
                }
                const promise = handleCollectResponse(response);
                collectResponsePromises.push(promise);
            });
            try {
                logger.http(`Requesting ${collectUrl}`);
                await page.goto(collectUrl, {
                    waitUntil: 'domcontentloaded',
                });
                await page.waitForSelector('div.reds-tab-item:nth-child(2), #red-captcha', {
                    timeout: 15000,
                });
                try {
                    await page.waitForResponse(isCollectApiResponse, { timeout: 15000 });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`Failed to detect collect API response: ${message}`);
                }

                if (await page.$('#red-captcha')) {
                    throw new CaptchaError('小红书风控校验，请稍后再试');
                }

                const currentUrl = page.url();
                if (/passport|login/.test(currentUrl)) {
                    // 如果命中登录页，说明触发了需要 cookie 的风控，提示用户在配置中提供 XIAOHONGSHU_COOKIE
                    throw new InvalidParameterError('访问收藏内容需要配置 XIAOHONGSHU_COOKIE');
                }

                const triggerCollectByClick = async () => {
                    const hasLockIcon = await page.$('.lock-icon');
                    if (hasLockIcon) {
                        return false;
                    }
                    try {
                        await page.click('div.reds-tab-item:nth-child(2)');
                        await page.waitForResponse(isCollectApiResponse, { timeout: 15000 });
                        return true;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        logger.debug(`Failed to fetch collect data by clicking tab: ${message}`);
                    }
                    return false;
                };

                let initialState = await page.evaluate(() => (window as any).__INITIAL_STATE__);
                if (!initialState?.user) {
                    initialState = await readInitialStateFromHtml(page);
                }
                const ssrCollect = extractCollectFromState(initialState);
                collectResult = mergeCollectSources(collectResult, ssrCollect) ?? collectResult;
                if (!collectResult) {
                    await triggerCollectByClick();
                }
                await scrollCollectList(page, 8);
                await Promise.allSettled(collectResponsePromises);
                const apiCollect = mergeCollectSources(...collectPayloads);
                collectResult = mergeCollectSources(collectResult, apiCollect) ?? collectResult;
                const domCollect = await extractCollectFromDom(page);
                collectResult = mergeCollectSources(collectResult, domCollect) ?? collectResult;
                if (!collectResult) {
                    await dumpCollectPage(page, 'failure');
                    throw new InvalidParameterError('无法获取收藏内容，请稍后再试');
                }

                return collectResult;
            } catch (error) {
                if (collectResult) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`Using partial collect data due to error: ${message}`);
                    return collectResult;
                }
                throw error;
            } finally {
                await destory();
            }
        },
        config.cache.routeExpire,
        false
    );

const parseLikeCount = (text?: string | null) => {
    if (!text) {
        return;
    }
    let normalized = text.trim();
    if (!normalized) {
        return;
    }
    let multiplier = 1;
    if (normalized.includes('万')) {
        multiplier = 10000;
        normalized = normalized.replace('万', '');
    }
    normalized = normalized.replaceAll(/[^\d.]/g, '');
    const value = Number.parseFloat(normalized);
    if (Number.isNaN(value)) {
        return;
    }
    return Math.round(value * multiplier);
};

const extractCollectFromDom = async (page) => {
    const items = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('#userPostedFeeds section.note-item')];
        return sections
            .map((section) => {
                const coverLink = section.querySelector('a.cover');
                const titleEl = section.querySelector('.footer a.title');
                const authorEl = section.querySelector('.author .name');
                const likeEl = section.querySelector('.like-wrapper .count');
                const imgEl = coverLink?.querySelector('img');
                const href = coverLink?.getAttribute('href') || '';
                if (!href) {
                    return null;
                }
                return {
                    href,
                    title: titleEl?.textContent?.trim() || '',
                    author: authorEl?.textContent?.trim() || '',
                    likes: likeEl?.textContent?.trim() || '',
                    cover: imgEl?.getAttribute('src') || '',
                };
            })
            .filter((item) => item && item.href);
    });

    if (!items?.length) {
        return null;
    }

    const notes = items
        .map((item) => {
            const urlObj = new URL(item.href, 'https://www.xiaohongshu.com');
            const segments = urlObj.pathname.split('/').filter(Boolean);
            const noteId = segments.pop();
            if (!noteId) {
                return null;
            }
            const likedCount = parseLikeCount(item.likes);
            const coverList = item.cover ? [{ url: item.cover }] : [];
            return {
                display_title: item.title || '收藏笔记',
                note_id: noteId,
                cover: {
                    info_list: coverList,
                },
                user: {
                    nickname: item.author,
                },
                interact_info: likedCount ? { likedCount } : undefined,
            };
        })
        .filter(Boolean);

    if (!notes.length) {
        return null;
    }

    return {
        data: {
            notes,
        },
    };
};

const getBoard = (url, cache) =>
    cache.tryGet(
        url,
        async () => {
            const browser = await puppeteer();
            try {
                const page = await browser.newPage();
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' ? request.continue() : request.abort();
                });
                logger.http(`Requesting ${url}`);
                await page.goto(url);
                await page.waitForSelector('.pc-container');
                const initialSsrState = await page.evaluate(() => (window as any).__INITIAL_SSR_STATE__);
                return initialSsrState.Main;
            } finally {
                await browser.close();
            }
        },
        config.cache.routeExpire,
        false
    );

const formatText = (text) => text.replaceAll(/(\r\n|\r|\n)/g, '<br>').replaceAll('\t', '&emsp;');

// tag_list.id has nothing to do with its url
const formatTagList = (tagList) => tagList.reduce((acc, item) => acc + `#${item.name} `, ``);

const escapeAttribute = (value?: string) => (typeof value === 'string' ? value.replaceAll('"', '&quot;') : '');
const sanitizeImageUrl = (url?: string | null) => {
    if (!url) {
        return '';
    }
    let sanitized = url.trim();
    if (!sanitized) {
        return '';
    }
    const whitespaceIndex = sanitized.search(/\s/);
    if (whitespaceIndex !== -1) {
        sanitized = sanitized.slice(0, whitespaceIndex);
    }
    const imageViewIndex = sanitized.indexOf('?imageView2');
    if (imageViewIndex !== -1) {
        sanitized = sanitized.slice(0, imageViewIndex);
    }
    return sanitized;
};

const formatImageList = (imageList) =>
    imageList.reduce((acc, item) => {
        const url = sanitizeImageUrl(item.url);
        if (!url) {
            return acc;
        }
        return acc + `<img src="${escapeAttribute(url)}"><br>`;
    }, '');

const formatNote = (url, note) => ({
    title: note.title,
    link: url + '/' + note.noteId,
    description: formatText(note.desc) + '<br><br>' + formatTagList(note.tagList) + '<br><br>' + formatImageList(note.imageList),
    author: note.user.nickname,
    pubDate: parseDate(note.time, 'x'),
    updated: parseDate(note.lastUpdateTime, 'x'),
});

async function renderNotesFulltext(notes, urlPrex, displayLivePhoto) {
    const data: Array<{
        title: string;
        link: string;
        description: string;
        author: string;
        guid: string;
        pubDate: Date;
        updated: Date;
    }> = [];
    const promises = notes.flatMap((note) =>
        note.map(async ({ noteCard, id }) => {
            const link = `${urlPrex}/${id}`;
            const guid = `${urlPrex}/${noteCard.noteId}`;
            const { title, description, pubDate, updated } = await getFullNote(link, displayLivePhoto);
            return {
                title,
                link,
                description,
                author: noteCard.user.nickName,
                guid,
                pubDate,
                updated,
            };
        })
    );
    data.push(...(await Promise.all(promises)));
    return data;
}

async function getFullNote(link, displayLivePhoto) {
    const data = (await cache.tryGet(link, async () => {
        const res = await ofetch(link, {
            headers: getHeaders(config.xiaohongshu.cookie),
        });
        const $ = load(res);
        const script = extractInitialState($);
        const state = JSON.parse(script);
        const note = state.note.noteDetailMap[state.note.firstNoteId].note;
        const title = note.title;
        let desc = note.desc;
        desc = desc.replaceAll(/\[.*?\]/g, '');
        desc = desc.replaceAll(/#(.*?)#/g, '#$1');
        desc = desc.replaceAll('\n', '<br>');
        const pubDate = parseDate(note.time, 'x');
        const updated = parseDate(note.lastUpdateTime, 'x');

        let mediaContent = '';
        if (note.type === 'video') {
            const originVideoKey = note.video?.consumer?.originVideoKey;
            const videoUrls: string[] = [];

            if (originVideoKey) {
                videoUrls.push(`http://sns-video-al.xhscdn.com/${originVideoKey}`);
            }

            const streamTypes = ['av1', 'h264', 'h265', 'h266'];
            for (const type of streamTypes) {
                const streams = note.video?.media?.stream?.[type];
                if (streams?.length > 0) {
                    const stream = streams[0];
                    if (stream.masterUrl) {
                        videoUrls.push(stream.masterUrl);
                    }
                    if (stream.backupUrls?.length) {
                        videoUrls.push(...stream.backupUrls);
                    }
                }
            }

            const posterUrl = sanitizeImageUrl(note.imageList?.[0]?.urlDefault);

            const thumbnailBlock = posterUrl ? `<p><img src="${escapeAttribute(posterUrl)}" referrerpolicy="no-referrer" loading="lazy"></p>` : '';
            const iframeBlock = `<p><iframe width="640" height="360" src="${escapeAttribute(link)}" frameborder="0" allowfullscreen></iframe></p>`;
            const fallbackBlock = videoUrls.length ? `<p>${videoUrls.map((url, index) => `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer noopener">视频源 ${index + 1}</a>`).join(' | ')}</p>` : '';
            mediaContent = `${thumbnailBlock}${iframeBlock}${fallbackBlock}`;
        } else {
            mediaContent = note.imageList
                .map((image) => {
                    if (image.livePhoto && displayLivePhoto) {
                        const videoUrls: string[] = [];

                        const streamTypes = ['av1', 'h264', 'h265', 'h266'];
                        for (const type of streamTypes) {
                            const streams = image.stream?.[type];
                            if (streams?.length > 0) {
                                if (streams[0].masterUrl) {
                                    videoUrls.push(streams[0].masterUrl);
                                }
                                if (streams[0].backupUrls?.length) {
                                    videoUrls.push(...streams[0].backupUrls);
                                }
                            }
                        }

                        const poster = sanitizeImageUrl(image.urlDefault);
                        if (videoUrls.length > 0) {
                            return `<video controls${poster ? ` poster="${escapeAttribute(poster)}"` : ''}>
                            ${videoUrls.map((url) => `<source src="${url}" type="video/mp4">`).join('\n')}
                        </video>`;
                        }
                    }
                    const sanitized = sanitizeImageUrl(image.urlDefault || image.url);
                    return sanitized ? `<img src="${escapeAttribute(sanitized)}">` : '';
                })
                .join('<br>');
        }

        const description = `${mediaContent}<br>${desc}`;
        return {
            title: title || note.desc,
            description,
            pubDate,
            updated,
        };
    })) as Promise<{ title: string; description: string; pubDate: Date; updated: Date }>;
    return data;
}

async function getUserWithCookie(url: string) {
    const cookie = config.xiaohongshu.cookie;
    const res = await ofetch(url, {
        headers: getHeaders(cookie),
    });
    const $ = load(res);
    const paths = $('#userPostedFeeds > section > div > a.cover.ld.mask').map((i, item) => item.attributes[3].value);
    const script = extractInitialState($);
    const state = JSON.parse(script);
    let index = 0;
    for (const item of state.user.notes.flat()) {
        const path = paths[index];
        if (path && path.includes('?')) {
            item.id = item.id + path?.slice(path.indexOf('?'));
        }
        index = index + 1;
    }
    return state.user;
}

// Add helper function to extract initial state
function extractInitialState($) {
    let script = $('script')
        .filter((i, script) => {
            const text = script.children[0]?.data;
            return text?.startsWith('window.__INITIAL_STATE__=');
        })
        .text();
    script = script.slice('window.__INITIAL_STATE__='.length);
    script = script.replaceAll('undefined', 'null');
    return script;
}

async function checkCookie() {
    const cookie = config.xiaohongshu.cookie;
    const res = await ofetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', {
        headers: getHeaders(cookie),
    });
    return res.code === 0 && !!res.data.user_id;
}

export { checkCookie, escapeAttribute, formatNote, formatText, getBoard, getFullNote, getUser, getUserCollect, getUserWithCookie, renderNotesFulltext, sanitizeImageUrl };
