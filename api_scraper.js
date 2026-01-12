// twitter_scraper_pro.js - Professional Twitter Scraper
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// Use stealth plugin
chromium.use(stealth);

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const CONFIG = {
    PORT: process.env.PORT || 3003,
    API_KEY: process.env.API_KEY || 'Willyjodgreat',
    SESSION_FILE: 'twitter_session.json',
    LOG_FILE: 'scraper.log',
    MAX_TWEETS: 20,
    REQUEST_TIMEOUT: 45000,
    RETRY_ATTEMPTS: 3,
    DELAY_BETWEEN_REQUESTS: 30000 // 30 seconds
};

// ==================== LOGGER ====================
class Logger {
    constructor() {
        this.logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.logStream = fs.createWriteStream(
            path.join(this.logDir, `scraper_${new Date().toISOString().split('T')[0]}.log`),
            { flags: 'a' }
        );
    }

    log(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            pid: process.pid,
            message,
            ...data
        };
        
        const logString = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        console.log(logString);
        
        if (data.error) {
            console.error(data.error);
        }
        
        this.logStream.write(JSON.stringify(logEntry) + '\n');
    }
}

const logger = new Logger();

// ==================== SESSION MANAGER ====================
class SessionManager {
    constructor() {
        this.sessionFile = CONFIG.SESSION_FILE;
    }

    async saveSession(cookies) {
        try {
            const session = {
                cookies,
                savedAt: new Date().toISOString(),
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            
            fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2));
            logger.log('info', `Session saved with ${cookies.length} cookies`);
            return true;
        } catch (error) {
            logger.log('error', 'Failed to save session', { error: error.message });
            return false;
        }
    }

    async loadSession() {
        try {
            if (!fs.existsSync(this.sessionFile)) {
                return null;
            }
            
            const data = fs.readFileSync(this.sessionFile, 'utf8');
            const session = JSON.parse(data);
            
            // Check if session is less than 24 hours old
            const savedAt = new Date(session.savedAt);
            const now = new Date();
            const hoursDiff = (now - savedAt) / (1000 * 60 * 60);
            
            if (hoursDiff > 24) {
                logger.log('warn', 'Session expired (older than 24 hours)');
                return null;
            }
            
            logger.log('info', `Loaded session with ${session.cookies.length} cookies`);
            return session;
        } catch (error) {
            logger.log('error', 'Failed to load session', { error: error.message });
            return null;
        }
    }
}

