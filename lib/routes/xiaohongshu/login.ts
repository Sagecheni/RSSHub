import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';
import type { Page } from 'rebrowser-puppeteer';

import type { Route } from '@/types';
import { ViewType } from '@/types';
import logger from '@/utils/logger';
import { getPuppeteerPage } from '@/utils/puppeteer';

import { setRuntimeCookie } from './cookie';

interface LoginSession {
    id: string;
    status: 'pending' | 'success' | 'expired' | 'failed';
    createdAt: number;
    page?: Page;
    destory?: () => Promise<void>;
    cookie?: string;
    error?: string;
    monitor?: NodeJS.Timeout;
    expireTimer?: NodeJS.Timeout;
    removalTimer?: NodeJS.Timeout;
}

const LOGIN_URL = 'https://www.xiaohongshu.com/login?redirectPath=/explore';
const SESSION_TTL = 5 * 60 * 1000;
const loginSessions = new Map<string, LoginSession>();

export const route: Route = {
    path: '/login/:sessionId?/:action?',
    name: '扫码登录（辅助）',
    categories: ['social-media'],
    view: ViewType.Articles,
    maintainers: ['pseudoyu'],
    handler,
    example: '/xiaohongshu/login',
    description: '生成一个可扫码登录的小红书二维码，并在登录完成后返回 Cookie，便于填入 `XIAOHONGSHU_COOKIE`。',
};

async function handler(ctx: Context) {
    const sessionId = ctx.req.param('sessionId');
    const action = ctx.req.param('action');

    if (!sessionId) {
        const session = await createLoginSession();
        return ctx.html(renderLandingPage(ctx, session.id));
    }

    if (action === 'qrcode') {
        return await serveQRCode(ctx, sessionId);
    }

    if (action === 'status') {
        return await serveStatus(ctx, sessionId);
    }

    return ctx.json(
        {
            error: 'unsupported_action',
        },
        404
    );
}

async function createLoginSession() {
    const id = randomUUID();
    const { page, destory } = await getPuppeteerPage(LOGIN_URL, {
        gotoConfig: {
            waitUntil: 'domcontentloaded',
        },
    });
    await page.setViewport({
        width: 1280,
        height: 720,
    });
    try {
        await page.waitForSelector('.login-container img, .login-qrcode img, img[src*="qrcode"], canvas[aria-label*=qrcode]', {
            timeout: 20000,
        });
    } catch (error) {
        await destory();
        throw error;
    }

    const session: LoginSession = {
        id,
        status: 'pending',
        createdAt: Date.now(),
        page,
        destory,
    };
    session.monitor = setInterval(() => monitorSession(session.id), 3000);
    session.expireTimer = setTimeout(() => markSessionExpired(session.id), SESSION_TTL);
    loginSessions.set(id, session);
    return session;
}

async function monitorSession(sessionId: string) {
    const session = loginSessions.get(sessionId);
    if (!session || session.status !== 'pending' || !session.page) {
        return;
    }
    try {
        const cookies = await session.page.cookies();
        const hasSession = cookies.some((cookie) => cookie.name === 'web_session');
        if (hasSession) {
            session.cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
            setRuntimeCookie(session.cookie);
            session.status = 'success';
            await cleanupSessionResources(session);
        }
    } catch (error) {
        session.status = 'failed';
        session.error = error instanceof Error ? error.message : String(error);
        await cleanupSessionResources(session);
    }
}

async function markSessionExpired(sessionId: string) {
    const session = loginSessions.get(sessionId);
    if (!session) {
        return;
    }
    if (session.status === 'pending') {
        session.status = 'expired';
    }
    await cleanupSessionResources(session);
}

async function serveQRCode(ctx: Context, sessionId: string) {
    const session = loginSessions.get(sessionId);
    if (!session || session.status !== 'pending' || !session.page) {
        return ctx.json(
            {
                error: 'session_inactive',
            },
            404
        );
    }

    try {
        const buffer = await captureQRCode(session.page);
        ctx.header('cache-control', 'no-store');
        return new Response(buffer, {
            headers: {
                'content-type': 'image/png',
            },
        });
    } catch (error) {
        return ctx.json(
            {
                error: 'qrcode_unavailable',
                message: error instanceof Error ? error.message : String(error),
            },
            500
        );
    }
}

function serveStatus(ctx: Context, sessionId: string) {
    const session = loginSessions.get(sessionId);
    if (!session) {
        return ctx.json(
            {
                status: 'missing',
            },
            404
        );
    }
    return ctx.json({
        id: session.id,
        status: session.status,
        cookie: session.status === 'success' ? session.cookie : undefined,
        error: session.error,
        expiresAt: session.createdAt + SESSION_TTL,
    });
}

