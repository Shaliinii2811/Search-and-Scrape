// before running the script install node.js and dependencies:
// npm install rebrowser-playwright
// node search-and-scrape.mjs

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { simulateMouseMovement } from './scripts/stealth-template.mjs';

// rebrowser's Runtime.enable fix must be set BEFORE importing the library
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= 'addBinding';
const { chromium } = await import('rebrowser-playwright');

// ====================== CONFIGURATION ======================
const TERMS_FILE = './brand.json';
const OUTPUT_DIR = './output';
const MASTER_JSON_FILE = path.join(OUTPUT_DIR, 'search_results.json');
const SEARCH_ENGINE = 'https://www.google.com/search?udm=14&hl=id&gl=id&q='; // udm=14 forces clean Web results
const MIN_DELAY_MS = 4000;   // delay between searches
const MAX_DELAY_MS = 9000;

// ---- Chrome real browser paths ----
// The executable used to launch the browser
const REAL_CHROME_PATH = process.env.CHROME_PATH || 'C:\\Users\\AI ML Shalynee\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
// The User Data directory that holds your logged-in profiles / cookies
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA || 'C:\\Users\\AI ML Shalynee\\AppData\\Local\\Google\\Chrome\\User Data';
// Which profile subfolder to use (Default = main profile)
const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';

// ---- Scheduler Settings ----
const SCHEDULE_INTERVAL_MINUTES = 20;  // interval between cycles (minutes)
const ENABLE_SCHEDULER = true;          // true = repeat automatically; false = single run

// ====================== FFMPEG CONFIGURATION ======================
function setupFfmpeg() {
    const binDir = path.resolve('bin');
    const ffmpegExe = path.join(binDir, 'ffmpeg.exe');
    if (fsSync.existsSync(ffmpegExe)) {
        process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;
        return ffmpegExe;
    }
    return 'ffmpeg';
}

// ====================== AUDIO CHALLENGE TRANSCRIBER ======================
async function processAudioChallenge(audioUrl) {
    const tempDir = os.tmpdir();
    const randId = Math.floor(Math.random() * 90000) + 10000;
    const mp3Path = path.join(tempDir, `rc_${randId}.mp3`);
    const wavPath = path.join(tempDir, `rc_${randId}.wav`);
    const ffmpegCmd = setupFfmpeg();

    try {
        // 1. Download MP3 audio challenge
        const resp = await fetch(audioUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
            }
        });
        if (!resp.ok) {
            throw new Error(`Audio download failed: ${resp.statusText}`);
        }
        const arrayBuffer = await resp.arrayBuffer();
        await fs.writeFile(mp3Path, Buffer.from(arrayBuffer));

        // 2. Convert MP3 to 16kHz mono WAV using ffmpeg
        execFileSync(ffmpegCmd, ['-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', wavPath], {
            stdio: 'ignore'
        });

        // 3. Speech Recognition using Python speech_recognition
        const pyScript = `
import sys, speech_recognition as sr
r = sr.Recognizer()
with sr.AudioFile(sys.argv[1]) as src:
    audio = r.record(src)
print(r.recognize_google(audio))
`;
        try {
            const stdout = execFileSync('python', ['-c', pyScript, wavPath], {
                encoding: 'utf-8',
                timeout: 20000
            });
            return stdout.trim();
        } catch (pyErr) {
            // Direct Google Speech API fallback if python speech_recognition encounters an issue
            const wavData = await fs.readFile(wavPath);
            const apiUrl = 'http://www.google.com/speech-api/v2/recognize?client=chromium&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw';
            const apiResp = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'audio/l16; rate=16000'
                },
                body: wavData
            });
            const apiText = await apiResp.text();
            for (const line of apiText.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.result && parsed.result[0]?.alternative?.[0]?.transcript) {
                        return parsed.result[0].alternative[0].transcript;
                    }
                } catch { }
            }
            throw pyErr;
        }
    } finally {
        for (const p of [mp3Path, wavPath]) {
            try { await fs.unlink(p); } catch { }
        }
    }
}