// ==================== TWITTER SCRAPER ====================
class TwitterScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.sessionManager = new SessionManager();
        this.isLoggedIn = false;
        this.lastRequestTime = 0;
        this.requestCount = 0;
    }

    async initialize() {
        try {
            logger.log('info', 'Initializing browser...');
            
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1280,720',
                    '--disable-blink-features=AutomationControlled'
                ]
            });

            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'en-US',
                timezoneId: 'America/New_York'
            });

            // Load existing session
            const session = await this.sessionManager.loadSession();
            if (session) {
                await this.context.addCookies(session.cookies);
                this.isLoggedIn = true;
                logger.log('info', 'Session loaded successfully');
            }

            logger.log('info', 'Browser initialized');
            return true;
        } catch (error) {
            logger.log('error', 'Failed to initialize browser', { error: error.message });
            throw error;
        }
    }

    async login() {
        try {
            logger.log('info', 'Starting Twitter login...');
            
            if (!this.page) {
                this.page = await this.context.newPage();
            }

            await this.page.goto('https://twitter.com/login', {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            await this.page.waitForTimeout(3000);

            // Check if we're already logged in
            const isLoggedIn = await this.page.evaluate(() => {
                return document.querySelector('a[href="/compose/tweet"]') !== null ||
                       document.querySelector('[data-testid="AppTabBar_Home_Link"]') !== null;
            });

            if (isLoggedIn) {
                logger.log('info', 'Already logged in');
                await this.saveSession();
                this.isLoggedIn = true;
                return true;
            }

            logger.log('warn', 'Manual login required');
            logger.log('info', 'Please login manually in the browser');
            
            // For now, we'll just save whatever cookies we have
            await this.saveSession();
            return false;
        } catch (error) {
            logger.log('error', 'Login failed', { error: error.message });
            throw error;
        }
    }

    async saveSession() {
        try {
            const cookies = await this.context.cookies();
            await this.sessionManager.saveSession(cookies);
            this.isLoggedIn = true;
            return true;
        } catch (error) {
            logger.log('error', 'Failed to save session', { error: error.message });
            return false;
        }
    }

    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        
        if (timeSinceLast < CONFIG.DELAY_BETWEEN_REQUESTS) {
            const waitTime = CONFIG.DELAY_BETWEEN_REQUESTS - timeSinceLast;
            logger.log('info', `Rate limiting: Waiting ${Math.round(waitTime/1000)}s`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
        this.requestCount++;
    }

    async scrapeTweets(keyword, limit = 5) {
        await this.waitForRateLimit();
        
        if (!this.isLoggedIn) {
            throw new Error('Not logged into Twitter');
        }

        let page = null;
        try {
            page = await this.context.newPage();
            
            // Add random delays to seem human
            await page.waitForTimeout(1000 + Math.random() * 2000);
            
            const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
            logger.log('info', `Scraping: ${keyword}`, { url: searchUrl });
            
            await page.goto(searchUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.REQUEST_TIMEOUT
            });

            // Wait for content to load
            await page.waitForTimeout(5000);
            
            // Scroll to load more tweets
            await this.scrollPage(page, 3);
            
            // Extract tweets
            const tweets = await this.extractTweets(page, keyword);
            
            // Filter and limit
            const filteredTweets = this.filterTweets(tweets).slice(0, limit);
            
            logger.log('info', `Found ${filteredTweets.length} tweets for "${keyword}"`);
            return filteredTweets;
            
        } catch (error) {
            logger.log('error', `Scrape failed for "${keyword}"`, { error: error.message });
            throw error;
        } finally {
            if (page) {
                await page.close();
            }
        }
    }

    async scrollPage(page, scrollCount = 3) {
        for (let i = 0; i < scrollCount; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 2);
            });
            await page.waitForTimeout(2000 + Math.random() * 3000);
        }
    }

    async extractTweets(page, keyword) {
        return await page.evaluate((kw) => {
            const tweets = [];
            const tweetElements = document.querySelectorAll('article');
            
            tweetElements.forEach((article, index) => {
                try {
                    // Get tweet text
                    const textElement = article.querySelector('[data-testid="tweetText"]') || 
                                      article.querySelector('[lang]');
                    const text = textElement ? textElement.textContent.trim() : '';
                    
                    if (!text || text.length < 10) return;
                    
                    // Get author
                    const authorElement = article.querySelector('[data-testid="User-Name"]');
                    const author = authorElement ? authorElement.textContent.split('·')[0].trim() : '';
                    
                    // Get timestamp
                    const timeElement = article.querySelector('time');
                    const timestamp = timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString();
                    
                    // Get engagement metrics
                    const getMetric = (testId) => {
                        const el = article.querySelector(`[data-testid="${testId}"]`);
                        if (!el) return 0;
                        const text = el.textContent || '';
                        const match = text.match(/(\d+(\.\d+)?[KMB]?)/);
                        if (!match) return 0;
                        
                        const num = match[1];
                        if (num.includes('K')) return parseFloat(num) * 1000;
                        if (num.includes('M')) return parseFloat(num) * 1000000;
                        if (num.includes('B')) return parseFloat(num) * 1000000000;
                        return parseFloat(num);
                    };
                    
                    const tweet = {
                        id: `tweet_${Date.now()}_${index}`,
                        text: text.substring(0, 280),
                        author: author.substring(0, 50),
                        keyword: kw,
                        timestamp: timestamp,
                        isRecent: new Date(timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000),
                        url: `https://twitter.com/i/web/status/${Date.now()}`,
                        metrics: {
                            likes: getMetric('like'),
                            retweets: getMetric('retweet'),
                            replies: getMetric('reply')
                        },
                        scrapedAt: new Date().toISOString()
                    };
                    
                    tweets.push(tweet);
                } catch (error) {
                    console.error('Error parsing tweet:', error);
                }
            });
            
            return tweets;
        }, keyword);
    }

    filterTweets(tweets) {
        // Remove duplicates based on text hash
        const seen = new Set();
        return tweets.filter(tweet => {
            const hash = crypto.createHash('md5').update(tweet.text).digest('hex');
            if (seen.has(hash)) return false;
            seen.add(hash);
            return true;
        }).sort((a, b) => {
            // Sort by recency and engagement
            if (a.isRecent && !b.isRecent) return -1;
            if (!a.isRecent && b.isRecent) return 1;
            const aEngagement = a.metrics.likes + a.metrics.retweets;
            const bEngagement = b.metrics.likes + b.metrics.retweets;
            return bEngagement - aEngagement;
        });
    }

    async close() {
        try {
            if (this.page) await this.page.close();
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
            logger.log('info', 'Browser closed');
        } catch (error) {
            logger.log('error', 'Error closing browser', { error: error.message });
        }
    }
}

// ==================== API SERVER ====================
const scraper = new TwitterScraper();

// Middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    next();
});

// API Key middleware
app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (req.path === '/health' || req.path === '/') {
        return next();
    }
    
    if (!apiKey || apiKey !== CONFIG.API_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Invalid API key',
            message: `Use x-api-key header with value: ${CONFIG.API_KEY.substring(0, 3)}...`
        });
    }
    next();
});

