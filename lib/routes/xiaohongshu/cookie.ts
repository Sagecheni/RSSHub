import { config } from '@/config';

type CookieSource = 'runtime' | 'config' | 'none';

let runtimeCookie: string | undefined;
let runtimeUpdatedAt: number | undefined;

const normalizeCookie = (cookie?: string) => {
    if (!cookie) {
        return;
    }
    const trimmed = cookie.trim();
    return trimmed || undefined;
};

export const setRuntimeCookie = (cookie?: string) => {
    runtimeCookie = normalizeCookie(cookie);
    runtimeUpdatedAt = runtimeCookie ? Date.now() : undefined;
};

export const clearRuntimeCookie = () => {
    runtimeCookie = undefined;
    runtimeUpdatedAt = undefined;
};

export const getCookieValue = () => runtimeCookie ?? config.xiaohongshu.cookie;

export const getCookieMeta = () => {
    const active = getCookieValue();
    const source: CookieSource = runtimeCookie ? 'runtime' : config.xiaohongshu.cookie ? 'config' : 'none';
    return {
        cookie: active,
        source,
        runtimeUpdatedAt,
    };
};
