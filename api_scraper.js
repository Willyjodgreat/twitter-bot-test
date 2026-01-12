// twitter_vps_scraper.js
// Professional X/Twitter Scraper - VPS Optimized Edition v6.0
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// ==================== VPS OPTIMIZATION ====================
const HOST = '0.0.0.0';  // Listen on all interfaces
const PORT = process.env.PORT || 3003;
const VPS_MODE = true;   // Always optimized for VPS

// ==================== ANTI-DETECTION CONFIGURATION ====================
const BROWSER_CONFIG = {
    headless: 'new',  // New headless mode for better compatibility[citation:1]
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-web-security=false',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--disable-popup-blocking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        `--user-agent=${process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`
    ]
};

// ==================== VPS SCRAPER CLASS ====================
class VpsTwitterScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        
        // VPS Optimized Settings
        this.maxConcurrentPages = 3;  // Limit for memory management
        this.activePages = new Set();
        this.pageCleanupInterval = null;
        this.scrapeHistory = [];
        this.errorCount = 0;
        this.successCount = 0;
        
        // Rate limiting
        this.baseDelay = parseInt(process.env.MIN_DELAY_MS) || 30000;
        this.maxDelay = parseInt(process.env.MAX_DELAY_MS) || 120000;
        this.lastRequestTime = 0;
        
        // Memory tracking
        this.maxHistorySize = 100;
        
        // Setup
        this.validateEnvironment();
        this.setupLogging();
    }
    
    validateEnvironment() {
        if (!fs.existsSync(this.sessionFile)) {
            console.warn('⚠️ No session file found. Some features may require login.');
            console.log('  To create session: node get_session.js');
        }
    }
    
    setupLogging() {
        const logDir = 'logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFile = path.join(logDir, `scraper_${new Date().toISOString().split('T')[0]}.log`);
        this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
        
        console.log = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            
            const timestamp = new Date().toISOString();
            this.logStream.write(`[${timestamp}] INFO: ${message}\n`);
            process.stdout.write(`[${timestamp}] ${args.join(' ')}\n`);
        };
        
        console.error = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            
            const timestamp = new Date().toISOString();
            this.logStream.write(`[${timestamp}] ERROR: ${message}\n`);
            process.stderr.write(`[${timestamp}] ${args.join(' ')}\n`);
        };
    }
    
    async connect() {
        try {
            console.log('🚀 Initializing VPS-optimized browser...');
            
            this.browser = await chromium.launch(BROWSER_CONFIG);
            
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: false,
                javaScriptEnabled: true,
                locale: 'en-US'
            });
            
            // Load session if exists
            if (fs.existsSync(this.sessionFile)) {
                try {
                    const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
                    await this.context.addCookies(session.cookies);
                    console.log(`✅ Loaded ${session.cookies.length} cookies`);
                } catch (error) {
                    console.warn('⚠️ Could not load session:', error.message);
                }
            }
            
            this.isConnected = true;
            console.log('🎉 VPS Scraper connected successfully');
            
            // Start periodic cleanup
            this.startCleanupInterval();
            
            return true;
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            await this.cleanupResources();
            throw error;
        }
    }
    
    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        
        if (this.lastRequestTime > 0 && timeSinceLast < this.baseDelay) {
            const waitTime = this.baseDelay - timeSinceLast;
            console.log(`🚦 Rate limit: Waiting ${Math.round(waitTime/1000)}s`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
    }
    
    async createScrapePage() {
        if (this.activePages.size >= this.maxConcurrentPages) {
            throw new Error('Too many active pages. Wait for cleanup.');
        }
        
        const page = await this.context.newPage();
        this.activePages.add(page);
        
        // Configure page for VPS
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(30000);
        
        // Set random viewport to avoid detection
        await page.setViewportSize({
            width: 1100 + Math.floor(Math.random() * 200),
            height: 600 + Math.floor(Math.random() * 200)
        });
        
        return page;
    }
    
    async closePage(page) {
        try {
            await page.close();
            this.activePages.delete(page);
        } catch (error) {
            console.warn('Page close warning:', error.message);
        }
    }
    
    // ==================== MODERN X/TWITTER SELECTORS ====================
    // Using data-testid attributes which are more stable than class names[citation:1][citation:6]
    
    async scrapeProfile(username) {
        const startTime = Date.now();
        let page = null;
        
        try {
            await this.enforceRateLimit();
            
            console.log(`🔍 Scraping profile: @${username}`);
            page = await this.createScrapePage();
            
            const profileUrl = `https://x.com/${username}`;
            await page.goto(profileUrl, {
                waitUntil: 'networkidle',
                timeout: 15000
            });
            
            // Wait for key profile elements[citation:1]
            await page.waitForSelector('[data-testid="UserName"]', { timeout: 10000 });
            
            const profileData = await page.evaluate(() => {
                // Modern X.com selectors using data-testid[citation:1]
                const selectors = {
                    name: '[data-testid="UserName"] div span',
                    username: '[data-testid="UserName"] div:nth-of-type(2) span',
                    bio: '[data-testid="UserDescription"]',
                    followers: 'a[href$="/followers"] span',
                    following: 'a[href$="/following"] span',
                    joinDate: '[data-testid="UserJoinDate"] span',
                    website: 'a[data-testid="UserUrl"]',
                    location: '[data-testid="UserLocation"]'
                };
                
                const getText = (selector) => {
                    const element = document.querySelector(selector);
                    return element ? element.textContent.trim() : null;
                };
                
                return {
                    name: getText(selectors.name),
                    username: getText(selectors.username),
                    bio: getText(selectors.bio),
                    followers: getText(selectors.followers),
                    following: getText(selectors.following),
                    joinDate: getText(selectors.joinDate),
                    website: getText(selectors.website),
                    location: getText(selectors.location),
                    scrapedAt: new Date().toISOString(),
                    url: window.location.href
                };
            });
            
            await this.closePage(page);
            
            const elapsed = Date.now() - startTime;
            console.log(`✅ Profile scraped in ${elapsed}ms`);
            this.successCount++;
            
            this.scrapeHistory.push({
                type: 'profile',
                username,
                timestamp: Date.now(),
                duration: elapsed,
                success: true
            });
            
            return profileData;
            
        } catch (error) {
            console.error(`❌ Profile scrape failed for @${username}:`, error.message);
            
            if (page) await this.closePage(page);
            
            this.errorCount++;
            this.scrapeHistory.push({
                type: 'profile',
                username,
                error: error.message,
                timestamp: Date.now(),
                success: false
            });
            
            throw error;
        }
    }
    
    async scrapeTweets(keyword, limit = 10) {
        const startTime = Date.now();
        let page = null;
        
        try {
            await this.enforceRateLimit();
            
            console.log(`🔍 Searching for: "${keyword}"`);
            page = await this.createScrapePage();
            
            const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 15000
            });
            
            // Wait for tweet articles[citation:1]
            await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
            
            // Scroll to load more tweets
            await this.scrollPage(page, 2);
            
            const tweets = await page.evaluate((maxLimit) => {
                const tweetElements = document.querySelectorAll('article[data-testid="tweet"]');
                const tweets = [];
                
                tweetElements.forEach((article, index) => {
                    if (index >= maxLimit) return;
                    
                    try {
                        // Extract using stable selectors[citation:1][citation:6]
                        const textElem = article.querySelector('[data-testid="tweetText"]');
                        const authorElem = article.querySelector('[data-testid="User-Name"]');
                        const timeElem = article.querySelector('time');
                        const metrics = {
                            replies: article.querySelector('[data-testid="reply"]')?.textContent || '0',
                            retweets: article.querySelector('[data-testid="retweet"]')?.textContent || '0',
                            likes: article.querySelector('[data-testid="like"]')?.textContent || '0'
                        };
                        
                        // Extract tweet ID from links
                        let tweetId = null;
                        const tweetLink = article.querySelector('a[href*="/status/"]');
                        if (tweetLink) {
                            const match = tweetLink.getAttribute('href').match(/\/status\/(\d+)/);
                            tweetId = match ? match[1] : null;
                        }
                        
                        if (textElem && authorElem) {
                            tweets.push({
                                id: tweetId || `tweet_${Date.now()}_${index}`,
                                text: textElem.textContent.substring(0, 280),
                                author: authorElem.textContent.split('·')[0].trim(),
                                timestamp: timeElem ? timeElem.getAttribute('datetime') : new Date().toISOString(),
                                metrics,
                                url: tweetId ? `https://x.com/i/status/${tweetId}` : null,
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    } catch (e) {
                        // Skip malformed tweets
                    }
                });
                
                return tweets;
            }, limit);
            
            await this.closePage(page);
            
            const elapsed = Date.now() - startTime;
            console.log(`✅ Found ${tweets.length} tweets in ${elapsed}ms`);
            this.successCount++;
            
            this.scrapeHistory.push({
                type: 'search',
                keyword,
                count: tweets.length,
                timestamp: Date.now(),
                duration: elapsed,
                success: true
            });
            
            return tweets;
            
        } catch (error) {
            console.error(`❌ Search failed for "${keyword}":`, error.message);
            
            if (page) await this.closePage(page);
            
            this.errorCount++;
            this.scrapeHistory.push({
                type: 'search',
                keyword,
                error: error.message,
                timestamp: Date.now(),
                success: false
            });
            
            throw error;
        }
    }
    
    async scrollPage(page, count) {
        for (let i = 0; i < count; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 1.5);
            });
            await page.waitForTimeout(2000 + Math.random() * 1000); // Random delay
        }
    }
    
    // ==================== RESOURCE MANAGEMENT ====================
    
    startCleanupInterval() {
        this.pageCleanupInterval = setInterval(() => {
            this.cleanupOldResources();
        }, 60000); // Cleanup every minute
    }
    
    cleanupOldResources() {
        // Clean up old history
        if (this.scrapeHistory.length > this.maxHistorySize) {
            this.scrapeHistory = this.scrapeHistory.slice(-this.maxHistorySize);
        }
        
        // Check memory usage
        const memory = process.memoryUsage();
        if (memory.heapUsed > 300 * 1024 * 1024) { // 300MB threshold
            console.warn(`⚠️ High memory usage: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
                console.log('🧹 Forced garbage collection');
            }
        }
        
        // Log cleanup stats
        console.log(`📊 Cleanup: ${this.activePages.size} active pages, ${this.scrapeHistory.length} history entries`);
    }
    
    async cleanupResources() {
        console.log('🧹 Cleaning up resources...');
        
        // Close all active pages
        const closePromises = Array.from(this.activePages).map(page => 
            page.close().catch(() => {})
        );
        await Promise.all(closePromises);
        this.activePages.clear();
        
        // Clear interval
        if (this.pageCleanupInterval) {
            clearInterval(this.pageCleanupInterval);
            this.pageCleanupInterval = null;
        }
        
        // Close browser context
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
        }
        
        // Close browser
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
        
        this.isConnected = false;
        console.log('✅ Resource cleanup completed');
    }
    
    getStats() {
        const totalScrapes = this.successCount + this.errorCount;
        const successRate = totalScrapes > 0 ? 
            Math.round((this.successCount / totalScrapes) * 100) : 0;
        
        return {
            status: this.isConnected ? 'connected' : 'disconnected',
            successCount: this.successCount,
            errorCount: this.errorCount,
            successRate: `${successRate}%`,
            activePages: this.activePages.size,
            historySize: this.scrapeHistory.length,
            lastRequestTime: this.lastRequestTime ? new Date(this.lastRequestTime).toISOString() : null,
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
                heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
            }
        };
    }
}

// ==================== EXPRESS API SERVER ====================
const app = express();
app.use(express.json());

// Initialize scraper
const scraper = new VpsTwitterScraper();

// Middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    console.log(`📥 ${req.method} ${req.path} from ${req.ip}`);
    next();
});

// Simple API key check (optional)
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/') {
        return next();
    }
    
    if (API_KEY) {
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        if (!apiKey || apiKey !== API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
    }
    next();
});

// Routes
app.get('/', (req, res) => {
    const stats = scraper.getStats();
    res.json({
        name: 'VPS Twitter Scraper v6.0',
        status: 'running',
        stats,
        endpoints: {
            '/health': 'System health',
            '/stats': 'Scraper statistics',
            '/scrape/profile/:username': 'Scrape user profile',
            '/scrape/search': 'POST {keyword, limit}'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        scraper: scraper.getStats(),
        system: {
            hostname: os.hostname(),
            platform: os.platform(),
            memory: `${Math.round(os.freemem() / 1024 / 1024)}MB free`,
            uptime: process.uptime()
        }
    });
});

app.get('/stats', (req, res) => {
    res.json(scraper.getStats());
});

app.get('/scrape/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const profile = await scraper.scrapeProfile(username);
        res.json({ success: true, profile });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/scrape/search', async (req, res) => {
    try {
        const { keyword, limit = 10 } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ error: 'Keyword is required' });
        }
        
        const validLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
        const tweets = await scraper.scrapeTweets(keyword, validLimit);
        
        res.json({
            success: true,
            keyword,
            count: tweets.length,
            tweets
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== SERVER STARTUP ====================
async function startServer() {
    try {
        console.log(`
╔══════════════════════════════════════════════════╗
║      VPS TWITTER SCRAPER v6.0                  ║
║      Listening on ${HOST}:${PORT}                ║
╚══════════════════════════════════════════════════╝`);
        
        // Connect scraper
        await scraper.connect();
        
        // Start server
        const server = app.listen(PORT, HOST, () => {
            console.log(`
✅ SERVER STARTED
   URL: http://${HOST}:${PORT}
   
📋 ENDPOINTS
   GET  /                     - API documentation
   GET  /health               - System health check
   GET  /stats                - Scraper statistics
   GET  /scrape/profile/:user - Scrape user profile
   POST /scrape/search        - Search tweets
   
⚡ VPS OPTIMIZED
   • Headless browser with anti-detection
   • Memory management with cleanup
   • Rate limiting built-in
   • Modern X.com selectors
   
💡 QUICK TEST
   curl http://${HOST}:${PORT}/scrape/profile/elonmusk
            `);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down gracefully...');
            await scraper.cleanupResources();
            server.close(() => {
                console.log('✅ Server stopped');
                process.exit(0);
            });
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🔚 Termination signal received...');
            await scraper.cleanupResources();
            server.close(() => {
                process.exit(0);
            });
        });
        
    } catch (error) {
        console.error('❌ Startup failed:', error);
        process.exit(1);
    }
}

// ==================== DEPLOYMENT SCRIPT ====================
/*
// package.json dependencies:
{
  "name": "twitter-vps-scraper",
  "version": "6.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "playwright": "^1.40.0",
    "dotenv": "^16.0.0"
  },
  "scripts": {
    "start": "node twitter_vps_scraper.js",
    "setup": "npx playwright install chromium",
    "get-session": "node get_session.js"
  }
}

// get_session.js (optional - for authenticated scraping):
const { chromium } = require('playwright');
const fs = require('fs');

async function getSession() {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto('https://x.com/login');
    console.log('⚠️  Please log in manually in the browser window...');
    
    // Wait for login to complete
    await page.waitForURL('https://x.com/home', { timeout: 120000 });
    
    const cookies = await context.cookies();
    fs.writeFileSync('twitter_session.json', JSON.stringify({ cookies }, null, 2));
    
    console.log(`✅ Saved ${cookies.length} cookies to twitter_session.json`);
    await browser.close();
}

getSession().catch(console.error);
*/

// Start the server
startServer();

module.exports = { VpsTwitterScraper };
