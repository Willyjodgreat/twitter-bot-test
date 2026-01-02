// api_scraper.js - Professional Twitter Scraper v4.1 - SSL SECURE EDITION
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
require('dotenv').config();

// ==================== SECURITY CONFIGURATION ====================
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = !isProduction;

// SSL Validation
function validateSSLConfiguration() {
    const hasSSLKey = process.env.SSL_KEY_PATH && fs.existsSync(process.env.SSL_KEY_PATH);
    const hasSSLCert = process.env.SSL_CERT_PATH && fs.existsSync(process.env.SSL_CERT_PATH);
    
    if (isProduction && (!hasSSLKey || !hasSSLCert)) {
        console.error('❌ PRODUCTION ERROR: SSL certificates are REQUIRED!');
        console.error('   Run: npm run ssl');
        console.error('   Or generate manually:');
        console.error('   openssl req -x509 -newkey rsa:2048 \\');
        console.error('     -keyout ssl/key.pem -out ssl/cert.pem \\');
        console.error('     -days 365 -nodes \\');
        console.error('     -subj "/C=US/ST=State/L=City/O=TwitterBot/CN=localhost"');
        return false;
    }
    
    if (hasSSLKey && hasSSLCert) {
        console.log(`✅ SSL: Certificates found at ${process.env.SSL_KEY_PATH}`);
        return true;
    }
    
    if (isDevelopment) {
        console.warn('⚠️ DEVELOPMENT: SSL not configured. Using HTTP.');
        return false;
    }
    
    return false;
}

const sslEnabled = validateSSLConfiguration();

// ==================== UTILITY CLASSES ====================
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.requestCount = 0;
        this.lastProcessedTime = 0;
        this.maxQueueSize = 50;
    }

    async add(job, priority = 0) {
        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxQueueSize) {
                return reject(new Error('Queue limit reached. Try again later.'));
            }
            
            const jobEntry = { 
                job, 
                resolve, 
                reject, 
                id: this.requestCount++, 
                priority,
                timestamp: Date.now() 
            };
            
            if (priority > 0) {
                this.queue.unshift(jobEntry);
            } else {
                this.queue.push(jobEntry);
            }
            
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const { job, resolve, reject, id } = this.queue.shift();

        console.log(`📊 Queue: Processing job ${id}, ${this.queue.length} waiting`);

        try {
            const result = await job();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.processing = false;
            this.lastProcessedTime = Date.now();
            setTimeout(() => this._processQueue(), 1000);
        }
    }

    getStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            totalProcessed: this.requestCount - this.queue.length,
            lastProcessed: this.lastProcessedTime ? new Date(this.lastProcessedTime).toISOString() : null,
            maxQueueSize: this.maxQueueSize
        };
    }
}

class DeduplicationManager {
    constructor(maxMemory = 50000) {
        this.seenTweetIds = new Set();
        this.seenContentHashes = new Map();
        this.maxMemory = maxMemory;
        this.cleanupThreshold = maxMemory * 0.8;
        this.hitRate = { total: 0, hits: 0 };
        this.lastCleanup = Date.now();
    }

    _calculateHash(text) {
        const str = text.substring(0, 200);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return `${hash.toString(36)}_${str.length}`;
    }

    isDuplicate(tweet) {
        this.hitRate.total++;
        
        if (tweet.id && this.seenTweetIds.has(tweet.id)) {
            this.hitRate.hits++;
            return true;
        }

        const contentHash = this._calculateHash(tweet.text);
        const existing = this.seenContentHashes.get(contentHash);
        
        if (existing && (Date.now() - existing.timestamp) < 24 * 60 * 60 * 1000) {
            this.hitRate.hits++;
            return true;
        }

        return false;
    }

    addTweet(tweet) {
        if (tweet.id) {
            this.seenTweetIds.add(tweet.id);
        }
        
        const contentHash = this._calculateHash(tweet.text);
        this.seenContentHashes.set(contentHash, {
            timestamp: Date.now(),
            id: tweet.id
        });

        if (Date.now() - this.lastCleanup > 60000) {
            this._cleanupOldEntries();
            this.lastCleanup = Date.now();
        }
    }

    _cleanupOldEntries() {
        const cutoff = Date.now() - (2 * 24 * 60 * 60 * 1000);
        let deletedHashes = 0;
        
        for (const [hash, data] of this.seenContentHashes.entries()) {
            if (data.timestamp < cutoff) {
                this.seenContentHashes.delete(hash);
                deletedHashes++;
            }
        }

        if (this.seenTweetIds.size > this.cleanupThreshold) {
            const array = Array.from(this.seenTweetIds);
            const toKeep = Math.floor(this.cleanupThreshold * 0.9);
            this.seenTweetIds = new Set(array.slice(-toKeep));
        }

        if (deletedHashes > 0) {
            console.log(`🧹 Memory cleanup: ${deletedHashes} hashes removed`);
        }
    }

