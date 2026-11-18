// ClipGuard background: counts blocked writes on the toolbar icon, keeps a
// short log for the popup, and shows the banner in the tab's top frame,
// whichever frame the write came from.

const LOG_LIMIT = 50;
const LOG_TEXT_LENGTH = 300;
const BADGE_COLOR = '#c62828';

const countKey = tabId => `count:${tabId}`;

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'report' && sender.tab?.id !== undefined)
        handleReport(message, sender.tab.id).catch(error => console.warn('ClipGuard:', error));
});

async function handleReport({report, allowed}, tabId) {
    const {log = []} = await chrome.storage.local.get('log');
    log.unshift({
        time: Date.now(),
        kind: report.kind,
        host: report.host,
        text: report.text.slice(0, LOG_TEXT_LENGTH),
        allowed,
    });
    await chrome.storage.local.set({log: log.slice(0, LOG_LIMIT)});
    if (allowed)
        return;

    const key = countKey(tabId);
    const {[key]: count = 0} = await chrome.storage.session.get(key);
    await chrome.storage.session.set({[key]: count + 1});
    await chrome.action.setBadgeBackgroundColor({tabId, color: BADGE_COLOR});
    await chrome.action.setBadgeText({tabId, text: String(count + 1)});
    await chrome.tabs.sendMessage(tabId, {type: 'show', report}, {frameId: 0}).catch(() => {});
}

// A new page starts from zero
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading')
        return;
    chrome.storage.session.remove(countKey(tabId));
    chrome.action.setBadgeText({tabId, text: ''}).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
    chrome.storage.session.remove(countKey(tabId));
});
