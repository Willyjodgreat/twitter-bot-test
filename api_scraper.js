// twitter_pro_scraper.js - ENHANCED VERSION WITH SSL & PROXIES
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

class TwitterProScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        
        // Config
        this.port = process.env.PORT || 3005;
        this.useSSL = process.env.SSL_ENABLED === 'true';
        this.sslKeyPath = process.env.SSL_KEY_PATH;
        this.sslCertPath = process.env.SSL_CERT_PATH;
        this.proxyServer = process.env.PROXY_SERVER; // http://user:pass@ip:port
        
        console.log(`🔧 Config: SSL=${this.useSSL}, Proxy=${this.proxyServer ? 'Yes' : 'No'}`);
    }
    
    async connect() {
        try {
            console.log('🚀 Starting enhanced scraper...');
            
            // Check cookies
            if (!fs.existsSync(this.sessionFile)) {
                console.log('⚠️  No session file. Will try public access.');
            }
            
            // Browser args with proxy if configured
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ];
            
            // Add proxy if configured
            if (this.proxyServer) {
                browserArgs.push(`--proxy-server=${this.proxyServer}`);
                console.log(`🌐 Using proxy: ${this.proxyServer.split('@')[1] || this.proxyServer}`);
            }
            
            // Launch browser
            this.browser = await chromium.launch({ 
                headless: true,
                args: browserArgs
            });
            
            // Browser context
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ignoreHTTPSErrors: false
            });
            
            // Load cookies if they exist
            if (fs.existsSync(this.sessionFile)) {
                try {
                    const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
                    // Fix cookie domains from x.com to twitter.com
                    session.cookies = session.cookies.map(cookie => ({
                        ...cookie,
                        domain: cookie.domain?.includes('x.com') ? '.twitter.com' : cookie.domain
                    }));
                    await this.context.addCookies(session.cookies);
                    console.log(`✅ Loaded ${session.cookies.length} cookies`);
                } catch (e) {
                    console.log('⚠️  Could not load cookies:', e.message);
                }
            }
            
            // Test connection
            await this.testConnection();
            
            this.isConnected = true;
            console.log('✅ Connected successfully!');
            return true;
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }
    
    async testConnection() {
        const page = await this.context.newPage();
        try {
            await page.goto('https://twitter.com/explore', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            await page.waitForTimeout(3000);
            
            // Check for tweets or login
            const hasContent = await page.evaluate(() => {
                return document.querySelectorAll('article').length > 0 ||
                       document.querySelector('a[href*="compose/tweet"]') !== null;
            });
            
            if (!hasContent) {
                console.log('⚠️  Limited access - may need fresh cookies');
            }
            
            await page.close();
            return hasContent;
            
        } catch (error) {
            await page.close();
            throw error;
        }
    }
    
    async scrapeTweets(keyword, limit = 10) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }
        
        console.log(`🔍 Searching: "${keyword}"`);
        
        const page = await this.context.newPage();
        
        try {
            // Try multiple search URLs
            const searchUrls = [
                `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`,
                `https://twitter.com/search?q=${encodeURIComponent(keyword)}&f=live`,
                `https://x.com/search?q=${encodeURIComponent(keyword)}`
            ];
            
            let success = false;
            
            for (const url of searchUrls) {
                try {
                    console.log(`🌐 Trying: ${url}`);
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    
                    await page.waitForTimeout(5000);
                    
                    // Check if page loaded
                    const hasResults = await page.evaluate(() => {
                        return document.querySelectorAll('article').length > 0 ||
                               document.querySelector('main') !== null;
                    });
                    
                    if (hasResults) {
                        success = true;
                        console.log('✅ Search loaded');
                        break;
                    }
                } catch (e) {
                    console.log(`   Failed: ${e.message}`);
                }
            }
            
            if (!success) {
                throw new Error('Could not load search results');
            }
            
            // Scroll and collect
            const allTweets = [];
            
            for (let i = 0; i < 3 && allTweets.length < limit; i++) {
                const newTweets = await page.evaluate((kw) => {
                    const articles = document.querySelectorAll('article');
                    const results = [];
                    
                    articles.forEach((article, idx) => {
                        try {
                            const text = article.textContent || '';
                            if (text.length < 30) return;
                            
                            const authorEl = article.querySelector('[data-testid="User-Name"]');
                            const author = authorEl ? authorEl.textContent.split('·')[0].trim() : 'Unknown';
                            
                            results.push({
                                id: `tweet_${Date.now()}_${idx}`,
                                text: text.substring(0, 250),
                                author: author.substring(0, 50),
                                keyword: kw,
                                length: text.length,
                                scrapedAt: new Date().toISOString()
                            });
                        } catch (e) {}
                    });
                    
                    return results;
                }, keyword);
                
                // Filter unique
                newTweets.forEach(tweet => {
                    if (!allTweets.some(t => t.text.substring(0, 50) === tweet.text.substring(0, 50))) {
                        allTweets.push(tweet);
                    }
                });
                
                console.log(`   Scroll ${i + 1}: ${newTweets.length} new, ${allTweets.length} total`);
                
                // Scroll for more
                if (allTweets.length < limit) {
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight * 2);
                    });
                    await page.waitForTimeout(3000);
                }
            }
            
            await page.close();
            
            const result = allTweets.slice(0, limit);
            console.log(`✅ Found ${result.length} tweets for "${keyword}"`);
            return result;
            
        } catch (error) {
            await page.close();
            console.error(`❌ Scrape failed: ${error.message}`);
            throw error;
        }
    }
    
    async cleanup() {
        try {
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
            this.isConnected = false;
            console.log('🧹 Cleanup complete');
        } catch (error) {
            // Ignore
        }
    }
}

