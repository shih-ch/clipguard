'use strict';

const KIND_LABELS = {
    command: '指令',
    swap: '掉包的地址',
    address: '畫面上沒有的地址',
};

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}

function showEmpty(list, text) {
    list.replaceChildren(element('li', 'empty', text));
}

async function showTabCount() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const key = `count:${tab?.id}`;
    const {[key]: count = 0} = await chrome.storage.session.get(key);
    const summary = document.getElementById('tab-count');
    if (count) {
        summary.append('這個分頁攔下了 ', element('strong', '', String(count)), ' 次');
    } else {
        summary.textContent = '這個分頁沒有攔下任何東西';
    }
}

async function showLog() {
    const list = document.getElementById('log');
    const {log = []} = await chrome.storage.local.get('log');
    if (!log.length) {
        showEmpty(list, '沒有紀錄');
        return;
    }
    list.replaceChildren(...log.slice(0, 20).map(entry => {
        const item = element('li');
        const meta = element('div', 'meta');
        const label = KIND_LABELS[entry.kind] ?? entry.kind;
        meta.append(
            element('span', entry.allowed ? 'kind allowed' : 'kind', entry.allowed ? `${label}（已允許）` : label),
            element('span', '', `${entry.host || '本機檔案'}　${new Date(entry.time).toLocaleString('zh-TW')}`));
        item.append(meta, element('div', 'text', entry.text));
        return item;
    }));
}

async function showAllowlist() {
    const list = document.getElementById('allowlist');
    const {allowlist = []} = await chrome.storage.local.get('allowlist');
    if (!allowlist.length) {
        showEmpty(list, '沒有');
        return;
    }
    list.replaceChildren(...allowlist.map(host => {
        const item = element('li', 'site');
        const remove = element('button', '', '移除');
        remove.addEventListener('click', async () => {
            const {allowlist: current = []} = await chrome.storage.local.get('allowlist');
            await chrome.storage.local.set({allowlist: current.filter(other => other !== host)});
            showAllowlist();
        });
        item.append(element('span', '', host || '本機檔案'), remove);
        return item;
    }));
}

document.getElementById('clear-log').addEventListener('click', async () => {
    await chrome.storage.local.remove('log');
    showLog();
});

showTabCount();
showLog();
showAllowlist();