// ====================== RECAPTCHA SOLVER ======================
class PlaywrightRecaptchaSolver {
    /**
     * reCAPTCHA solver designed natively for Playwright / rebrowser-playwright.
     */
    constructor(page) {
        this.page = page;
    }

    get anchorFrame() {
        // The checkbox iframe
        return this.page.frameLocator('iframe[src*="anchor"], iframe[title="reCAPTCHA"]').first();
    }

    get challengeFrame() {
        // The popup challenge (images / audio) iframe
        return this.page.frameLocator('iframe[src*="bframe"], iframe[title*="challenge" i], iframe[title*="expires in two minutes" i]').first();
    }

    async isCaptchaPresent() {
        try {
            if (this.page.url().includes('sorry/index')) {
                return true;
            }
            const anchorCount = await this.page.locator('iframe[src*="anchor"], iframe[title="reCAPTCHA"]').count();
            if (anchorCount > 0) {
                return !(await this.isSolved());
            }
            return false;
        } catch {
            return false;
        }
    }

    async isSolved() {
        try {
            const anchor = this.anchorFrame.locator('#recaptcha-anchor');
            if ((await anchor.count()) > 0) {
                const checked = await anchor.getAttribute('aria-checked', { timeout: 1000 }).catch(() => null);
                if (checked === 'true') {
                    return true;
                }
            }
        } catch { }

        try {
            // If anchor iframe is gone from a sorry/recaptcha page, it has cleared
            const count = await this.page.locator('iframe[src*="anchor"], iframe[title="reCAPTCHA"]').count();
            if (count === 0 && !this.page.url().includes('sorry')) {
                return true;
            }
        } catch { }

        return false;
    }

    async isDetected() {
        try {
            const msg = this.challengeFrame.locator('.rc-doscaptcha-body-text, :text("Try again later"), :text("automated queries")');
            if ((await msg.count()) > 0 && (await msg.first().isVisible({ timeout: 500 }).catch(() => false))) {
                return true;
            }
        } catch { }

        try {
            const pageMsg = this.page.locator(':text("Try again later")');
            if (await pageMsg.first().isVisible({ timeout: 500 }).catch(() => false)) {
                return true;
            }
        } catch { }

        return false;
    }

    async isChallengeOpen() {
        try {
            const audioBtn = this.challengeFrame.locator('#recaptcha-audio-button');
            const audioSrc = this.challengeFrame.locator('#audio-source, a.rc-audiochallenge-tdownload-link, a[href*="audio.mp3"]');
            const audioInput = this.challengeFrame.locator('#audio-response');
            const verifyBtn = this.challengeFrame.locator('#recaptcha-verify-button');

            if ((await audioBtn.count()) > 0 && (await audioBtn.first().isVisible({ timeout: 800 }).catch(() => false))) return true;
            if ((await audioSrc.count()) > 0 && (await audioSrc.first().isVisible({ timeout: 800 }).catch(() => false))) return true;
            if ((await audioInput.count()) > 0 && (await audioInput.first().isVisible({ timeout: 800 }).catch(() => false))) return true;
            if ((await verifyBtn.count()) > 0 && (await verifyBtn.first().isVisible({ timeout: 800 }).catch(() => false))) return true;
        } catch { }
        return false;
    }

    async solve(maxRounds = 6) {
        for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
            console.log(`[Captcha] Round ${roundNum}/${maxRounds}`);

            if (!(await this.isCaptchaPresent())) {
                console.log('[Captcha] No captcha present');
                return true;
            }

            if (await this.isSolved()) {
                console.log('[Captcha] Solved successfully');
                return true;
            }

            try {
                await this._solveSingle();
            } catch (err) {
                console.log(`[Captcha] Round ${roundNum} note: ${err.message}`);
            }

            await this.page.waitForTimeout(2000);

            if (!(await this.isCaptchaPresent()) || (await this.isSolved())) {
                console.log('[Captcha] Solved successfully!');
                return true;
            }
        }