    getStats() {
        const totalChecks = this.hitRate.total;
        const hitRate = totalChecks > 0 ? 
            Math.round((this.hitRate.hits / totalChecks) * 100) : 0;
        
        return {
            uniqueIds: this.seenTweetIds.size,
            contentHashes: this.seenContentHashes.size,
            hitRate: `${hitRate}%`,
            hits: this.hitRate.hits,
            total: this.hitRate.total,
            memoryUsage: `${Math.round((this.seenTweetIds.size + this.seenContentHashes.size) / this.maxMemory * 100)}%`
        };
    }
}

class TweetCache {
    constructor() {
        this.cache = new Map();
        this.ttl = parseInt(process.env.CACHE_TTL) || (5 * 60 * 1000);
        this.maxSize = 100;
        this.hits = 0;
        this.misses = 0;
    }

    getKey(keyword, limit) {
        const timeSlot = Math.floor(Date.now() / this.ttl);
        return `${keyword.toLowerCase()}_${limit}_${timeSlot}`;
    }

    get(keyword, limit) {
        const key = this.getKey(keyword, limit);
        const entry = this.cache.get(key);
        
        if (entry && (Date.now() - entry.timestamp) < this.ttl) {
            this.hits++;
            return entry.tweets;
        }
        
        if (entry) {
            this.cache.delete(key);
        }
        
        this.misses++;
        return null;
    }

    set(keyword, limit, tweets) {
        const key = this.getKey(keyword, limit);
        
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, {
            tweets,
            timestamp: Date.now(),
            keyword,
            count: tweets.length
        });
    }

    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }

    getStats() {
        const totalRequests = this.hits + this.misses;
        const hitRate = totalRequests > 0 ? 
            Math.round((this.hits / totalRequests) * 100) : 0;
        
        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: `${hitRate}%`,
            ttlMinutes: Math.round(this.ttl / 60000),
            maxSize: this.maxSize
        };
    }
}