async function captureQRCode(page: Page) {
    const selectors = ['.login-container img', '.login-qrcode img', '.reds-login-qrcode img', 'img[src*="qrcode"]', 'canvas[aria-label*=qrcode]'];
    for (const selector of selectors) {
        // eslint-disable-next-line no-await-in-loop
        const element = await page.$(selector);
        if (element) {
            try {
                // eslint-disable-next-line no-await-in-loop
                return await element.screenshot({
                    type: 'png',
                });
            } catch (error) {
                logger.debug(`Failed to screenshot ${selector}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return await page.screenshot({
        type: 'png',
    });
}

async function cleanupSessionResources(session: LoginSession) {
    if (session.monitor) {
        clearInterval(session.monitor);
        session.monitor = undefined;
    }
    if (session.expireTimer) {
        clearTimeout(session.expireTimer);
        session.expireTimer = undefined;
    }
    if (session.page && session.destory) {
        try {
            await session.destory();
        } catch (error) {
            logger.debug(`Failed to close Xiaohongshu login browser: ${error instanceof Error ? error.message : String(error)}`);
        }
        session.page = undefined;
        session.destory = undefined;
    }
    if (!session.removalTimer) {
        session.removalTimer = setTimeout(
            () => {
                loginSessions.delete(session.id);
            },
            2 * 60 * 1000
        );
    }
}

function renderLandingPage(ctx: Context, sessionId: string) {
    const basePath = ctx.req.path.replace(/\/$/, '');
    const qrcodeUrl = `${basePath}/${sessionId}/qrcode`;
    const statusUrl = `${basePath}/${sessionId}/status`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>RSSHub · 小红书扫码登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f5f5f5;margin:0;padding:0;color:#111;}
.container{max-width:640px;margin:0 auto;padding:32px;}
.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.08);}
.qr-wrapper{display:flex;justify-content:center;margin:24px 0;}
.qr-wrapper img{border:8px solid #f5f5f5;border-radius:12px;width:280px;height:280px;object-fit:contain;background:#fff;}
.status{padding:12px 16px;border-radius:8px;background:#f0f4ff;border:1px solid #c5d6ff;color:#1e3a8a;margin-bottom:16px;}
button{background:#f54966;color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:14px;cursor:pointer;}
button[disabled]{opacity:.5;cursor:not-allowed;}
pre{background:#111;color:#0f0;padding:16px;border-radius:8px;overflow:auto;max-height:200px;}
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>小红书扫码登录</h1>
    <p>请使用浏览器扫描二维码完成登录，登录后将自动生成 <code>XIAOHONGSHU_COOKIE</code>。</p>
    <div class="status" id="status">等待扫码…</div>
    <div class="qr-wrapper">
      <img id="qr" src="${qrcodeUrl}?t=${Date.now()}" alt="Login QR Code" loading="lazy">
    </div>
    <div style="display:flex;gap:12px;">
      <button type="button" onclick="refreshQr()">刷新二维码</button>
      <button type="button" id="copy" disabled>复制 Cookie</button>
    </div>
    <div id="cookie-wrapper" style="display:none;margin-top:16px;">
      <h3>Cookie</h3>
      <pre id="cookie"></pre>
    </div>
    <p style="font-size:13px;color:#555;">注意：同一账号在不同环境登录会被小红书判定为风险操作，请使用专用账号或代理保持 IP 一致。</p>
  </div>
</div>
<script>
const statusUrl = '${statusUrl}';
const qrImg = document.getElementById('qr');
const statusBox = document.getElementById('status');
const cookieBox = document.getElementById('cookie');
const cookieWrapper = document.getElementById('cookie-wrapper');
const copyBtn = document.getElementById('copy');

function refreshQr(){
  qrImg.src = '${qrcodeUrl}?t=' + Date.now();
}

async function pollStatus(){
  try{
    const res = await fetch(statusUrl, { cache: 'no-store' });
    const data = await res.json();
    if(data.status === 'pending'){
      statusBox.textContent = '等待扫码…';
    }else if(data.status === 'success' && data.cookie){
      statusBox.textContent = '登录成功！';
      cookieWrapper.style.display = 'block';
      cookieBox.textContent = data.cookie;
      copyBtn.disabled = false;
    }else if(data.status === 'expired'){
      statusBox.textContent = '二维码已过期，请刷新页面重新生成。';
      copyBtn.disabled = true;
    }else if(data.status === 'failed'){
      statusBox.textContent = '登录失败：' + (data.error || '未知原因');
      copyBtn.disabled = true;
    }else if(data.status === 'missing'){
      statusBox.textContent = '会话不存在或已清理，请刷新页面。';
      copyBtn.disabled = true;
    }
  }catch(err){
    statusBox.textContent = '状态检查失败：' + err.message;
  }
}

copyBtn.addEventListener('click', async () => {
  try{
    await navigator.clipboard.writeText(cookieBox.textContent);
    copyBtn.textContent = '已复制';
    copyBtn.disabled = true;
  }catch(err){
    alert('复制失败：' + err.message);
  }
});

setInterval(pollStatus, 4000);
</script>
</body>
</html>`;
}