        console.log('[Captcha] Failed to solve after max rounds');
        return false;
    }

    async _solveSingle() {
        // 1. If challenge popup is not open, click checkbox
        const challengeOpen = await this.isChallengeOpen();
        if (!challengeOpen) {
            console.log('[Captcha] Clicking checkbox...');
            try {
                const checkbox = this.anchorFrame.locator('#recaptcha-anchor, .rc-anchor-content').first();
                await checkbox.click({ timeout: 6000, force: true });
                await this.page.waitForTimeout(2000);
            } catch (e) {
                console.log(`[Captcha] Checkbox click: ${e.message}`);
            }

            if (await this.isSolved()) {
                console.log('[Captcha] Solved by checkbox alone');
                return;
            }
        }

        // 2. Check if Google blocked with "Try again later"
        if (await this.isDetected()) {
            throw new Error('Bot detected by Google (Try again later)');
        }

        // 3. Switch to audio challenge if not already on audio screen
        const audioInput = this.challengeFrame.locator('#audio-response');
        let audioInputVisible = false;
        try {
            audioInputVisible = (await audioInput.count()) > 0 && (await audioInput.first().isVisible({ timeout: 1000 }).catch(() => false));
        } catch {
            audioInputVisible = false;
        }

        if (!audioInputVisible) {
            const audioBtn = this.challengeFrame.locator('#recaptcha-audio-button');
            try {
                if ((await audioBtn.count()) > 0 && (await audioBtn.first().isVisible({ timeout: 3000 }).catch(() => false))) {
                    console.log('[Captcha] Switching to audio challenge...');
                    await audioBtn.first().click({ timeout: 6000, force: true });
                    await this.page.waitForTimeout(2000);
                }
            } catch (e) {
                console.log(`[Captcha] Audio button click issue: ${e.message}`);
            }
        }

        if (await this.isDetected()) {
            throw new Error('Bot detected by Google (Try again later)');
        }

        // 4. Locate audio source URL
        let audioUrl = null;
        try {
            const elem = this.challengeFrame.locator('#audio-source');
            if ((await elem.count()) > 0) {
                audioUrl = await elem.first().getAttribute('src', { timeout: 4000 });
            }
        } catch { }

        if (!audioUrl) {
            try {
                const elem = this.challengeFrame.locator('a.rc-audiochallenge-tdownload-link, a[href*="audio.mp3"]');
                if ((await elem.count()) > 0) {
                    audioUrl = await elem.first().getAttribute('href', { timeout: 4000 });
                }
            } catch { }
        }

        if (!audioUrl) {
            if (await this.isDetected()) {
                throw new Error('Bot detected by Google (Try again later)');
            }
            throw new Error('Could not find audio source URL');
        }

        console.log('[Captcha] Processing audio challenge...');

        // 5. Download and transcribe speech
        const text = await processAudioChallenge(audioUrl);
        console.log(`[Captcha] Recognized text: ${text}`);

        if (!text || !text.trim()) {
            throw new Error('Speech transcription returned empty text');
        }

        // 6. Fill audio response and click Verify
        const inputField = this.challengeFrame.locator('#audio-response').first();
        await inputField.fill(text.trim().toLowerCase());
        await this.page.waitForTimeout(500);

        const verifyBtn = this.challengeFrame.locator('#recaptcha-verify-button').first();
        await verifyBtn.click({ timeout: 6000, force: true });
        await this.page.waitForTimeout(2500);
    }
}

// ====================== HUMANLIKE BEHAVIOR HELPERS ======================
function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(min = MIN_DELAY_MS, max = MAX_DELAY_MS) {
    return randomBetween(min, max);
}

/**
 * Type text character-by-character with human-like timing and micro-pauses.
 */
async function humanType(page, selector, text) {
    const element = page.locator(selector);
    await element.click();
    await page.waitForTimeout(randomBetween(300, 700));

    for (const char of text) {
        await element.type(char, { delay: randomBetween(70, 180) });
        if (Math.random() < 0.12) {
            await page.waitForTimeout(randomBetween(150, 400));
        }
    }

    await page.waitForTimeout(randomBetween(400, 900));
}

