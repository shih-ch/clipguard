# 剪貼簿防護 ClipGuard

Chrome 擴充功能。網頁用程式寫入剪貼簿時檢查內容，攔下兩種攻擊：

- **ClickFix**：假的「我不是機器人」驗證把惡意指令偷偷放進剪貼簿，再叫你貼到終端機、Alt+F2 或 Windows「執行」視窗。
- **地址掉包**：你複製錢包地址時，網頁換成攻擊者的地址。

> A Chrome extension that checks what web pages write to the clipboard. It blocks ClickFix-style commands that a page hides from view or disguises as a CAPTCHA check, and crypto addresses swapped while you copy. The UI is in Traditional Chinese.

## 背景

- 2026-11-16 曝光的 OPTIMJACK 事件：攻擊者透過 Optimizely 的腳本，在 CNN、BBC、Zoom、HSBC 等 178 個組織的網站植入惡意程式，其中一項就是把剪貼簿裡的錢包地址換掉（[BleepingComputer](https://www.bleepingcomputer.com/news/security/optimizely-supply-chain-attack-delivers-malware-to-cnn-fox-news-bbc-salesforce-sites/)、[Help Net Security](https://www.helpnetsecurity.com/2026/11/17/optimizely-vulnerability-malicious-javascript/)）。
- ClickFix：被入侵的網站顯示假的 CAPTCHA，叫你把剪貼簿裡的東西貼到終端機或「執行」視窗（[ESET 說明](https://www.eset.com/blog/en/home-topics/privacy-and-identity-protection/fake-captcha-scam-clickfix/)）。

這個擴充功能只管剪貼簿。要擋網頁被植入的程式本身，請搭配廣告封鎖器的追蹤與惡意網址清單（例如 AdGuard 的 Tracking Protection、Online Malicious URL Blocklist）。

## 安裝

還沒上架 Chrome 線上應用程式商店，用開發人員模式載入：

1. 下載：`git clone https://github.com/shih-ch/clipguard.git`
2. Chrome 開 `chrome://extensions`，打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選 `clipguard` 資料夾。
4. （可選）要用 `file://` 開 `test/test.html` 測試，在擴充功能的「詳細資料」打開「允許存取檔案網址」。

Chrome Beta、Brave、Edge 也可以用同一個資料夾載入。更新時 `git pull`，再到 `chrome://extensions` 按這個擴充功能的重新載入。

## 會攔什麼

只在**網頁用程式寫入剪貼簿**時檢查（`navigator.clipboard.writeText`／`write`、`document.execCommand('copy')`、copy 事件裡的 `setData`），也檢查你按 Ctrl+C 時網頁有沒有改掉你選的內容。

| 情況 | 結果 |
|---|---|
| 寫入的是指令（`curl`、`wget`、`| sh`、`bash -c`、`base64 -d`、`powershell`、`mshta` 等），而且**畫面上看不到** | 攔下 |
| 指令後面有「我不是機器人／Verification ID」之類的註解偽裝 | 一律攔下 |
| 你選了錢包地址，網頁寫入的是另一個地址 | 攔下，剪貼簿放你選的原文 |
| 你選了一段文字，網頁換成或加上看不到的指令（pastejacking） | 攔下，剪貼簿放你選的原文 |
| 網頁寫入畫面上找不到的錢包地址（ETH、BTC、TRON） | 攔下 |
| 你自己選字按 Ctrl+C、右鍵複製 | 不檢查內容是不是指令 |
| 程式碼區塊的「複製」按鈕，內容畫面上看得到 | 照常 |
| 聊天回覆的「複製」按鈕（複製 Markdown 原文） | 照常，只比對像指令的那幾行 |
| 複製連結、一般文字、網站加上出處 | 照常 |

攔下時：網頁以為寫入成功，剪貼簿不會放進那段內容；頁面上方出現提醒，可以選「仍然複製」「這個網站一律允許」或「關閉」。工具列圖示顯示這個分頁攔了幾次，點開可以看最近紀錄、移除一律允許的網站。

## 會誤擋的情況

- 安裝說明按作業系統分頁，指令在沒點開的分頁裡就按「複製」。
- 網頁編輯器（GitHub 線上編輯、vscode.dev 之類）只畫出看得到的行，複製很長的 shell 腳本時，沒畫出來的行算「看不到」。

遇到時按「仍然複製」，常用的網站按「這個網站一律允許」。

## 擋不到的

- 網頁直接把**畫面上**的地址換掉：你看到的就是假的，複製下來也是假的。
- 竊取表單、信用卡資料：靠 AdGuard 的清單（見背景報告）。
- 網頁把指令明白顯示出來，叫你自己選取複製：這是你自己的操作。
- 指令用透明、極小字或和背景同色顯示：瀏覽器仍算「顯示在畫面上」。
- 專門針對 ClipGuard 寫的網頁：例如透過 `window.frames[0]` 拿到還沒保護的 iframe 剪貼簿，或先改掉陣列的迭代器。一般的 ClickFix 套件和網頁植入程式不會這樣做。
- Chrome 以外的程式，例如 LINE、Telegram 訊息裡的指令。

## 權限與隱私

- Chrome 會說它能「讀取和變更您在所有網站上的資料」，因為每個網頁都要放檢查程式。
- 只用到 `storage` 權限（存紀錄和允許清單），**不連網、不自動更新**，資料不離開這台電腦。
- 紀錄最多 50 筆，每筆只留前 300 字，存在擴充功能自己的儲存空間。

## 檔案

| 檔案 | 用途 |
|---|---|
| `manifest.json` | 擴充功能設定 |
| `src/guard.js` | 在網頁自己的 JavaScript 環境裡、網頁程式之前執行，包住所有寫入剪貼簿的函式並判斷內容 |
| `src/content.js` | 擴充功能這一側：轉送攔截報告、顯示提醒、按「仍然複製」時寫入剪貼簿 |
| `src/background.js` | 工具列圖示上的次數、紀錄、把提醒送到最上層頁面 |
| `popup/` | 工具列小視窗 |
| `test/test.html` | 手動測試頁，14 種情況（假指令與假地址，不會真的連線） |

## 測試紀錄（2026-11-18）

- 在暫時的 Chromium 145 headless 設定檔裡載入擴充功能，用 Playwright 跑 `test/test.html` 全部情況，加上「仍然複製」、網頁假裝點按鈕、一律允許、紀錄：**21/21 通過**。
- 對照組：同樣的測試不裝擴充功能，攔截類的 10 項全部失敗，假指令和假地址都進了剪貼簿，證明測試有效。
- 真實網站：GitHub（ollama README）和 rustup.rs 的「複製」按鈕都照常複製 `curl … | sh`，沒有誤擋。
