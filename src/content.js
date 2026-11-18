// ClipGuard, extension side of each page: passes reports from guard.js to
// the background, shows the banner in the top frame, and copies blocked text
// when the user asks for it.
//
// This world has its own copy of the page's built-ins, so the clipboard
// functions used here aren't the ones guard.js wraps.
(() => {
    'use strict';

    const REPORT_EVENT = 'clipguard:report';
    // Characters of blocked text shown in the banner
    const PREVIEW_LENGTH = 2000;
    // How long "Copied" stays before the banner closes
    const CLOSE_DELAY_MS = 1200;

    const KINDS = {
        command: {
            title: '已攔下一段指令',
            text: '這個網頁想把下面這段指令放進剪貼簿，但它沒有顯示在畫面上，或偽裝成「我不是機器人」驗證。' +
                '正常網頁不會叫你把東西貼到終端機、Alt+F2 或「執行」視窗。這段內容沒有放進剪貼簿。',
            copy: '仍然複製',
        },
        swap: {
            title: '已攔下被掉包的地址',
            text: '你複製的地址被網頁換成了另一個。剪貼簿裡放的是你自己選的原文。',
            copy: '改用網頁的版本',
        },
        address: {
            title: '已攔下一個畫面上沒有的地址',
            text: '這個網頁想把畫面上找不到的錢包地址放進剪貼簿。這段內容沒有放進剪貼簿。',
            copy: '仍然複製',
        },
    };

    let allowlist = null;

    function allowedHosts() {
        allowlist ??= chrome.storage.local.get({allowlist: []}).then(items => items.allowlist);
        return allowlist;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.allowlist)
            allowlist = Promise.resolve(changes.allowlist.newValue ?? []);
    });

    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }

    function send(message) {
        chrome.runtime.sendMessage(message).catch(() => {});
    }

    // Registered on the window before the page runs, so the page can't stop
    // the report before it gets here
    addEventListener(REPORT_EVENT, event => {
        onReport(event.detail);
    }, true);

    async function onReport(detail) {
        let report;
        try {
            report = JSON.parse(detail);
        } catch {
            return;
        }
        if (!KINDS[report?.kind] || typeof report.text !== 'string' || typeof report.host !== 'string')
            return;
        // On allowed sites, write what the page wanted after all
        const allowed = (await allowedHosts()).includes(report.host) && await copy(report.text);
        send({type: 'report', report, allowed});
    }

    if (window !== window.top)
        return;

    chrome.runtime.onMessage.addListener(message => {
        if (message?.type === 'show' && KINDS[message.report?.kind])
            showBanner(message.report);
    });

    const STYLE = `
        :host { color-scheme: light dark; }
        .box {
            --bg: #fff8f6; --fg: #2b1b17; --muted: #6d5c57; --accent: #c62828;
            --code-bg: #f3e6e2; --border: #e9c6bd; --button: #ffffff;
            box-sizing: border-box; width: 100%; padding: 14px 16px; border-radius: 12px;
            background: var(--bg); color: var(--fg); border: 1px solid var(--border);
            border-left: 5px solid var(--accent); box-shadow: 0 8px 28px rgba(0, 0, 0, .25);
            font: 14px/1.5 system-ui, "Noto Sans CJK TC", "Noto Sans TC", sans-serif;
        }
        @media (prefers-color-scheme: dark) {
            .box {
                --bg: #2a1d1b; --fg: #f5e9e6; --muted: #c4b2ad; --accent: #ff6b5e;
                --code-bg: #1d1413; --border: #5a3a35; --button: #3a2a27;
            }
        }
        h2 { margin: 0 0 6px; font-size: 15px; color: var(--accent); }
        p { margin: 0 0 8px; }
        .label { margin: 8px 0 2px; font-size: 12px; color: var(--muted); }
        pre {
            margin: 0; max-height: 140px; overflow: auto; padding: 8px 10px; border-radius: 6px;
            background: var(--code-bg); font: 12px/1.45 ui-monospace, "DejaVu Sans Mono", monospace;
            white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .site { margin-top: 8px; font-size: 12px; color: var(--muted); }
        .buttons { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 12px; }
        button {
            font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
            border: 1px solid var(--border); background: var(--button); color: var(--fg);
        }
        button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    `;

    let banner = null;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className)
            node.className = className;
        if (text !== undefined)
            node.textContent = text;
        return node;
    }

    function preview(text) {
        return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…（共 ${text.length} 字）` : text;
    }

    function showBanner(report) {
        banner?.remove();
        const kind = KINDS[report.kind];

        const host = document.createElement('div');
        // Inline !important styles win over the page's own CSS
        for (const [name, value] of Object.entries({
            all: 'initial', position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
            width: 'min(560px, calc(100vw - 32px))', 'z-index': '2147483647', display: 'block',
        }))
            host.style.setProperty(name, value, 'important');
        const shadow = host.attachShadow({mode: 'closed'});
        const style = element('style');
        style.textContent = STYLE;
        const box = element('div', 'box');
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-label', kind.title);
        box.append(element('h2', '', kind.title), element('p', '', kind.text));
        if (report.kind === 'swap') {
            box.append(element('div', 'label', '你選的'), element('pre', '', preview(report.original)),
                element('div', 'label', '網頁要放的'), element('pre', '', preview(report.text)));
        } else {
            box.append(element('pre', '', preview(report.text)));
        }
        box.append(element('div', 'site', `網站：${report.host || '本機檔案'}`));

        const buttons = element('div', 'buttons');
        const copyButton = element('button', '', kind.copy);
        const allowButton = element('button', '', '這個網站一律允許');
        const closeButton = element('button', 'primary', '關閉');
        buttons.append(copyButton, allowButton, closeButton);
        box.append(buttons);
        shadow.append(style, box);

        const close = () => {
            host.remove();
            if (banner === host)
                banner = null;
        };
        const copyAndClose = async button => {
            const done = await copy(report.text);
            button.textContent = done ? '已複製' : '複製失敗';
            if (done)
                setTimeout(close, CLOSE_DELAY_MS);
        };
        // Only real clicks count, not ones the page fakes
        copyButton.addEventListener('click', event => {
            if (event.isTrusted)
                copyAndClose(copyButton);
        });
        allowButton.addEventListener('click', async event => {
            if (!event.isTrusted)
                return;
            const hosts = await allowedHosts();
            if (!hosts.includes(report.host))
                await chrome.storage.local.set({allowlist: [...hosts, report.host]});
            copyAndClose(allowButton);
        });
        closeButton.addEventListener('click', event => {
            if (event.isTrusted)
                close();
        });

        document.documentElement.append(host);
        banner = host;
    }
})();