// ====================== LINK RESOLUTION HELPER ======================
/**
 * Resolves Google search redirect/proxy links to the real destination URL.
 */
async function resolveRedirectUrl(rawUrl, page = null) {
    if (!rawUrl) return rawUrl;

    try {
        const parsed = new URL(rawUrl);

        // 1. Handle plain /url?q=... or /url?url=...
        if (parsed.searchParams.has('q')) {
            const target = parsed.searchParams.get('q');
            if (/^https?:\/\//i.test(target)) return target;
        }

        if (parsed.searchParams.has('url')) {
            const target = parsed.searchParams.get('url');
            if (/^https?:\/\//i.test(target)) return target;
        }

        // 2. Handle encrypted /goto?url=... or /url?... Google proxy links
        if (
            parsed.hostname.includes('google.') &&
            (parsed.pathname.includes('/goto') || parsed.pathname.includes('/url'))
        ) {
            const resp = await fetch(rawUrl, {
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                }
            });
            const location = resp.headers.get('location');
            if (location) {
                if (location.startsWith('/')) {
                    return `https://www.google.com${location}`;
                }
                return location;
            }

            if (page) {
                const response = await page.request.get(rawUrl, {
                    maxRedirects: 5,
                    timeout: 4000,
                });
                const finalUrl = response.url();
                if (
                    finalUrl &&
                    !finalUrl.includes('google.com/goto') &&
                    !finalUrl.includes('google.com/url')
                ) {
                    return finalUrl;
                }
            }
        }
    } catch {
        // Fallback to rawUrl if network lookup fails
    }

    return rawUrl;
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

// ====================== RESULTS SAVER ======================
async function saveResults(term, page, index, total, brandResults, count, searchUrl) {
    const safeName = term.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
    const base = path.join(OUTPUT_DIR, `${String(index).padStart(3, '0')}_${safeName}`);
    const screenshotPath = `${base}.png`;

    // 1. Screenshot
    await page.screenshot({
        path: screenshotPath,
        fullPage: true,
    });

    // 2. Text content (readable)
    const text = await page.evaluate(() => document.body.innerText);
    await fs.writeFile(`${base}.txt`, text, 'utf8');

    // 3. Full HTML (for archiving / parsing)
    const html = await page.content();
    await fs.writeFile(`${base}.html`, html, 'utf8');

    // 4. Individual Brand JSON
    const brandData = {
        index,
        total,
        brand: term,
        search_url: searchUrl,
        screenshot: screenshotPath,
        results_count: count,
        results: brandResults
    };
    await fs.writeFile(`${base}.json`, JSON.stringify(brandData, null, 2), 'utf8');

    // 5. Append to Master JSON (all search results)
    let masterData = [];
    if (fsSync.existsSync(MASTER_JSON_FILE)) {
        try {
            masterData = JSON.parse(await fs.readFile(MASTER_JSON_FILE, 'utf8'));
            if (!Array.isArray(masterData)) masterData = [];
        } catch {
            masterData = [];
        }
    }
    masterData.push(brandData);
    await fs.writeFile(MASTER_JSON_FILE, JSON.stringify(masterData, null, 2), 'utf8');

    console.log(`  → saved ${base}.{png,txt,html,json} (${brandResults.length} organic links saved)`);
}

// ====================== SEARCH SINGLE BRAND ======================
async function searchBrand(page, brand, index, total) {
    console.log(`\n============================================================`);
    console.log(`[${index}/${total}] Searching brand: "${brand}"`);
    console.log(`============================================================`);

    const solver = new PlaywrightRecaptchaSolver(page);

    try {
        // 1. Navigate to Google homepage first with natural human behavior
        await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(randomBetween(1800, 3200));

        // Check for initial captcha
        if (await solver.isCaptchaPresent()) {
            console.log(`[${index}/${total}] Captcha detected on Google home for ${brand} — solving...`);
            const solved = await solver.solve(6);
            if (!solved) {
                console.log(`[${index}/${total}] Captcha could not be solved before search for ${brand}`);
                return false;
            }
        }

        // Human-like mouse movement
        await page.mouse.move(randomBetween(200, 900), randomBetween(150, 450), { steps: 5 });
        await page.waitForTimeout(randomBetween(400, 900));
        await simulateMouseMovement(page);

        // 2. Navigate to search results with udm=14
        const searchUrl = `${SEARCH_ENGINE}${encodeURIComponent(brand)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(randomBetween(2500, 4500));

        // 3. Captcha check on search results
        if (await solver.isCaptchaPresent()) {
            console.log(`[${index}/${total}] Captcha detected on search results for ${brand} — solving...`);
            const solved = await solver.solve(6);
            if (!solved) {
                console.log(`[${index}/${total}] Could not solve captcha for ${brand}`);
                return false;
            }
            await page.waitForTimeout(2000);
            await page.waitForLoadState('domcontentloaded');
        }

        // Verify page is not still blocked by captcha
        if ((await solver.isCaptchaPresent()) || page.url().includes('sorry/index')) {
            console.log(`[${index}/${total}] Captcha still blocking results for ${brand}`);
            return false;
        }

        // 4. Human-like scrolling
        await page.evaluate(() => {
            window.scrollBy(0, Math.floor(Math.random() * 600) + 200);
        });
        await page.waitForTimeout(randomBetween(600, 1500));

        // 5. Extract results (headings and links)
        const results = page.locator('a h3');
        let count = await results.count();

        // Fallback for localized or layout variants
        if (count === 0) {
            const altHeadings = page.locator('#rso h3, #search h3, div.g h3, .MjjYud h3');
            count = await altHeadings.count();
        }

        console.log(`[${index}/${total}] ${brand}: Found ${count} results`);

        if (count === 0 && ((await solver.isDetected()) || page.url().includes('sorry'))) {
            console.log(`[${index}/${total}] Bot detection triggered on '${brand}'`);
            return false;
        }

        // Collect and resolve top organic links
        const brandResults = [];
        const seenUrls = new Set();

        for (let i = 0; i < Math.min(10, count); i++) {
            try {
                const heading = results.nth(i);
                let title = (await heading.innerText().catch(() => '')).trim();
                let link = await heading.locator('xpath=..').getAttribute('href').catch(() => null);

                // Fallback: check if anchor is an ancestor
                if (!link) {
                    link = await heading.evaluate(el => el.closest('a')?.getAttribute('href') || null);
                }

                if (link && link.startsWith('/')) {
                    link = `https://www.google.com${link}`;
                }

                link = await resolveRedirectUrl(link, page);

                if (title && link && !seenUrls.has(link)) {
                    seenUrls.add(link);
                    console.log(`[${index}/${total}] ${brand}: ${brandResults.length + 1}. ${title}`);
                    console.log(`         → ${link}`);
                    brandResults.push({
                        rank: brandResults.length + 1,
                        title,
                        url: link
                    });
                }
            } catch {
                continue;
            }
        }

        // Save results to disk
        await saveResults(brand, page, index, total, brandResults, count, page.url());
        console.log(`✅ [${index}/${total}] ${brand} finished successfully.\n`);
        return true;

    } catch (err) {
        console.error(`[!] [${index}/${total}] Error searching '${brand}': ${err.message}`);
        return false;
    }
}