// ==================== MAIN SCRAPER CLASS ====================
class ApiScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        this.lastKeyword = null;
        
        this.keywords = this.loadKeywordsFromEnv();
        this.scrapeLimit = Math.min(parseInt(process.env.SCRAPE_LIMIT) || 20, 100);
        
        this.lastRequestTime = 0;
        this.scrapeHistory = [];
        this.errorCount = 0;
        this.successfulScrapes = 0;
        this.maxHistorySize = 100;
        
        this.requestQueue = new RequestQueue();
        this.deduplicator = new DeduplicationManager();
        this.tweetCache = new TweetCache();
        
        this.baseDelay = parseInt(process.env.MIN_DELAY_MS) || 30000;
        this.maxDelay = parseInt(process.env.MAX_DELAY_MS) || 120000;
        this.adaptiveDelay = this.baseDelay;
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 5;
        
        this.lastHealthCheck = 0;
        this.browserRestarts = 0;
        this.maxRestartsPerHour = 3;
        this.browserTimeout = parseInt(process.env.BROWSER_TIMEOUT) || 90000;
        
        this.setupLogging();
        this.validateEnvironment();
    }
    
    validateEnvironment() {
        if (!fs.existsSync(this.sessionFile)) {
            throw new Error(`Session file ${this.sessionFile} not found. Run: npm run cookies`);
        }
        
        try {
            const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
            const requiredCookies = ['auth_token', 'ct0'];
            const missing = requiredCookies.filter(name => 
                !session.cookies.find(c => c.name === name)
            );
            
            if (missing.length > 0) {
                console.warn(`⚠️ Missing required cookies: ${missing.join(', ')}`);
            }
        } catch (error) {
            console.warn('⚠️ Could not validate session file:', error.message);
        }
    }
    
    setupLogging() {
        const logDir = 'logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFile = path.join(logDir, `scraper_${new Date().toISOString().split('T')[0]}.log`);
        this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
        
        this.logStream.on('open', () => {
            const stats = fs.statSync(logFile);
            if (stats.size > 100 * 1024 * 1024) {
                this.logStream.end();
                fs.renameSync(logFile, logFile + '.old');
                this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
            }
        });
        
        const originalLog = console.log;
        const originalError = console.error;
        
        console.log = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            
            const timestamp = new Date().toISOString();
            this.logStream.write(`[${timestamp}] INFO: ${message}\n`);
            originalLog(`[${timestamp}]`, ...args);
        };
        
        console.error = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            
            const timestamp = new Date().toISOString();
            this.logStream.write(`[${timestamp}] ERROR: ${message}\n`);
            originalError(`[${timestamp}]`, ...args);
        };
    }
    
    loadKeywordsFromEnv() {
        const keywordsStr = process.env.SCRAPE_KEYWORDS || 'technology,ai,crypto';
        return keywordsStr.split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0 && k.length <= 100);
    }
    
    async intelligentDelay(base = 3000, max = 8000) {
        const randomDelay = base + Math.random() * (max - base);
        const errorMultiplier = 1 + (this.consecutiveErrors * 0.3);
        const actualDelay = Math.min(randomDelay * errorMultiplier, 30000);
        
        if (this.consecutiveErrors > 0) {
            console.log(`⏳ Delay: ${Math.round(actualDelay/1000)}s (${this.consecutiveErrors} errors)`);
        }
        
        await new Promise(resolve => setTimeout(resolve, actualDelay));
    }
    
    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        
        const hour = new Date().getHours();
        let timeMultiplier = 1.0;
        
        if (hour >= 9 && hour <= 21) {
            timeMultiplier = 1.5;
        } else if (hour >= 22 || hour <= 6) {
            timeMultiplier = 0.7;
        }
        
        const requiredDelay = Math.max(
            this.baseDelay,
            Math.min(this.maxDelay, this.adaptiveDelay * timeMultiplier)
        );
        
        if (this.lastRequestTime > 0 && timeSinceLast < requiredDelay) {
            const waitTime = requiredDelay - timeSinceLast;
            console.log(`🚦 Rate limit: Waiting ${Math.round(waitTime/1000)}s`);
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
    }
    
    async checkBrowserHealth() {
        if (!this.browser || !this.browser.isConnected()) {
            return false;
        }
        
        if (Date.now() - this.lastHealthCheck < 15000) {
            return true;
        }
        
        this.lastHealthCheck = Date.now();
        
        try {
            const testPage = await this.context.newPage();
            await testPage.goto('about:blank', { 
                timeout: 10000,
                waitUntil: 'domcontentloaded' 
            });
            await testPage.close();
            return true;
        } catch (error) {
            console.warn('⚠️ Browser health check failed:', error.message);
            return false;
        }
    }
    
    async safeBrowserRestart() {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        
        const recentRestarts = this.scrapeHistory.filter(
            h => h.type === 'restart' && h.timestamp > hourAgo
        ).length;
        
        if (recentRestarts >= this.maxRestartsPerHour) {
            throw new Error(`Too many browser restarts (${recentRestarts} in last hour).`);
        }
        
        console.log('🔄 Restarting browser...');
        await this.disconnect();
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.connect();
        
        this.scrapeHistory.push({
            type: 'restart',
            timestamp: now,
            reason: 'health_check'
        });
        
        this.browserRestarts++;
        console.log('✅ Browser restarted successfully');
    }
    
    async connect() {
        try {
            console.log('🚀 Initializing Twitter connection...');
            
            if (!fs.existsSync(this.sessionFile)) {
                throw new Error('No session file. Run: npm run cookies');
            }
            
            await this.intelligentDelay(2000, 4000);
            
            // SECURE BROWSER CONFIGURATION - FIXED SSL ISSUES
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled',
                `--user-agent=${process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`
            ];
            
            this.browser = await chromium.launch({ 
                headless: process.env.HEADLESS !== 'false',
                args: browserArgs
            });
            
            await this.intelligentDelay(1000, 3000);
            
            // CRITICAL SSL FIX: NEVER ignore HTTPS errors
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: false,  // ← FIXED: SSL errors NOT ignored!
                bypassCSP: false,          // ← FIXED: CSP NOT bypassed!
                javaScriptEnabled: true
            });
            
            this.context.setDefaultNavigationTimeout(this.browserTimeout);
            this.context.setDefaultTimeout(this.browserTimeout);
            
            const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
            await this.context.addCookies(session.cookies);
            console.log(`✅ Loaded ${session.cookies.length} cookies`);
            
            await this.intelligentDelay(2000, 4000);
            
            this.page = await this.context.newPage();
            this.page.setDefaultNavigationTimeout(this.browserTimeout);
            this.page.setDefaultTimeout(this.browserTimeout);
            
            console.log('🔐 Verifying login...');
            let loginSuccess = false;
            
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.page.goto('https://twitter.com/home', {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    
                    await this.intelligentDelay(3000, 5000);
                    
                    const isLoggedIn = await this.page.evaluate(() => {
                        const indicators = [
                            document.querySelector('a[href="/compose/tweet"]'),
                            document.querySelector('[data-testid="primaryColumn"]'),
                            document.querySelector('[data-testid="AppTabBar_Home_Link"]')
                        ];
                        
                        const blockers = [
                            document.querySelector('input[name="session[username_or_email]"]'),
                            document.querySelector('[data-testid="login"]')
                        ];
                        
                        return indicators.some(i => i) && !blockers.some(b => b);
                    });
                    
                    if (isLoggedIn) {
                        loginSuccess = true;
                        console.log('✅ Login verified');
                        break;
                    }
                } catch (error) {
                    console.log(`   Attempt ${attempt} failed: ${error.message}`);
                }
                
                if (attempt < 3) {
                    await this.intelligentDelay(4000, 7000);
                }
            }
            
            if (!loginSuccess) {
                throw new Error('Session expired. Please re-login.');
            }
            
            this.isConnected = true;
            this.consecutiveErrors = 0;
            console.log('🎉 Twitter connection established');
            
            return true;
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            await this.disconnect();
            throw error;
        }
    }
    
    async prepareNewSearch() {
        try {
            console.log('🧹 Preparing new search...');
            
            if (this.page) {
                try {
                    await this.page.close();
                } catch (e) {
                    console.warn('Page close warning:', e.message);
                }
                this.page = null;
            }
            
            this.page = await this.context.newPage();
            this.page.setDefaultNavigationTimeout(45000);
            this.page.setDefaultTimeout(45000);
            
            await this.page.setViewportSize({
                width: 1100 + Math.floor(Math.random() * 300),
                height: 600 + Math.floor(Math.random() * 300)
            });
            
            await this.page.mouse.move(50 + Math.random() * 100, 50 + Math.random() * 100);
            await this.intelligentDelay(300, 1000);
            
            console.log('✅ Search environment ready');
            
        } catch (error) {
            console.error('❌ Failed to prepare search:', error.message);
            throw error;
        }
    }
    
    async extractTweetData() {
        return await this.page.evaluate(({ searchKeyword }) => {
            const tweets = [];
            const seenIds = new Set();
            
            const selectors = [
                'article[data-testid="tweet"]',
                '[data-testid="tweet"]',
                'div[data-testid="cellInnerDiv"] > article',
                'div[role="article"]'
            ];
            
            let tweetElements = [];
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 5) {
                    tweetElements = Array.from(elements);
                    break;
                }
            }
            
            if (tweetElements.length === 0) {
                tweetElements = Array.from(document.querySelectorAll('article'))
                    .filter(el => {
                        const text = el.textContent || '';
                        return text.length > 30 && (text.includes('@') || text.includes('RT'));
                    });
            }
            
            tweetElements.slice(0, 50).forEach((element, index) => {
                let tweetId = element.getAttribute('data-tweet-id') || 
                             element.getAttribute('data-item-id');
                
                if (!tweetId) {
                    const link = element.querySelector('a[href*="/status/"]');
                    if (link) {
                        const match = link.getAttribute('href').match(/\/status\/(\d+)/);
                        tweetId = match ? match[1] : null;
                    }
                }
                
                if (!tweetId) {
                    const content = element.textContent || '';
                    let hash = 0;
                    for (let i = 0; i < Math.min(content.length, 50); i++) {
                        hash = ((hash << 5) - hash) + content.charCodeAt(i);
                        hash = hash & hash;
                    }
                    tweetId = `gen_${hash.toString(36)}_${index}`;
                }
                
                if (seenIds.has(tweetId)) return;
                seenIds.add(tweetId);
                
                const textContent = element.textContent || '';
                const text = textContent.replace(/\s+/g, ' ').trim().substring(0, 280);
                
                let author = '';
                const authorElem = element.querySelector('[data-testid="User-Name"]') ||
                                 element.querySelector('div[dir="ltr"] span') ||
                                 element.querySelector('a[role="link"] span');
                
                if (authorElem) {
                    author = authorElem.textContent.substring(0, 50);
                }
                
                let timestamp = '';
                let isRecent = false;
                const timeElem = element.querySelector('time');
                
                if (timeElem) {
                    timestamp = timeElem.getAttribute('datetime') || '';
                    if (timestamp) {
                        const tweetDate = new Date(timestamp);
                        const now = new Date();
                        const hoursDiff = (now - tweetDate) / (1000 * 60 * 60);
                        isRecent = hoursDiff < 24;
                    }
                }
                
                const replyCount = Array.from(element.querySelectorAll('[data-testid="reply"] span'))
                    .map(el => parseInt(el.textContent) || 0)
                    .find(num => !isNaN(num)) || 0;
                
                const likeCount = Array.from(element.querySelectorAll('[data-testid="like"] span'))
                    .map(el => parseInt(el.textContent) || 0)
                    .find(num => !isNaN(num)) || 0;
                
                if (text.length > 10) {
                    tweets.push({
                        id: tweetId,
                        text: text,
                        author: author,
                        keyword: searchKeyword,
                        timestamp: timestamp || new Date().toISOString(),
                        isRecent: isRecent,
                        scrapedAt: new Date().toISOString(),
                        url: tweetId.startsWith('gen_') ? null : `https://twitter.com/i/status/${tweetId}`,
                        metrics: {
                            replies: replyCount,
                            likes: likeCount
                        }
                    });
                }
            });
            
            return tweets;
        }, { searchKeyword: this.lastKeyword });
    }
    
    async scrapeTweets(keyword, maxTweets = 20) {
        const startTime = Date.now();
        
        try {
            const cached = this.tweetCache.get(keyword, maxTweets);
            if (cached) {
                console.log(`📦 Cache hit for "${keyword}"`);
                return cached;
            }
            
            await this.enforceRateLimit();
            
            if (!(await this.checkBrowserHealth())) {
                console.warn('⚠️ Browser unhealthy, restarting...');
                await this.safeBrowserRestart();
            }
            
            await this.prepareNewSearch();
            
            this.lastKeyword = keyword;
            console.log(`🔍 Searching: "${keyword}"`);
            
            const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
            
            let searchSuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.page.goto(searchUrl, {
                        waitUntil: 'networkidle',
                        timeout: 25000
                    });
                    
                    await this.intelligentDelay(4000, 7000);
                    
                    const searchLoaded = await this.page.evaluate(() => {
                        return document.querySelector('main') !== null ||
                               document.querySelector('[data-testid="primaryColumn"]') !== null;
                    });
                    
                    if (searchLoaded) {
                        searchSuccess = true;
                        break;
                    }
                } catch (error) {
                    console.log(`   Search attempt ${attempt} failed: ${error.message}`);
                }
                
                if (attempt < 3) {
                    await this.intelligentDelay(3000, 6000);
                }
            }
            
            if (!searchSuccess) {
                throw new Error('Search page failed to load');
            }
            
            console.log('📜 Collecting tweets...');
            const allTweets = [];
            let scrollAttempts = 0;
            const maxScrolls = 10;
            
            while (allTweets.length < maxTweets * 1.5 && scrollAttempts < maxScrolls) {
                scrollAttempts++;
                
                const batchTweets = await this.extractTweetData();
                const uniqueBatch = batchTweets.filter(tweet => 
                    !allTweets.some(existing => existing.id === tweet.id)
                );
                
                allTweets.push(...uniqueBatch);
                
                console.log(`   Scroll ${scrollAttempts}: ${uniqueBatch.length} new, ${allTweets.length} total`);
                
                if (allTweets.length < maxTweets && scrollAttempts < maxScrolls) {
                    await this.page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight * 2);
                    });
                    
                    await this.intelligentDelay(1500, 3500);
                }
            }
            
            const deduplicatedTweets = [];
            const addedIds = new Set();
            
            for (const tweet of allTweets) {
                if (this.deduplicator.isDuplicate(tweet)) continue;
                if (addedIds.has(tweet.id)) continue;
                
                this.deduplicator.addTweet(tweet);
                addedIds.add(tweet.id);
                deduplicatedTweets.push(tweet);
            }
            
            const sortedTweets = deduplicatedTweets.sort((a, b) => {
                if (a.isRecent && !b.isRecent) return -1;
                if (!a.isRecent && b.isRecent) return 1;
                
                const aEngagement = a.metrics.likes + a.metrics.replies;
                const bEngagement = b.metrics.likes + b.metrics.replies;
                if (aEngagement !== bEngagement) return bEngagement - aEngagement;
                
                if (a.timestamp && b.timestamp) {
                    return new Date(b.timestamp) - new Date(a.timestamp);
                }
                
                return 0;
            });
            
            const finalTweets = sortedTweets.slice(0, maxTweets);
            
            if (finalTweets.length > 0) {
                this.consecutiveErrors = 0;
                this.adaptiveDelay = Math.max(
                    this.baseDelay,
                    this.adaptiveDelay * 0.9
                );
                this.successfulScrapes++;
            } else {
                this.consecutiveErrors++;
                this.adaptiveDelay = Math.min(
                    this.maxDelay,
                    this.adaptiveDelay * (1 + this.consecutiveErrors * 0.2)
                );
            }
            
            const recentCount = finalTweets.filter(t => t.isRecent).length;
            const elapsed = Date.now() - startTime;
            
            console.log(`✅ Found ${finalTweets.length} tweets for "${keyword}" ` +
                       `(${recentCount} recent, ${elapsed}ms)`);
            
            if (finalTweets.length > 0) {
                this.tweetCache.set(keyword, maxTweets, finalTweets);
            }
            
            this.scrapeHistory.push({
                keyword,
                count: finalTweets.length,
                timestamp: Date.now(),
                duration: elapsed,
                success: true
            });
            
            if (this.scrapeHistory.length > this.maxHistorySize) {
                this.scrapeHistory = this.scrapeHistory.slice(-this.maxHistorySize);
            }
            
            return finalTweets;
            
        } catch (error) {
            console.error(`❌ Scrape failed for "${keyword}":`, error.message);
            
            this.errorCount++;
            this.consecutiveErrors++;
            this.adaptiveDelay = Math.min(
                this.maxDelay,
                this.adaptiveDelay * (1 + this.consecutiveErrors * 0.3)
            );
            
            this.scrapeHistory.push({
                keyword,
                error: error.message,
                timestamp: Date.now(),
                success: false
            });
            
            throw error;
        }
    }
    
    async disconnect() {
        try {
            const disconnectPromises = [];
            
            if (this.page) {
                disconnectPromises.push(this.page.close().catch(() => {}));
                this.page = null;
            }
            
            if (this.context) {
                disconnectPromises.push(this.context.close().catch(() => {}));
                this.context = null;
            }
            
            if (this.browser) {
                disconnectPromises.push(this.browser.close().catch(() => {}));
                this.browser = null;
            }
            
            await Promise.all(disconnectPromises);
            
            this.isConnected = false;
            console.log('🔌 Clean disconnect completed');
            
        } catch (error) {
            console.error('❌ Disconnect error:', error.message);
        }
    }
    
    getStats() {
        const totalScrapes = this.successfulScrapes + this.errorCount;
        const successRate = totalScrapes > 0 ? 
            Math.round((this.successfulScrapes / totalScrapes) * 100) : 0;
        
        return {
            status: this.isConnected ? 'connected' : 'disconnected',
            successfulScrapes: this.successfulScrapes,
            errorCount: this.errorCount,
            successRate: `${successRate}%`,
            consecutiveErrors: this.consecutiveErrors,
            adaptiveDelay: Math.round(this.adaptiveDelay / 1000),
            lastKeyword: this.lastKeyword,
            queueStatus: this.requestQueue.getStatus(),
            dedupStats: this.deduplicator.getStats(),
            cacheStats: this.tweetCache.getStats(),
            browserRestarts: this.browserRestarts,
            historySize: this.scrapeHistory.length,
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
                heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
            }
        };
    }
}