// Routes
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Scraper Pro v5.0</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .status { padding: 10px; border-radius: 5px; }
                .connected { background: #d4edda; }
                .disconnected { background: #f8d7da; }
            </style>
        </head>
        <body>
            <h1>🐦 Twitter Scraper Pro v5.0</h1>
            <div class="status ${scraper.isLoggedIn ? 'connected' : 'disconnected'}">
                Status: ${scraper.isLoggedIn ? '✅ Connected' : '❌ Not logged in'}
            </div>
            <p>API Key: ${CONFIG.API_KEY.substring(0, 3)}...</p>
            <p>Endpoints:</p>
            <ul>
                <li><strong>POST /scrape</strong> - Scrape tweets (requires API key)</li>
                <li><strong>GET /health</strong> - Health check</li>
                <li><strong>POST /login</strong> - Manually login</li>
                <li><strong>GET /stats</strong> - Get statistics</li>
            </ul>
        </body>
        </html>
    `);
});

app.get('/health', async (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        scraper: {
            isLoggedIn: scraper.isLoggedIn,
            requestCount: scraper.requestCount,
            isInitialized: !!scraper.browser
        },
        system: {
            uptime: process.uptime(),
            memory: process.memoryUsage()
        }
    });
});

app.post('/login', async (req, res) => {
    try {
        await scraper.login();
        res.json({
            success: true,
            message: 'Login successful',
            isLoggedIn: scraper.isLoggedIn
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/scrape', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { keyword, limit = 5 } = req.body;
        
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Valid keyword is required'
            });
        }
        
        const validLimit = Math.min(Math.max(parseInt(limit) || 5, 1), CONFIG.MAX_TWEETS);
        const trimmedKeyword = keyword.trim().substring(0, 100);
        
        logger.log('info', 'API request received', {
            keyword: trimmedKeyword,
            limit: validLimit,
            ip: req.ip
        });
        
        const tweets = await scraper.scrapeTweets(trimmedKeyword, validLimit);
        
        res.json({
            success: true,
            keyword: trimmedKeyword,
            count: tweets.length,
            processingTime: `${Date.now() - startTime}ms`,
            tweets: tweets
        });
        
    } catch (error) {
        logger.log('error', 'API error', { error: error.message });
        
        res.status(500).json({
            success: false,
            error: error.message,
            suggestion: error.message.includes('Not logged in') ? 'Run POST /login first' : 'Try again later'
        });
    }
});

app.get('/stats', (req, res) => {
    res.json({
        scraper: {
            isLoggedIn: scraper.isLoggedIn,
            requestCount: scraper.requestCount,
            lastRequestTime: scraper.lastRequestTime ? new Date(scraper.lastRequestTime).toISOString() : null
        },
        config: CONFIG
    });
});

// ==================== STARTUP ====================
async function startServer() {
    try {
        logger.log('info', 'Starting Twitter Scraper Pro v5.0...');
        
        // Initialize scraper
        await scraper.initialize();
        
        // Try to login with existing session
        if (!scraper.isLoggedIn) {
            logger.log('warn', 'No valid session found. Manual login required.');
            logger.log('info', 'Send POST /login to authenticate');
        }
        
        // Start server
        app.listen(CONFIG.PORT, '0.0.0.0', () => {
            logger.log('info', `Server started on port ${CONFIG.PORT}`);
            logger.log('info', `Dashboard: http://0.0.0.0:${CONFIG.PORT}`);
            logger.log('info', `API Key: ${CONFIG.API_KEY.substring(0, 3)}...`);
            console.log(`
╔══════════════════════════════════════════════════════════╗
║      TWITTER SCRAPER PRO v5.0 - READY                   ║
║                                                          ║
║  🔗 Dashboard: http://172.105.148.50:${CONFIG.PORT}          ║
║  🔑 API Key: ${CONFIG.API_KEY.substring(0, 3)}...                    ║
║  📝 Logs: logs/ directory                               ║
║                                                          ║
║  📋 Quick test:                                         ║
║  curl -H "x-api-key: ${CONFIG.API_KEY}" \\               ║
║       -X POST \\                                         ║
║       -H "Content-Type: application/json" \\             ║
║       -d '{"keyword":"bitcoin","limit":3}' \\           ║
║       http://172.105.148.50:${CONFIG.PORT}/scrape       ║
╚══════════════════════════════════════════════════════════╝
            `);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            logger.log('info', 'Shutting down gracefully...');
            await scraper.close();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            logger.log('info', 'Terminating...');
            await scraper.close();
            process.exit(0);
        });
        
    } catch (error) {
        logger.log('error', 'Failed to start server', { error: error.message });
        process.exit(1);
    }
}

// Install required packages first:
// npm install playwright-extra puppeteer-extra-plugin-stealth express dotenv

startServer();

module.exports = { TwitterScraper };