// ====================== LOAD BRANDS ======================
async function loadBrands() {
    const candidates = [TERMS_FILE, './terms.json'];
    for (const p of candidates) {
        if (fsSync.existsSync(p)) {
            try {
                const content = await fs.readFile(p, 'utf8');
                const parsed = JSON.parse(content);
                if (Array.isArray(parsed)) return parsed;
                if (parsed && Array.isArray(parsed.brands)) return parsed.brands;
            } catch (err) {
                console.error(`[!] Error loading brands from ${p}: ${err.message}`);
            }
        }
    }
    throw new Error(`Could not find valid brand list in ${TERMS_FILE}`);
}

// ====================== INIT SCRIPT (strips Playwright artifacts) ======================
function stripPlaywrightArtifacts() {
    const hide = (k) => {
        try { delete window[k]; } catch { /* non-configurable */ }
        if (Object.prototype.hasOwnProperty.call(window, k)) {
            try { Object.defineProperty(window, k, { get: () => undefined, configurable: true }); } catch { /* sealed */ }
        }
    };
    for (const k of Object.getOwnPropertyNames(window)) {
        if (/^__pw|pwInitScripts|playwright/i.test(k)) hide(k);
    }
    if (!window.chrome) window.chrome = {};
}

// ====================== LAUNCH REAL CHROME WITH EXISTING PROFILE ======================
/**
 * Chrome blocks Playwright remote-debugging (CDP) when pointed at the real system
 * User Data dir. Work-around: copy the essential login/cookie files from the real
 * Default profile into a local ./chrome-session/ folder, then launch from there.
 *
 * The copy is refreshed on every call so your latest cookies are always used.
 * IMPORTANT: Chrome must be fully closed before running this script, otherwise the
 * Cookies file is locked and the copy will fail.
 */