// ==================== EXPRESS SERVER ====================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(o => o);
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (allowedOrigins.includes('*') && !isProduction) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

const PORT = process.env.PORT || 3003;
const scraper = new ApiScraper();

// Rate limiting
const requestTimestamps = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 30;

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!requestTimestamps.has(ip)) {
        requestTimestamps.set(ip, []);
    }
    
    const timestamps = requestTimestamps.get(ip);
    const windowStart = now - RATE_LIMIT_WINDOW;
    
    while (timestamps.length > 0 && timestamps[0] < windowStart) {
        timestamps.shift();
    }
    
    if (timestamps.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW - now) / 1000),
            limit: RATE_LIMIT_MAX,
            window: RATE_LIMIT_WINDOW / 1000 + 's'
        });
    }
    
    timestamps.push(now);
    
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', RATE_LIMIT_MAX - timestamps.length);
    res.setHeader('X-RateLimit-Reset', Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW) / 1000));
    
    next();
});

// API Key Authentication Middleware
const apiKeyAuth = (req, res, next) => {
    if (!process.env.API_KEY) {
        console.warn('⚠️ WARNING: No API_KEY configured');
        return next();
    }
    
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'API key required',
            message: 'Include x-api-key header or api_key query parameter'
        });
    }
    
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({
            success: false,
            error: 'Invalid API key'
        });
    }
    
    next();
};

