// api_scraper_vps.js - VPS Optimized Twitter Scraper v5.0
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');
require('dotenv').config();

// ==================== VPS OPTIMIZED CONFIG ====================
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3003;
const HOST = '0.0.0.0'; // CRITICAL: Listen on all interfaces

// SSL Configuration
const sslEnabled = process.env.SSL_ENABLED === 'true';
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;

// ==================== VPS OPTIMIZED BROWSER SETTINGS ====================
const getBrowserArgs = () => {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        `--user-agent=${process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`,
        '--disable-software-rasterizer',
        '--disable-web-security=false',
        '--no-zygote',
        '--single-process',
        '--no-first-run',
        '--no-default-browser-check'
    ];
    
    // Memory optimization for VPS
    const totalMemory = os.totalmem();
    if (totalMemory < 2 * 1024 * 1024 * 1024) { // Less than 2GB
        args.push('--memory-pressure-off');
        args.push('--disable-background-timer-throttling');
    }
    
    return args;
};

// ==================== VPS SCRAPER CLASS ====================
class VpsScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        
        // VPS optimized settings
        this.maxRetries = 3;
        this.timeout = parseInt(process.env.BROWSER_TIMEOUT) || 60000;
        this.headless = process.env.HEADLESS !== 'false';
        
        console.log(`🖥️  VPS Configuration:`);
        console.log(`   Host: ${HOST}:${PORT}`);
        console.log(`   Headless: ${this.headless}`);
        console.log(`   Memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);
        console.log(`   Cores: ${os.cpus().length}`);
    }
    
    async connect() {
        try {
            console.log('🚀 Initializing VPS-optimized browser...');
            
            // Load session if exists
            if (!fs.existsSync(this.sessionFile)) {
                throw new Error(`Session file ${this.sessionFile} not found.`);
            }
            
            const browserArgs = getBrowserArgs();
            
            this.browser = await chromium.launch({ 
                headless: this.headless,
                args: browserArgs,
                timeout: this.timeout
            });
            
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: false,
                javaScriptEnabled: true,
                locale: 'en-US'
            });
            
            // Load cookies
            const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
            await this.context.addCookies(session.cookies);
            console.log(`✅ Loaded ${session.cookies.length} cookies`);
            
            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(this.timeout);
            
            // Verify login
            console.log('🔐 Verifying login status...');
            await this.verifyLogin();
            
            this.isConnected = true;
            console.log('🎉 VPS Scraper connected successfully');
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }
    
    async verifyLogin() {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await this.page.goto('https://twitter.com/home', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                
                await this.page.waitForTimeout(2000);
                
                const isLoggedIn = await this.page.evaluate(() => {
                    const loggedIn = document.querySelector('[data-testid="AppTabBar_Home_Link"]') !== null;
                    const loginPage = document.querySelector('input[name="session[username_or_email]"]') !== null;
                    return loggedIn && !loginPage;
                });
                
                if (isLoggedIn) {
                    console.log('✅ Login verified');
                    return true;
                }
                
                console.log(`⚠️  Login check attempt ${attempt} failed`);
                
            } catch (error) {
                console.log(`   Attempt ${attempt} error: ${error.message}`);
            }
            
            if (attempt < this.maxRetries) {
                await this.page.waitForTimeout(3000);
            }
        }
        
        throw new Error('Could not verify Twitter login');
    }
    
    async scrape(keyword, limit = 5) {
        if (!this.isConnected) {
            throw new Error('Scraper not connected');
        }
        
        const startTime = Date.now();
        console.log(`🔍 Scraping "${keyword}"...`);
        
        try {
            // Create new page for this scrape
            const page = await this.context.newPage();
            
            const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await page.waitForTimeout(5000);
            
            // Scroll to load more tweets
            await this.scrollPage(page, 2);
            
            // Extract tweets
            const tweets = await this.extractTweets(page, keyword);
            
            await page.close();
            
            const filteredTweets = this.filterTweets(tweets).slice(0, limit);
            const elapsed = Date.now() - startTime;
            
            console.log(`✅ Found ${filteredTweets.length} tweets in ${elapsed}ms`);
            return filteredTweets;
            
        } catch (error) {
            console.error(`❌ Scrape failed for "${keyword}":`, error.message);
            throw error;
        }
    }
    
    async scrollPage(page, count = 2) {
        for (let i = 0; i < count; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 1.5);
            });
            await page.waitForTimeout(2000);
        }
    }
    
    async extractTweets(page, keyword) {
        return await page.evaluate((kw) => {
            const tweets = [];
            const articles = document.querySelectorAll('article');
            
            articles.forEach((article, index) => {
                try {
                    const textElement = article.querySelector('[data-testid="tweetText"]');
                    const text = textElement ? textElement.textContent.trim() : '';
                    
                    if (text.length < 10) return;
                    
                    // Get author
                    const authorElement = article.querySelector('[data-testid="User-Name"]');
                    const author = authorElement ? authorElement.textContent.split('·')[0].trim() : '';
                    
                    // Get time
                    const timeElement = article.querySelector('time');
                    const timestamp = timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString();
                    
                    // Get engagement
                    const getMetric = (testId) => {
                        const el = article.querySelector(`[data-testid="${testId}"]`);
                        if (!el) return 0;
                        const text = el.textContent || '';
                        const match = text.match(/(\d+)/);
                        return match ? parseInt(match[1]) : 0;
                    };
                    
                    tweets.push({
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
                    });
                } catch (e) {
                    // Skip malformed tweets
                }
            });
            
            return tweets;
        }, keyword);
    }
    
    filterTweets(tweets) {
        // Remove duplicates based on text
        const seen = new Set();
        return tweets.filter(tweet => {
            const key = tweet.text.substring(0, 100).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((a, b) => {
            // Sort by recent first
            return new Date(b.timestamp) - new Date(a.timestamp);
        });
    }
    
    async cleanup() {
        try {
            if (this.page) await this.page.close();
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
            this.isConnected = false;
            console.log('🧹 Cleanup completed');
        } catch (error) {
            console.error('Cleanup error:', error.message);
        }
    }
}

// ==================== VPS OPTIMIZED SERVER ====================
const app = express();
app.use(express.json());

// CORS for VPS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.setHeader('X-Powered-By', 'Twitter-Scraper-VPS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// API Key middleware
const API_KEY = process.env.API_KEY || 'Willyjodgreat';
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/') {
        return next();
    }
    
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({
            error: 'Invalid API key',
            hint: `Use: x-api-key: ${API_KEY.substring(0, 3)}...`
        });
    }
    next();
});

// Initialize scraper
const scraper = new VpsScraper();

// Routes
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Scraper VPS v5.0</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .status { padding: 10px; border-radius: 5px; }
                .connected { background: #4CAF50; color: white; }
                .disconnected { background: #f44336; color: white; }
            </style>
        </head>
        <body>
            <h1>🐦 Twitter Scraper VPS v5.0</h1>
            <div class="status ${scraper.isConnected ? 'connected' : 'disconnected'}">
                Status: ${scraper.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}
            </div>
            <p><strong>Server:</strong> ${HOST}:${PORT}</p>
            <p><strong>API Key:</strong> ${API_KEY.substring(0, 3)}...</p>
            <p><strong>Endpoints:</strong></p>
            <ul>
                <li><code>POST /scrape</code> - Scrape tweets</li>
                <li><code>GET /health</code> - Health check</li>
            </ul>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        scraper: {
            connected: scraper.isConnected,
            host: HOST,
            port: PORT
        },
        vps: {
            hostname: os.hostname(),
            platform: os.platform(),
            memory: `${Math.round(os.freemem() / 1024 / 1024)}MB free / ${Math.round(os.totalmem() / 1024 / 1024)}MB total`,
            cpus: os.cpus().length
        }
    });
});

app.post('/scrape', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { keyword, limit = 5 } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ error: 'Keyword required' });
        }
        
        const validLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 20);
        const trimmedKeyword = keyword.trim().substring(0, 100);
        
        console.log(`📥 Request: "${trimmedKeyword}" from ${req.ip}`);
        
        const tweets = await scraper.scrape(trimmedKeyword, validLimit);
        
        res.json({
            success: true,
            keyword: trimmedKeyword,
            count: tweets.length,
            processingTime: Date.now() - startTime,
            tweets: tweets
        });
        
    } catch (error) {
        console.error('API Error:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: 'Check if scraper is connected and Twitter session is valid'
        });
    }
});

// ==================== VPS SERVER STARTUP ====================
async function startVpsServer() {
    try {
        console.log(`
╔══════════════════════════════════════════════════╗
║      TWITTER SCRAPER VPS v5.0                   ║
║        Listening on ${HOST}:${PORT}                ║
╚══════════════════════════════════════════════════╝`);
        
        // Connect scraper
        await scraper.connect();
        
        // Create server
        let server;
        if (sslEnabled && sslKeyPath && sslCertPath && fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
            const sslOptions = {
                key: fs.readFileSync(sslKeyPath),
                cert: fs.readFileSync(sslCertPath)
            };
            server = https.createServer(sslOptions, app);
            console.log('🔒 HTTPS enabled');
        } else {
            server = http.createServer(app);
            console.log('🌐 HTTP mode');
        }
        
        // Listen on ALL interfaces (0.0.0.0)
        server.listen(PORT, HOST, () => {
            const protocol = sslEnabled ? 'https' : 'http';
            console.log(`
✅ VPS SERVER RUNNING
   URL: ${protocol}://${HOST}:${PORT}
   External: ${protocol}://${getPublicIp()}:${PORT}
   
📋 QUICK TEST:
   curl -H "x-api-key: ${API_KEY}" \\
        -X POST \\
        -H "Content-Type: application/json" \\
        -d '{"keyword":"bitcoin","limit":3}' \\
        ${protocol}://${getPublicIp()}:${PORT}/scrape
   
🛡️  FIREWALL:
   Allow port ${PORT} in your VPS firewall
   Command: sudo ufw allow ${PORT}/tcp
            `);
        });
        
        // Handle errors
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} already in use!`);
                console.log('Kill process: sudo fuser -k ${PORT}/tcp');
                process.exit(1);
            }
            console.error('Server error:', error);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down VPS scraper...');
            await scraper.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🔚 Terminating VPS scraper...');
            await scraper.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ VPS startup failed:', error);
        process.exit(1);
    }
}

function getPublicIp() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return 'localhost';
    } catch {
        return 'localhost';
    }
}

// Start VPS server
startVpsServer();

module.exports = { VpsScraper };