// Files copied from the Default profile to keep login sessions / cookies alive
const PROFILE_FILES_TO_COPY = [
    'Cookies',
    'Cookies-journal',
    'Extension Cookies',
    'Extension Cookies-journal',
    'Login Data',
    'Login Data-journal',
    'Login Data For Account',
    'Login Data For Account-journal',
    'Preferences',
    'Secure Preferences',
    'Web Data',
    'Web Data-journal',
    'Bookmarks',
    'Favicons',
];

async function prepareProfileCopy() {
    const srcDir = path.join(CHROME_USER_DATA_DIR, CHROME_PROFILE);
    const sessionDir = path.resolve('chrome-session');
    const destDir = path.join(sessionDir, CHROME_PROFILE);

    await fs.mkdir(destDir, { recursive: true });

    // Copy top-level Local State (Chrome needs this for encryption keys)
    const localStateSrc = path.join(CHROME_USER_DATA_DIR, 'Local State');
    const localStateDst = path.join(sessionDir, 'Local State');
    if (fsSync.existsSync(localStateSrc)) {
        try {
            await fs.copyFile(localStateSrc, localStateDst);
        } catch (e) {
            console.warn(`[Profile] Could not copy Local State: ${e.message}`);
        }
    }

    // Copy profile-level files
    let copied = 0;
    for (const fileName of PROFILE_FILES_TO_COPY) {
        const src = path.join(srcDir, fileName);
        const dst = path.join(destDir, fileName);
        if (fsSync.existsSync(src)) {
            try {
                await fs.copyFile(src, dst);
                copied++;
            } catch (e) {
                // Cookies file will be locked if Chrome is still open
                if (e.code === 'EBUSY' || e.code === 'EPERM') {
                    console.error(`\n[Profile] ⚠️  Cannot copy '${fileName}' — Chrome is still running!`);
                    console.error(`[Profile]    Please CLOSE Chrome completely and re-run the script.\n`);
                } else {
                    console.warn(`[Profile] Could not copy '${fileName}': ${e.message}`);
                }
            }
        }
    }

    console.log(`[Profile] Copied ${copied} session files → ./chrome-session/`);
    return sessionDir;
}

async function launchWithProfile() {
    console.log(`[Browser] Preparing profile copy from: ${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}`);

    // Copy real Chrome profile to local dir (bypasses the CDP restriction on system dir)
    const sessionDir = await prepareProfileCopy();

    const executablePath = fsSync.existsSync(REAL_CHROME_PATH) ? REAL_CHROME_PATH : undefined;
    if (executablePath) console.log(`[Browser] Executable: ${executablePath}`);
    console.log(`[Browser] Session dir: ${sessionDir}`);

    const contextOptions = {
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-first-run',
            '--no-default-browser-check',
            `--profile-directory=${CHROME_PROFILE}`,
        ],
        viewport: { width: 1366, height: 768 },
        ignoreDefaultArgs: ['--enable-automation'],
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
    };

    if (executablePath) contextOptions.executablePath = executablePath;

    const context = await chromium.launchPersistentContext(sessionDir, contextOptions);

    // Strip Playwright main-world artifacts on every page navigation
    await context.addInitScript(stripPlaywrightArtifacts);

    // Reuse the first open page or open a fresh one
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    return { context, page };
}