// Routes
app.post('/scrape', apiKeyAuth, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { keyword, limit, priority } = req.body;
        
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Valid keyword string is required',
                example: { keyword: 'technology', limit: 20, priority: 0 }
            });
        }
        
        const tweetLimit = Math.min(limit || scraper.scrapeLimit, 100);
        const trimmedKeyword = keyword.trim().substring(0, 100);
        const requestPriority = parseInt(priority) || 0;
        
        console.log(`📥 API Request: "${trimmedKeyword}" (limit: ${tweetLimit}, priority: ${requestPriority})`);
        
        const tweets = await scraper.requestQueue.add(
            () => scraper.scrapeTweets(trimmedKeyword, tweetLimit),
            requestPriority
        );
        
        const responseTime = Date.now() - startTime;
        
        res.json({
            success: true,
            request: {
                keyword: trimmedKeyword,
                limit: tweetLimit,
                requested_at: new Date(startTime).toISOString()
            },
            performance: {
                response_time_ms: responseTime,
                adaptive_delay_ms: scraper.adaptiveDelay
            },
            results: {
                count: tweets.length,
                recent_tweets: tweets.filter(t => t.isRecent).length,
                duplicate_filtered: scraper.deduplicator.getStats().hits
            },
            tweets: tweets.map(t => ({
                id: t.id,
                text: t.text,
                author: t.author,
                timestamp: t.timestamp,
                is_recent: t.isRecent,
                url: t.url,
                metrics: t.metrics,
                length: t.text.length,
                scraped_at: t.scrapedAt
            }))
        });
        
    } catch (error) {
        console.error('❌ API Error:', error.message);
        
        const statusCode = error.message.includes('Rate limit') ? 429 : 
                          error.message.includes('Queue') ? 503 : 500;
        
        res.status(statusCode).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            stats: scraper.getStats(),
            suggestion: statusCode === 429 ? 'Wait before retrying' :
                       statusCode === 503 ? 'Server busy, try later' :
                       'Check server logs'
        });
    }
});

