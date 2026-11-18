// ClipGuard: checks what web pages put on the clipboard.
//
// This file runs in the page's own JavaScript world before any of the page's
// scripts, and wraps every way a page can write to the clipboard. A write is
// blocked when it is
//   - a command that isn't shown on the page, or one disguised as a CAPTCHA
//     check (ClickFix: "open a terminal or press Alt+F2, then paste")
//   - a crypto address that replaces the one being copied, or one that isn't
//     shown on the page
// The page is told the write worked, so it doesn't try another way, and a
// report goes to content.js, which shows the banner.
//
// Everything stays in this closure and uses built-ins saved before the page
// runs, so a page can't switch the checks off by replacing String.prototype
// or Clipboard.prototype methods. A page written to defeat ClipGuard on
// purpose still could; see README.md.
(() => {
    'use strict';

    const REPORT_EVENT = 'clipguard:report';
    // Blocked text kept in a report, so "copy anyway" gets all of it
    const MAX_REPORT_LENGTH = 100000;
    // Text checked for commands and addresses
    const MAX_CHECK_LENGTH = 20000;
    // Text fields smaller than this, in pixels, count as hidden
    const MIN_FIELD_SIZE = 4;

    // Text that runs or downloads something when pasted into a terminal, the
    // Alt+F2 dialog or the Windows Run box
    const COMMAND_PATTERNS = [
        // Downloads
        /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|certutil|bitsadmin)\b/i,
        // Pipes into a shell or an interpreter
        /\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\|\s*(?:python[0-9.]*|perl|ruby|node|php|iex)\b/i,
        // Runs a string as code
        /\b(?:ba|z|da|k)?sh\s+-c\b|\b(?:python[0-9.]*|perl|ruby|node|php)\s+-[ce]\b|\beval\b|\$\(|`[^`\n]+`/i,
        // Decodes a hidden payload
        /\bbase64\s+(?:-d|--decode|-D)\b|frombase64string|\bxxd\s+-r\b|\bopenssl\s+(?:base64|enc)\b/i,
        // Launchers used by ClickFix on Windows and macOS
        /\b(?:powershell|pwsh|mshta|rundll32|regsvr32|wscript|cscript|msiexec|conhost|schtasks|forfiles|osascript)(?:\.exe)?\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\biex\b|\binvoke-expression\b/i,
        // A line starting with a common command
        /^\s*(?:sudo|bash|sh|zsh|curl|wget|python[0-9.]*|perl|apt(?:-get)?|dnf|yum|pacman|snap|flatpak|npm|npx|pip[0-9.]*|chmod|chown|rm|echo|eval|exec|nohup|nc|ncat|ssh|scp)\s/im,
    ];

    // A comment that dresses a command up as a CAPTCHA or security check, as
    // in `bash -c "..." # I am not a robot - Verification ID: 4821`
    const LURE_PATTERN = /(?:^|\s)(?:#|rem\b|::)[^\n]{0,300}?(?:\b(?:robot|captcha|recaptcha|verif\w*|human|cloudflare|ray\s*id|security\s+check|authenticat\w*)\b|機器人|机器人|驗證|验证|人機|人机)/i;

    // [pattern, distinctive enough to judge on its own, case-insensitive]
    const ADDRESS_PATTERNS = [
        // Ethereum and other EVM chains
        [/\b0x[0-9a-f]{40}\b/gi, true, true],
        // Bitcoin and Litecoin (bech32)
        [/\b(?:bc1|tb1|ltc1)[02-9ac-hj-np-z]{11,87}\b/gi, true, true],
        // Bitcoin (legacy)
        [/\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, true, false],
        // TRON
        [/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g, true, false],
        // Solana and others; looks like too many other things to judge alone
        [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, false, false],
    ];

    // ---------------------------------------------------------------------
    // Built-ins saved before the page can replace them

    const {apply, defineProperty, getOwnPropertyDescriptor} = Reflect;
    const call = (fn, self, ...args) => apply(fn, self, args);
    const getter = (proto, name) => getOwnPropertyDescriptor(proto, name)?.get;

    const regexExec = RegExp.prototype.exec;
    const {charCodeAt, indexOf, slice, toLowerCase} = String.prototype;
    const stringify = JSON.stringify;
    const CustomEventCtor = CustomEvent;
    const {addEventListener, dispatchEvent} = EventTarget.prototype;
    const preventDefault = Event.prototype.preventDefault;
    const {get: mapGet, set: mapSet} = WeakMap.prototype;
    const {has: setHas, add: setAdd} = WeakSet.prototype;

    const getSelectionOf = Document.prototype.getSelection;
    const selectionToString = Selection.prototype.toString;
    const activeElementOf = getter(Document.prototype, 'activeElement');
    const documentElementOf = getter(Document.prototype, 'documentElement');
    const defaultViewOf = getter(Document.prototype, 'defaultView');
    const querySelectorAll = Document.prototype.querySelectorAll;
    const nodeListLength = getter(NodeList.prototype, 'length');
    const nodeListItem = NodeList.prototype.item;
    const localNameOf = getter(Element.prototype, 'localName');
    const checkVisibility = Element.prototype.checkVisibility;
    const boundingRect = Element.prototype.getBoundingClientRect;
    const rectWidth = getter(DOMRectReadOnly.prototype, 'width');
    const rectHeight = getter(DOMRectReadOnly.prototype, 'height');
    const rectRight = getter(DOMRectReadOnly.prototype, 'right');
    const rectBottom = getter(DOMRectReadOnly.prototype, 'bottom');
    const innerTextOf = getter(HTMLElement.prototype, 'innerText');
    const inputValue = getter(HTMLInputElement.prototype, 'value');
    const inputType = getter(HTMLInputElement.prototype, 'type');
    const inputStart = getter(HTMLInputElement.prototype, 'selectionStart');
    const inputEnd = getter(HTMLInputElement.prototype, 'selectionEnd');
    const areaValue = getter(HTMLTextAreaElement.prototype, 'value');
    const areaStart = getter(HTMLTextAreaElement.prototype, 'selectionStart');
    const areaEnd = getter(HTMLTextAreaElement.prototype, 'selectionEnd');
    const clipboardDataOf = getter(ClipboardEvent.prototype, 'clipboardData');
    const itemsOf = getter(DataTransfer.prototype, 'items');
    const blobText = Blob.prototype.text;
    // The async clipboard API only exists on https and localhost pages
    const itemTypes = typeof ClipboardItem === 'function' ? getter(ClipboardItem.prototype, 'types') : null;
    const itemGetType = typeof ClipboardItem === 'function' ? ClipboardItem.prototype.getType : null;

    const mainWindow = window;
    const mainDocument = document;
    const mainLocation = location;

    // Documents already protected
    const protectedDocuments = new WeakSet();
    // Copy and cut events in progress, by their DataTransfer and its items
    const copyEvents = new WeakMap();
    // Depth of document.execCommand('copy') calls made by the page; their
    // copy events weren't started by the user
    let execDepth = 0;

    // ---------------------------------------------------------------------
    // Text helpers that don't touch anything the page can replace

    const test = (pattern, text) => call(regexExec, pattern, text) !== null;
    const contains = (text, part) => call(indexOf, text, part) !== -1;

    function isSpace(code) {
        return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 ||
            (code >= 0x2000 && code <= 0x200b) || code === 0x2028 || code === 0x2029 ||
            code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
    }

    // Trims the text and turns each run of white space into one space
    function collapse(text) {
        let out = '';
        let space = false;
        for (let i = 0; i < text.length; i++) {
            if (isSpace(call(charCodeAt, text, i))) {
                space = out.length > 0;
            } else {
                if (space)
                    out += ' ';
                space = false;
                out += text[i];
            }
        }
        return out;
    }

    function splitLines(text) {
        const lines = [];
        let start = 0;
        for (let i = 0; i <= text.length; i++) {
            if (i === text.length || text[i] === '\n' || text[i] === '\r') {
                lines[lines.length] = call(slice, text, start, i);
                start = i + 1;
            }
        }
        return lines;
    }

    // Removes shell prompts ("$ ", "# ", "% ", "> ") from the start of lines,
    // since copy buttons leave them out
    function stripPrompts(text) {
        const lines = splitLines(text);
        let out = '';
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let at = 0;
            while (at < line.length && isSpace(call(charCodeAt, line, at)))
                at++;
            const prompt = line[at];
            if ((prompt === '$' || prompt === '#' || prompt === '%' || prompt === '>') && line[at + 1] === ' ')
                at += 2;
            out += (i ? '\n' : '') + call(slice, line, at);
        }
        return out;
    }

    // Removes the Markdown a page shows as formatting: code and bold markers,
    // and heading, list and quote markers at the start of a line
    function stripMarkdown(line) {
        line = replaceAll(replaceAll(replaceAll(line, '`', ''), '**', ''), '__', '');
        let at = 0;
        while (at < line.length && isSpace(call(charCodeAt, line, at)))
            at++;
        let end = at;
        while (end < line.length && line[end] === '#')
            end++;
        if (end === at) {
            while (end < line.length && line[end] >= '0' && line[end] <= '9')
                end++;
            if (end > at && line[end] === '.')
                end++;
            else if (end === at && (line[at] === '-' || line[at] === '*' || line[at] === '+' || line[at] === '>'))
                end++;
            else
                end = at;
        }
        return end > at && line[end] === ' ' ? call(slice, line, end + 1) : line;
    }

    function replaceAll(text, from, to) {
        let out = '';
        let start = 0;
        let at;
        while ((at = call(indexOf, text, from, start)) !== -1) {
            out += call(slice, text, start, at) + to;
            start = at + from.length;
        }
        return out + call(slice, text, start);
    }

    // The text of an HTML fragment, good enough to look for commands in
    function htmlToText(html) {
        let out = '';
        let inTag = false;
        for (let i = 0; i < html.length; i++) {
            const c = html[i];
            if (c === '<')
                inTag = true;
            else if (c === '>' && inTag)
                inTag = false;
            else if (!inTag)
                out += c;
        }
        const entities = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' '], ['&amp;', '&']];
        for (let i = 0; i < entities.length; i++)
            out = replaceAll(out, entities[i][0], entities[i][1]);
        return out;
    }

    function escapeHtml(text) {
        let out = '';
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c;
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // What the user sees and selects

    function isOnScreen(element) {
        try {
            if (checkVisibility &&
                !call(checkVisibility, element, {__proto__: null, opacityProperty: true, visibilityProperty: true}))
                return false;
            const rect = call(boundingRect, element);
            return call(rectWidth, rect) >= MIN_FIELD_SIZE && call(rectHeight, rect) >= MIN_FIELD_SIZE &&
                call(rectRight, rect) > 0 && call(rectBottom, rect) > 0;
        } catch {
            return false;
        }
    }

    // The value of a text field the user can read, or ''
    function fieldValue(field) {
        const name = call(localNameOf, field);
        if (name === 'textarea')
            return call(areaValue, field);
        const type = call(inputType, field);
        return type === 'text' || type === 'search' || type === 'url' || type === 'tel' || type === 'email'
            ? call(inputValue, field) : '';
    }

    // The rendered text of these documents, plus the text fields on screen,
    // which the rendered text leaves out
    function shownText(docs) {
        let text = '';
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            try {
                const root = call(documentElementOf, doc);
                if (root)
                    text += call(innerTextOf, root) + '\n';
            } catch {}
            try {
                const fields = call(querySelectorAll, doc, 'input, textarea');
                const count = call(nodeListLength, fields);
                for (let j = 0; j < count; j++) {
                    const field = call(nodeListItem, fields, j);
                    if (isOnScreen(field))
                        text += fieldValue(field) + '\n';
                }
            } catch {}
        }
        return text;
    }

    // Answers whether text is shown on the page, reading the page at most once
    function pageView(docs) {
        let plain = null;
        let promptless;
        let lower;
        const load = () => {
            const raw = shownText(docs);
            plain = collapse(raw);
            promptless = collapse(stripPrompts(raw));
            lower = call(toLowerCase, plain);
        };
        return {
            shows(text) {
                const target = collapse(text);
                if (!target)
                    return true;
                if (plain === null)
                    load();
                if (contains(plain, target) || contains(promptless, collapse(stripPrompts(text))))
                    return true;
                // Otherwise line by line, for code shown with line numbers or
                // prompts. Only the lines that look like commands have to be
                // shown, since the rest may be formatted differently on the
                // page, like the Markdown behind a chat reply's copy button.
                // A command split over lines so that no line looks like one
                // needs every line shown.
                const lines = splitLines(stripPrompts(text));
                let commandLines = 0;
                for (let i = 0; i < lines.length; i++) {
                    if (looksLikeCommand(lines[i]))
                        commandLines++;
                }
                for (let i = 0; i < lines.length; i++) {
                    if (commandLines && !looksLikeCommand(lines[i]))
                        continue;
                    const line = collapse(stripMarkdown(lines[i]));
                    if (line && !contains(promptless, line) && !contains(plain, line))
                        return false;
                }
                return true;
            },
            showsAddress(address) {
                if (plain === null)
                    load();
                return contains(lower, call(toLowerCase, address));
            },
        };
    }

    // What the user has selected, including inside a text field
    function selectedText(doc) {
        try {
            const active = call(activeElementOf, doc);
            const name = active ? call(localNameOf, active) : '';
            if (name === 'textarea' || name === 'input') {
                const area = name === 'textarea';
                const start = call(area ? areaStart : inputStart, active);
                const end = call(area ? areaEnd : inputEnd, active);
                if (typeof start === 'number' && end > start)
                    return call(slice, call(area ? areaValue : inputValue, active), start, end);
            }
            const selection = call(getSelectionOf, doc);
            return selection ? call(selectionToString, selection) : '';
        } catch {
            return '';
        }
    }

    // ---------------------------------------------------------------------
    // Judging what a page writes

    function looksLikeCommand(text) {
        for (let i = 0; i < COMMAND_PATTERNS.length; i++) {
            if (test(COMMAND_PATTERNS[i], text))
                return true;
        }
        return false;
    }

    // The crypto addresses in text, as an object keyed by address, or null
    function findAddresses(text, distinctiveOnly) {
        const found = {__proto__: null};
        let count = 0;
        for (let i = 0; i < ADDRESS_PATTERNS.length; i++) {
            const pattern = ADDRESS_PATTERNS[i][0];
            if (distinctiveOnly && !ADDRESS_PATTERNS[i][1])
                continue;
            pattern.lastIndex = 0;
            let match;
            while ((match = call(regexExec, pattern, text)) !== null) {
                const address = ADDRESS_PATTERNS[i][2] ? call(toLowerCase, match[0]) : match[0];
                if (!found[address]) {
                    found[address] = true;
                    count++;
                }
            }
        }
        return count ? found : null;
    }

    // Why text written by the page's own code is blocked, or '' if it's fine
    function judgeWrite(text, view) {
        text = call(slice, text, 0, MAX_CHECK_LENGTH);
        if (looksLikeCommand(text) && (test(LURE_PATTERN, text) || !view.shows(text)))
            return 'command';
        const addresses = findAddresses(text, true);
        for (const address in addresses) {
            if (!view.showsAddress(address))
                return 'address';
        }
        return '';
    }

    // The part of text that isn't the selection
    function remainder(text, selection) {
        const all = collapse(text);
        const own = collapse(selection);
        const at = own ? call(indexOf, all, own) : -1;
        return at === -1 ? text : call(slice, all, 0, at) + '\n' + call(slice, all, at + own.length);
    }

    // Why the page's version of something the user copied is blocked, or ''
    function judgeChange(text, selection, view) {
        text = call(slice, text, 0, MAX_CHECK_LENGTH);
        const own = findAddresses(selection, false);
        if (own) {
            const written = findAddresses(text, false);
            for (const address in written) {
                if (!own[address])
                    return 'swap';
            }
        }
        const added = remainder(text, selection);
        if (looksLikeCommand(added) && (test(LURE_PATTERN, added) || !view.shows(added)))
            return 'command';
        return '';
    }

    function report(kind, text, original) {
        const detail = stringify({
            __proto__: null,
            kind,
            text: call(slice, text, 0, MAX_REPORT_LENGTH),
            original: call(slice, original, 0, MAX_REPORT_LENGTH),
            host: mainLocation.hostname,
            url: mainLocation.href,
        });
        try {
            call(dispatchEvent, mainDocument, new CustomEventCtor(REPORT_EVENT, {__proto__: null, detail}));
        } catch {}
    }

    // What to write instead of data a page sets during a copy or cut event,
    // or null to keep it
    function checkCopyData(context, format, data) {
        let type;
        let text;
        try {
            type = call(toLowerCase, '' + format);
            text = '' + data;
        } catch {
            return null;
        }
        const html = type === 'text/html';
        if (type !== 'text/plain' && type !== 'text' && !html)
            return null;
        const plain = html ? htmlToText(text) : text;
        const view = pageView(context.docs);
        const kind = context.userCopy ? judgeChange(plain, context.selection, view) : judgeWrite(plain, view);
        if (!kind)
            return null;
        if (!context.reported) {
            context.reported = true;
            report(kind, plain, context.userCopy ? context.selection : '');
        }
        // Keep what the user selected, or put nothing on the clipboard
        const safe = context.userCopy ? context.selection : '';
        return html ? escapeHtml(safe) : safe;
    }

    async function plainTextOf(item) {
        try {
            const types = call(itemTypes, item);
            let hasText = false;
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'text/plain')
                    hasText = true;
            }
            if (!hasText)
                return null;
            return await call(blobText, await call(itemGetType, item, 'text/plain'));
        } catch {
            return null;
        }
    }

    // A promise like the one a successful clipboard write returns
    const pretendWritten = async () => {};

    // ---------------------------------------------------------------------
    // Wrapping the page's clipboard functions

    function wrapMethod(target, name, makeWrapper) {
        const descriptor = target ? getOwnPropertyDescriptor(target, name) : undefined;
        if (!descriptor || typeof descriptor.value !== 'function')
            return;
        defineProperty(target, name, {
            __proto__: null,
            value: makeWrapper(descriptor.value),
            writable: descriptor.writable,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
        });
    }

    function wrapGetter(target, name, makeGetter) {
        const descriptor = target ? getOwnPropertyDescriptor(target, name) : undefined;
        if (!descriptor || typeof descriptor.get !== 'function')
            return;
        defineProperty(target, name, {
            __proto__: null,
            get: makeGetter(descriptor.get),
            set: descriptor.set,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable,
        });
    }

    // Protects a window the page opened or reached through a frame, so the
    // page can't use that window's unwrapped functions instead
    function protectReached(win) {
        try {
            if (win)
                protect(win);
        } catch {
            // Another site's window; ClipGuard runs there on its own
        }
    }

    function protect(win) {
        const doc = win.document;
        if (call(setHas, protectedDocuments, doc))
            return;
        call(setAdd, protectedDocuments, doc);
        const docs = doc === mainDocument ? [doc] : [doc, mainDocument];

        const clipboard = win.Clipboard ? win.Clipboard.prototype : null;
        wrapMethod(clipboard, 'writeText', original => function writeText(data) {
            let text;
            try {
                text = '' + data;
            } catch {
                return call(original, this, data);
            }
            const kind = judgeWrite(text, pageView(docs));
            if (kind) {
                report(kind, text, '');
                return pretendWritten();
            }
            return call(original, this, data);
        });

        wrapMethod(clipboard, 'write', original => function write(data) {
            const self = this;
            return (async () => {
                const items = [];
                for (const item of data)
                    items[items.length] = item;
                for (let i = 0; i < items.length; i++) {
                    const text = await plainTextOf(items[i]);
                    const kind = text === null ? '' : judgeWrite(text, pageView(docs));
                    if (kind) {
                        report(kind, text, '');
                        return;
                    }
                }
                return call(original, self, items);
            })();
        });

        wrapMethod(win.Document.prototype, 'execCommand', original => function execCommand(...args) {
            let command = '';
            try {
                command = call(toLowerCase, '' + args[0]);
            } catch {}
            if (command !== 'copy' && command !== 'cut')
                return apply(original, this, args);
            const selection = selectedText(this);
            const kind = judgeWrite(selection, pageView(docs));
            if (kind) {
                report(kind, selection, '');
                return true;
            }
            execDepth++;
            try {
                return apply(original, this, args);
            } finally {
                execDepth--;
            }
        });

        wrapMethod(win.DataTransfer.prototype, 'setData', original => function setData(format, data) {
            const context = call(mapGet, copyEvents, this);
            const replacement = context ? checkCopyData(context, format, data) : null;
            return call(original, this, format, replacement === null ? data : replacement);
        });

        wrapMethod(win.DataTransferItemList.prototype, 'add', original => function add(data, type) {
            const context = typeof data === 'string' ? call(mapGet, copyEvents, this) : undefined;
            const replacement = context ? checkCopyData(context, type, data) : null;
            return call(original, this, replacement === null ? data : replacement, type);
        });

        // Runs first in every copy and cut event, before the page's handlers
        const onCopy = event => {
            let data;
            try {
                data = call(clipboardDataOf, event);
            } catch {
                return;
            }
            if (!data)
                return;
            const userCopy = event.isTrusted && execDepth === 0;
            let selection = selectedText(doc);
            // The page may have moved the selection to hidden text
            if (userCopy) {
                const kind = judgeWrite(selection, pageView(docs));
                if (kind) {
                    call(preventDefault, event);
                    report(kind, selection, '');
                    selection = '';
                }
            }
            const context = {__proto__: null, userCopy, selection, docs, reported: false};
            call(mapSet, copyEvents, data, context);
            try {
                call(mapSet, copyEvents, call(itemsOf, data), context);
            } catch {}
        };
        call(addEventListener, win, 'copy', onCopy, true);
        call(addEventListener, win, 'cut', onCopy, true);

        const frameTypes = ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement'];
        for (let i = 0; i < frameTypes.length; i++) {
            const type = win[frameTypes[i]];
            const proto = type ? type.prototype : null;
            wrapGetter(proto, 'contentWindow', original => function () {
                const value = call(original, this);
                protectReached(value);
                return value;
            });
            wrapGetter(proto, 'contentDocument', original => function () {
                const value = call(original, this);
                if (value)
                    protectReached(call(defaultViewOf, value));
                return value;
            });
        }
        wrapMethod(win, 'open', original => function open(...args) {
            const opened = apply(original, this, args);
            protectReached(opened);
            return opened;
        });
    }

    protect(mainWindow);
})();