// ====================== RUN ONE FULL CYCLE ======================
async function runSingleCycle(cycleNum = 1) {
    const brands = await loadBrands();
    if (brands.length === 0) {
        console.log('[!] No brands found to search. Skipping cycle.');
        return;
    }

    await ensureDir(OUTPUT_DIR);

    const now = new Date();
    const readable = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    console.log(`\n${'='.repeat(62)}`);
    console.log(`🚀 [CYCLE #${cycleNum}] Started at: ${readable}`);
    console.log(`   Total brands: ${brands.length}`);
    console.log(`   Output folder: ${OUTPUT_DIR}`);
    console.log(`${'='.repeat(62)}\n`);

    const { context, page } = await launchWithProfile();

    try {
        // Iterate sequentially brand-by-brand (single page, no concurrent tabs)
        for (let i = 0; i < brands.length; i++) {
            const brand = String(brands[i]).trim();
            if (!brand) continue;

            await searchBrand(page, brand, i + 1, brands.length);

            // Natural delay before navigating to next search
            if (i < brands.length - 1) {
                const delay = randomDelay();
                console.log(`  waiting ${Math.round(delay / 1000)}s before next search…`);
                await page.waitForTimeout(delay);
            }
        }

        console.log(`\n✅ Cycle #${cycleNum} done. Results saved to ${OUTPUT_DIR} and ${MASTER_JSON_FILE}`);
    } finally {
        await context.close();
    }
}

// ====================== MAIN — SCHEDULER LOOP ======================
async function main() {
    if (!ENABLE_SCHEDULER) {
        console.log('▶  Scheduler disabled. Running single execution…');
        await runSingleCycle(1);
        return;
    }

    const intervalMs = SCHEDULE_INTERVAL_MINUTES * 60 * 1000;
    console.log(`\n${'#'.repeat(62)}`);
    console.log(`  ⏰  REPEATING SCHEDULER ACTIVE`);
    console.log(`  ⏰  Interval: ${SCHEDULE_INTERVAL_MINUTES} minute(s)`);
    console.log(`  ⏰  Press Ctrl+C to stop`);
    console.log(`${'#'.repeat(62)}\n`);

    let cycle = 1;
    while (true) {
        const cycleStart = Date.now();

        try {
            await runSingleCycle(cycle);
        } catch (err) {
            console.error(`[!] Error during Cycle #${cycle}: ${err.message}`);
        }

        const elapsed = Date.now() - cycleStart;
        const waitMs = intervalMs - elapsed;

        if (waitMs <= 0) {
            console.log(`\n⚠️  Cycle #${cycle} took ${(elapsed / 60000).toFixed(1)} min (exceeded interval). Starting next immediately…`);
        } else {
            const nextAt = new Date(Date.now() + waitMs).toLocaleTimeString('id-ID');
            console.log(`\n💤  Cycle #${cycle} done in ${(elapsed / 60000).toFixed(1)} min.`);
            console.log(`⏳  Next cycle at: ${nextAt} (in ${(waitMs / 60000).toFixed(1)} min)`);
            // Sleep in 30-second chunks so Ctrl+C is always responsive
            let remaining = waitMs;
            while (remaining > 0) {
                await new Promise(r => setTimeout(r, Math.min(remaining, 30_000)));
                remaining -= 30_000;
            }
        }

        cycle++;
    }
}

main().catch((err) => {
    console.error('[!] Fatal execution error:', err);
    process.exit(1);
});