app.get('/health', (req, res) => {
    const stats = scraper.getStats();
    const memory = process.memoryUsage();
    
    res.json({
        status: scraper.isConnected ? 'healthy' : 'disconnected',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        ssl: {
            enabled: sslEnabled,
            mode: sslEnabled ? 'HTTPS' : 'HTTP',
            certificates: sslEnabled ? 'valid' : 'not configured'
        },
        memory: {
            rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
            heap: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
            external: Math.round(memory.external / 1024 / 1024) + 'MB'
        },
        scraper: stats,
        system: {
            node: process.version,
            platform: process.platform,
            arch: process.arch
        },
        security_status: !sslEnabled && isProduction ? 'HIGH RISK - SSL not enabled' : 'OK'
    });
});

app.get('/stats', (req, res) => {
    res.json({
        ...scraper.getStats(),
        history: scraper.scrapeHistory.slice(-20),
        keywords: scraper.keywords,
        limits: {
            max_tweets_per_request: scraper.scrapeLimit,
            min_delay_seconds: Math.round(scraper.baseDelay / 1000),
            max_delay_seconds: Math.round(scraper.maxDelay / 1000),
            rate_limit: `${RATE_LIMIT_MAX} requests per minute`
        },
        ssl: {
            enabled: sslEnabled,
            key_path: process.env.SSL_KEY_PATH || 'Not set',
            cert_path: process.env.SSL_CERT_PATH || 'Not set'
        }
    });
});