// ==================== ENHANCED EXPRESS SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

// API key middleware
const apiKeyMiddleware = (req, res, next) => {
    if (req.path === '/' || req.path === '/health' || req.path.startsWith('/public/')) {
        return next();
    }
    
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const validKey = process.env.API_KEY || 'Willyjodgreat';
    
    if (!apiKey || apiKey !== validKey) {
        return res.status(401).json({
            success: false,
            error: 'Invalid API key',
            hint: `Use: x-api-key: ${validKey.substring(0, 3)}...`
        });
    }
    
    next();
};

app.use(apiKeyMiddleware);

// Create scraper instance
const scraper = new TwitterProScraper();

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Pro Scraper</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                       background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; 
                       min-height: 100vh; padding: 20px; }
                .container { max-width: 1200px; margin: 0 auto; }
                .header { text-align: center; margin-bottom: 30px; padding: 20px; }
                .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); 
                        border-radius: 15px; padding: 25px; margin-bottom: 20px; 
                        border: 1px solid rgba(255,255,255,0.2); }
                .status { display: inline-flex; align-items: center; padding: 8px 16px; 
                         border-radius: 20px; font-weight: 600; margin: 10px 0; }
                .connected { background: #10B981; }
                .disconnected { background: #EF4444; }
                input, select, button { padding: 12px 16px; border: none; border-radius: 8px; 
                                       font-size: 16px; margin: 5px; width: 100%; }
                button { background: #3B82F6; color: white; cursor: pointer; 
                         transition: background 0.3s; font-weight: 600; }
                button:hover { background: #2563EB; }
                .tweet { background: rgba(255,255,255,0.15); border-radius: 10px; 
                         padding: 15px; margin: 10px 0; border-left: 4px solid #1DA1F2; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
                @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🐦 Twitter Pro Scraper</h1>
                    <p>Advanced scraping with SSL, Proxies & GUI</p>
                    <div class="status ${scraper.isConnected ? 'connected' : 'disconnected'}">
                        ${scraper.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}
                        <span style="margin-left: 10px; font-size: 12px; opacity: 0.8;">
                            ${scraper.useSSL ? '🔒 SSL' : '🌐 HTTP'} 
                            ${scraper.proxyServer ? '• 🌐 Proxy' : ''}
                        </span>
                    </div>
                </div>
                
                <div class="grid">
                    <div class="card">
                        <h3>🔍 Scrape Tweets</h3>
                        <input type="text" id="keyword" placeholder="Enter keyword..." value="technology">
                        <select id="limit">
                            <option value="3">3 tweets</option>
                            <option value="5" selected>5 tweets</option>
                            <option value="10">10 tweets</option>
                        </select>
                        <button onclick="scrape()">Scrape Now</button>
                        <div id="result" style="margin-top: 15px;"></div>
                    </div>
                    
                    <div class="card">
                        <h3>📊 System Info</h3>
                        <p><strong>Port:</strong> ${scraper.port}</p>
                        <p><strong>SSL:</strong> ${scraper.useSSL ? 'Enabled 🔒' : 'Disabled'}</p>
                        <p><strong>Proxy:</strong> ${scraper.proxyServer ? 'Configured' : 'Not configured'}</p>
                        <p><strong>Mode:</strong> ${process.env.NODE_ENV || 'development'}</p>
                        <button onclick="location.href='/health'" style="background: #6B7280; margin-top: 10px;">
                            Health Check
                        </button>
                    </div>
                </div>
                
                <div id="tweetsContainer" class="card" style="display: none;">
                    <h3>📝 Results</h3>
                    <div id="tweetsList"></div>
                </div>
            </div>
            
            <script>
                async function scrape() {
                    const keyword = document.getElementById('keyword').value.trim();
                    const limit = document.getElementById('limit').value;
                    const resultDiv = document.getElementById('result');
                    
                    if (!keyword) {
                        resultDiv.innerHTML = '<p style="color: #FCA5A5;">Please enter a keyword</p>';
                        return;
                    }
                    
                    resultDiv.innerHTML = '<p>⏳ Scraping... This may take 10-20 seconds.</p>';
                    
                    try {
                        const response = await fetch('/scrape', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'x-api-key': '${process.env.API_KEY || 'Willyjodgreat'}'
                            },
                            body: JSON.stringify({ keyword, limit: parseInt(limit) })
                        });
                        
                        const data = await response.json();
                        
                        if (data.success) {
                            let html = '<div style="background: rgba(16, 185, 129, 0.2); padding: 15px; border-radius: 10px;">';
                            html += '<h4 style="color: #10B981;">✅ Success!</h4>';
                            html += '<p><strong>Keyword:</strong> ' + data.keyword + '</p>';
                            html += '<p><strong>Tweets Found:</strong> ' + data.count + '</p>';
                            
                            if (data.tweets.length > 0) {
                                document.getElementById('tweetsContainer').style.display = 'block';
                                const tweetsList = document.getElementById('tweetsList');
                                tweetsList.innerHTML = '';
                                
                                data.tweets.forEach(tweet => {
                                    const tweetDiv = document.createElement('div');
                                    tweetDiv.className = 'tweet';
                                    tweetDiv.innerHTML = \`
                                        <p>\${tweet.text.substring(0, 150)}\${tweet.text.length > 150 ? '...' : ''}</p>
                                        <small style="color: #D1D5DB;">👤 \${tweet.author} • 📏 \${tweet.length} chars</small>
                                    \`;
                                    tweetsList.appendChild(tweetDiv);
                                });
                            }
                            
                            html += '</div>';
                            resultDiv.innerHTML = html;
                        } else {
                            resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.2); padding: 15px; border-radius: 10px;">' +
                                '<h4 style="color: #EF4444;">❌ Error</h4><p>' + data.error + '</p></div>';
                        }
                    } catch (error) {
                        resultDiv.innerHTML = '<div style="background: rgba(239, 68, 68, 0.2); padding: 15px; border-radius: 10px;">' +
                            '<h4 style="color: #EF4444;">❌ Request Failed</h4><p>' + error.message + '</p></div>';
                    }
                }
                
                // Enter key to scrape
                document.getElementById('keyword').addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') scrape();
                });
            </script>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: scraper.isConnected ? 'healthy' : 'disconnected',
        timestamp: new Date().toISOString(),
        scraper: {
            connected: scraper.isConnected,
            ssl: scraper.useSSL,
            proxy: !!scraper.proxyServer,
            port: scraper.port
        },
        system: {
            node: process.version,
            platform: process.platform,
            memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        }
    });
});

app.post('/scrape', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { keyword, limit = 5 } = req.body;
        
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Valid keyword required' 
            });
        }
        
        const tweetLimit = Math.min(parseInt(limit) || 5, 20);
        const trimmedKeyword = keyword.trim().substring(0, 100);
        
        console.log(`📥 API Request: "${trimmedKeyword}" (limit: ${tweetLimit})`);
        
        const tweets = await scraper.scrapeTweets(trimmedKeyword, tweetLimit);
        
        res.json({
            success: true,
            keyword: trimmedKeyword,
            count: tweets.length,
            processingTime: Date.now() - startTime,
            tweets: tweets.map(t => ({
                id: t.id,
                text: t.text,
                author: t.author,
                length: t.length,
                keyword: t.keyword,
                scrapedAt: t.scrapedAt
            }))
        });
        
    } catch (error) {
        console.error('API Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ==================== START SERVER WITH SSL ====================
async function startServer() {
    try {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║       TWITTER PRO SCRAPER v3.0 - ENHANCED EDITION       ║
║         SSL • Proxies • GUI • Cookies • API             ║
╚══════════════════════════════════════════════════════════╝`);
        
        // Connect scraper
        await scraper.connect();
        
        let server;
        
        // SSL Configuration
        if (scraper.useSSL && scraper.sslKeyPath && scraper.sslCertPath && 
            fs.existsSync(scraper.sslKeyPath) && fs.existsSync(scraper.sslCertPath)) {
            
            const sslOptions = {
                key: fs.readFileSync(scraper.sslKeyPath),
                cert: fs.readFileSync(scraper.sslCertPath)
            };
            
            server = https.createServer(sslOptions, app);
            console.log('🔒 HTTPS server with SSL enabled');
            
        } else {
            server = http.createServer(app);
            console.log('🌐 HTTP server (SSL not configured)');
            
            if (process.env.NODE_ENV === 'production') {
                console.warn('⚠️  WARNING: Running production without SSL!');
            }
        }
        
        // Listen on ALL interfaces (0.0.0.0) - FIXED
        server.listen(scraper.port, '0.0.0.0', () => {
            const protocol = scraper.useSSL ? 'https' : 'http';
            const localUrl = `${protocol}://localhost:${scraper.port}`;
            
            console.log(`
✅ SERVER STARTED
   Port: ${scraper.port}
   Host: 0.0.0.0 (All interfaces)
   SSL: ${scraper.useSSL ? '✅ ENABLED' : '❌ DISABLED'}
   Proxy: ${scraper.proxyServer ? '✅ CONFIGURED' : '❌ NOT CONFIGURED'}
   
🌐 ACCESS URLs
   Local: ${localUrl}
   Network: ${protocol}://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_IP'):${scraper.port}
   
🔧 CONFIGURATION
   • Add SSL: SSL_ENABLED=true, SSL_KEY_PATH, SSL_CERT_PATH
   • Add Proxy: PROXY_SERVER=http://user:pass@ip:port
   • API Key: API_KEY=your_key (default: Willyjodgreat)
   
📋 TEST COMMAND
   curl -X POST ${localUrl}/scrape \\
        -H "Content-Type: application/json" \\
        -H "x-api-key: ${process.env.API_KEY || 'Willyjodgreat'}" \\
        -d '{"keyword":"bitcoin","limit":3}'
            `);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down gracefully...');
            await scraper.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🔚 Terminating...');
            await scraper.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Startup failed:', error);
        process.exit(1);
    }
}

startServer();