app.post('/cache/clear', (req, res) => {
    scraper.tweetCache.clear();
    res.json({
        success: true,
        message: 'Cache cleared',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    const stats = scraper.getStats();
    const sslStatus = sslEnabled ? '✅ HTTPS Enabled' : '⚠️ HTTP (No SSL)';
    const securityAlert = !sslEnabled && isProduction ? 
        '<div style="background:#f8d7da;color:#721c24;padding:10px;border-radius:5px;margin:10px 0;">🚨 SECURITY WARNING: Running production without SSL - HIGH BAN RISK!</div>' : '';
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Twitter Scraper v4.1 - SSL Secure</title>
    <style>
        body { font-family: sans-serif; padding: 20px; background: #f5f8fa; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .status { display: inline-block; padding: 5px 15px; border-radius: 20px; font-weight: bold; }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
        .ssl-enabled { background: #d1ecf1; color: #0c5460; }
        .ssl-disabled { background: #fff3cd; color: #856404; }
        .dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin: 20px 0; }
        .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .metric { font-size: 2em; font-weight: bold; margin: 10px 0; }
        .controls { background: white; padding: 20px; border-radius: 10px; margin: 20px 0; }
        input, button, select { padding: 10px; margin: 5px; border: 1px solid #ddd; border-radius: 5px; }
        button { background: #1da1f2; color: white; border: none; cursor: pointer; }
        button:hover { background: #0d8bdc; }
        .tweet { border-left: 3px solid #1da1f2; padding: 10px; margin: 10px 0; background: #f8f9fa; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🐦 Twitter Scraper v4.1</h1>
            <p>SSL Secure Edition • Anti-Ban Protection</p>
            ${securityAlert}
            <div style="margin: 10px 0;">
                <span class="status ${stats.status === 'connected' ? 'connected' : 'disconnected'}">
                    ${stats.status.toUpperCase()}
                </span>
                <span class="status ${sslEnabled ? 'ssl-enabled' : 'ssl-disabled'}" style="margin-left: 10px;">
                    ${sslStatus}
                </span>
            </div>
        </div>
        
        <div class="dashboard">
            <div class="card">
                <div>Connection Status</div>
                <div class="metric">${stats.status === 'connected' ? '✅' : '❌'}</div>
                <div>Uptime: ${Math.round(process.uptime())}s</div>
                <div>Browser Restarts: ${stats.browserRestarts}</div>
            </div>
            
            <div class="card">
                <div>Performance</div>
                <div class="metric">${stats.successRate}</div>
                <div>Success Rate</div>
                <div>Successful: ${stats.successfulScrapes}</div>
                <div>Errors: ${stats.errorCount}</div>
            </div>
            
            <div class="card">
                <div>Deduplication</div>
                <div class="metric">${stats.dedupStats.hitRate}</div>
                <div>Duplicate Hit Rate</div>
                <div>Unique IDs: ${stats.dedupStats.uniqueIds}</div>
            </div>
            
            <div class="card">
                <div>Queue</div>
                <div class="metric">${stats.queueStatus.queueLength}</div>
                <div>Queued Requests</div>
                <div>Processed: ${stats.queueStatus.totalProcessed}</div>
            </div>
        </div>
        
        <div class="controls">
            <h3>🔍 Test Scraper</h3>
            <input type="text" id="keyword" value="${scraper.keywords[0] || 'technology'}" placeholder="Enter keyword">
            <select id="limit">
                <option value="5">5 tweets</option>
                <option value="10">10 tweets</option>
                <option value="20" selected>20 tweets</option>
            </select>
            <button onclick="testScrape()">Test Scrape</button>
            <div id="result" style="margin-top: 20px;"></div>
        </div>
        
        <div class="card">
            <h3>SSL Status</h3>
            <p><strong>Mode:</strong> ${sslEnabled ? 'HTTPS (Secure)' : 'HTTP (Insecure)'}</p>
            <p><strong>Certificates:</strong> ${sslEnabled ? '✅ Configured' : '❌ Not configured'}</p>
            ${!sslEnabled ? '<p><em>⚠️ For production, generate SSL certificates with: npm run ssl</em></p>' : ''}
        </div>
    </div>
    
    <script>
        async function testScrape() {
            const keyword = document.getElementById('keyword').value;
            const limit = document.getElementById('limit').value;
            const resultDiv = document.getElementById('result');
            
            resultDiv.innerHTML = '<p>⏳ Scraping... This may take 30-60 seconds.</p>';
            
            try {
                const response = await fetch('/scrape', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword, limit: parseInt(limit) })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    let html = '<div style="background:#d4edda;padding:15px;border-radius:5px;">';
                    html += '<h4>✅ Scrape Successful!</h4>';
                    html += '<p><strong>Keyword:</strong> ' + data.request.keyword + '</p>';
                    html += '<p><strong>Tweets Found:</strong> ' + data.results.count + '</p>';
                    html += '<p><strong>Response Time:</strong> ' + data.performance.response_time_ms + 'ms</p>';
                    
                    if (data.tweets && data.tweets.length > 0) {
                        html += '<h5>Sample Tweets:</h5>';
                        data.tweets.slice(0, 2).forEach(tweet => {
                            html += '<div class="tweet">';
                            html += '<p>' + tweet.text.substring(0, 100) + '...</p>';
                            html += '<small>👤 ' + (tweet.author || 'Unknown') + ' • ⏰ ' + (tweet.is_recent ? 'Recent' : 'Older') + '</small>';
                            html += '</div>';
                        });
                    }
                    
                    html += '</div>';
                    resultDiv.innerHTML = html;
                } else {
                    resultDiv.innerHTML = '<div style="background:#f8d7da;padding:15px;border-radius:5px;">' +
                        '<h4>❌ Error</h4><p>' + data.error + '</p></div>';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div style="background:#f8d7da;padding:15px;border-radius:5px;">' +
                    '<h4>❌ Request Failed</h4><p>' + error.message + '</p></div>';
            }
        }
    </script>
</body>
</html>`);
});

// ==================== SERVER STARTUP ====================
async function startServer() {
    try {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║      TWITTER SCRAPER v4.1 - SSL SECURE EDITION          ║
╚══════════════════════════════════════════════════════════╝`);
        
        // Connect to Twitter
        console.log('🚀 Connecting to Twitter...');
        await scraper.connect();
        
        // SSL Configuration
        let server;
        if (sslEnabled) {
            try {
                const sslOptions = {
                    key: fs.readFileSync(path.resolve(process.env.SSL_KEY_PATH)),
                    cert: fs.readFileSync(path.resolve(process.env.SSL_CERT_PATH))
                };
                
                server = https.createServer(sslOptions, app);
                console.log('🔒 HTTPS server with SSL enabled');
            } catch (sslError) {
                console.error('❌ SSL setup failed:', sslError.message);
                console.log('⚠️ Falling back to HTTP');
                server = http.createServer(app);
            }
        } else {
            server = http.createServer(app);
            console.warn('⚠️ HTTP server - SSL not configured');
            if (isProduction) {
                console.error('❌ CRITICAL: Running production without SSL!');
                console.error('   Twitter will detect and ban your account!');
                console.error('   Generate SSL certificates with: npm run ssl');
            }
        }
        
        server.listen(PORT, () => {
            console.log(`
✅ SERVER STARTED
   Port: ${PORT}
   Mode: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}
   SSL: ${sslEnabled ? '✅ ENABLED (HTTPS)' : '❌ DISABLED (HTTP)'}
   
📊 CONFIGURATION
   Keywords: ${scraper.keywords.join(', ')}
   Scrape Limit: ${scraper.scrapeLimit} tweets
   Min Delay: ${scraper.baseDelay / 1000}s
   Rate Limit: ${RATE_LIMIT_MAX}/min
   
🔗 ENDPOINTS
   Web UI: ${sslEnabled ? 'https' : 'http'}://localhost:${PORT}/
   API: ${sslEnabled ? 'https' : 'http'}://localhost:${PORT}/scrape
   Health: ${sslEnabled ? 'https' : 'http'}://localhost:${PORT}/health
   
🛡️ SECURITY STATUS
   SSL: ${sslEnabled ? '✅ Secure' : '❌ UNSECURE - BAN RISK'}
   Browser SSL: ✅ Enabled (ignoreHTTPSErrors: false)
   
💡 TIPS
   • For production: npm run ssl
   • Monitor /health for system status
   • Check logs/ directory for detailed logs
            `);
        });
        
        // Periodic maintenance
        setInterval(() => {
            scraper.deduplicator._cleanupOldEntries();
            
            const memory = process.memoryUsage();
            if (memory.heapUsed > 400 * 1024 * 1024) {
                console.warn('⚠️ High memory usage:', Math.round(memory.heapUsed / 1024 / 1024) + 'MB');
                scraper.tweetCache.clear();
            }
        }, 60000);
        
    } catch (error) {
        console.error('❌ Startup failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    
    try {
        await scraper.disconnect();
        console.log('✅ Clean shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
    console.error('⚠️ Uncaught Exception:', error);
    
    const errorLog = `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n\n`;
    fs.appendFileSync('logs/errors.log', errorLog);
    
    console.log('Attempting recovery...');
    try {
        await scraper.disconnect();
        await new Promise(resolve => setTimeout(resolve, 10000));
        await startServer();
        console.log('✅ Recovery successful');
    } catch (recoveryError) {
        console.error('❌ Recovery failed:', recoveryError);
        process.exit(1);
    }
});

// Start the server
startServer();

module.exports = { ApiScraper, DeduplicationManager, TweetCache };